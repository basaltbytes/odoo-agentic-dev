import { readFileSync } from "node:fs";
import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { loadRecipe } from "../config/load-recipe.js";
import { classifyEnvironments } from "../core/environment.js";
import { buildWorktreeContext } from "../core/worktree-context.js";
import type { WorktreeContext } from "../core/worktree-context.js";
import { tail } from "../errors/errors.js";
import { CommandRunner } from "../platform/command-runner.js";
import type { CommandRunnerApi, ExecResult } from "../platform/command-runner.js";
import { DockerCompose } from "../platform/docker-compose.js";
import type { DockerComposeApi } from "../platform/docker-compose.js";
import { Git } from "../platform/git.js";
import type { GitApi } from "../platform/git.js";
import { PortProbe } from "../platform/port-probe.js";
import type { PortProbeApi } from "../platform/port-probe.js";
import { resolveStateDbPath, StateStore } from "../platform/state-store.js";
import type { StateStoreApi } from "../platform/state-store.js";
import { buildProbes } from "./prune.js";

export type DoctorCheck = {
  readonly name: string;
  readonly ok: boolean;
  /** hard failures drive the exit code; soft ones are informational */
  readonly hard: boolean;
  readonly detail: string;
};

/** Engines floor: Node >= 22.15 (first unflagged node:sqlite). */
export const nodeVersionOk = (version: string): boolean => {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  return major > 22 || (major === 22 && minor >= 15);
};

/**
 * "Compose v2" means the Go `docker compose` plugin (the python v1
 * `docker-compose` is unsupported). Plugin releases moved past v2 numbering
 * (v5.x today), so accept any major >= 2 instead of grepping for "v2".
 */
export const composeVersionOk = (stdout: string): boolean => {
  const match = stdout.match(/version\s+v?(\d+)/i);
  return match !== null && Number.parseInt(match[1]!, 10) >= 2;
};

export const detectWsl = (procVersion: string | null): boolean =>
  procVersion !== null && procVersion.toLowerCase().includes("microsoft");

/** Total: /proc/version is absent on non-Linux hosts, which reads as null. */
const readProcVersion = (): string | null => {
  try {
    return readFileSync("/proc/version", "utf8");
  } catch {
    return null;
  }
};

const WSL_GUIDANCE =
  "WSL2 detected — keep repos inside the WSL filesystem (not /mnt/c), " +
  "install Node, pnpm, git, and the docker CLI inside WSL, enable Docker Desktop " +
  "WSL integration, and pass Linux paths";

export const hasHardFailure = (checks: ReadonlyArray<DoctorCheck>): boolean =>
  checks.some((check) => check.hard && !check.ok);

export const formatDoctorReport = (checks: ReadonlyArray<DoctorCheck>): string =>
  checks
    .map(
      (check) =>
        `${check.ok ? "✓" : "✗"} ${check.name} — ${check.detail}${
          check.ok ? "" : check.hard ? " (hard)" : " (soft)"
        }`,
    )
    .join("\n");

/**
 * Run every doctor probe and fold each outcome — success or failure — into a
 * check row. This never fails: a broken docker/state/config is a finding, not
 * an error. The exit-code decision belongs to the command via hasHardFailure.
 */
export const collectDoctorChecks = (
  explicitConfigPath: string | undefined,
): Effect.Effect<
  ReadonlyArray<DoctorCheck>,
  never,
  CommandRunnerApi | DockerComposeApi | StateStoreApi | PortProbeApi | GitApi
> =>
  Effect.gen(function* () {
    const runner = yield* CommandRunner;
    const compose = yield* DockerCompose;
    const store = yield* StateStore;
    const probe = yield* PortProbe;
    const git = yield* Git;
    const checks: Array<DoctorCheck> = [];

    const exec = (command: string, args: ReadonlyArray<string>): Effect.Effect<ExecResult> =>
      runner
        .run({ command, args })
        .pipe(
          Effect.catch((error) =>
            Effect.succeed({ exitCode: -1, stdout: "", stderr: error.message }),
          ),
        );

    const dockerVersion = yield* exec("docker", ["version", "--format", "json"]);
    checks.push({
      name: "docker-daemon",
      ok: dockerVersion.exitCode === 0,
      hard: true,
      detail:
        dockerVersion.exitCode === 0
          ? "docker daemon responsive"
          : tail(dockerVersion.stderr) || "docker CLI not found",
    });

    const composeVersion = yield* exec("docker", ["compose", "version"]);
    const composeOk = composeVersion.exitCode === 0 && composeVersionOk(composeVersion.stdout);
    checks.push({
      name: "compose-v2",
      ok: composeOk,
      hard: true,
      detail: composeOk
        ? (composeVersion.stdout.trim().split("\n")[0] ?? "")
        : "docker compose v2+ not found (python compose v1 is unsupported)",
    });

    checks.push({
      name: "node-version",
      ok: nodeVersionOk(process.versions.node),
      hard: true,
      detail: `node ${process.versions.node} (need >= 22.15)`,
    });

    const config = yield* loadRecipe({
      cwd: process.cwd(),
      explicitPath: explicitConfigPath,
      env: process.env,
    }).pipe(
      Effect.map((loaded) => ({ ok: true as const, ...loaded })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
    );
    checks.push({
      name: "config",
      ok: config.ok,
      hard: false,
      detail: config.ok
        ? `project "${config.recipe.project.id}" at ${config.rootDir}`
        : config.message,
    });

    let ctx: WorktreeContext | null = null;
    if (config.ok) {
      const derived = yield* git.state(config.rootDir).pipe(
        Effect.flatMap((gitState) =>
          buildWorktreeContext({
            rootDir: config.rootDir,
            recipe: config.recipe,
            env: process.env,
            git: gitState,
          }),
        ),
        Effect.map((value) => ({ ok: true as const, ctx: value })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
      );
      checks.push({
        name: "context",
        ok: derived.ok,
        hard: false,
        detail: derived.ok
          ? `database ${derived.ctx.databaseName}, compose project ${derived.ctx.composeProjectName}, port ${derived.ctx.odooHttpPort}`
          : derived.message,
      });
      if (derived.ok) ctx = derived.ctx;
    }

    const rowsResult = yield* store.list({}).pipe(
      Effect.map((rows) => ({ ok: true as const, rows })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
    );
    const rows = rowsResult.ok ? rowsResult.rows : null;

    if (ctx !== null) {
      const currentCtx = ctx;
      const free = yield* probe.isFree(currentCtx.odooHttpPort);
      const holder =
        rows?.find((row) => row.odooHttpPort === currentCtx.odooHttpPort)?.composeProject ?? null;
      checks.push({
        name: "port",
        // a busy port is fine as long as we can name the stack sitting on it
        ok: free || holder !== null,
        hard: true,
        detail: free
          ? `port ${currentCtx.odooHttpPort} is free`
          : holder !== null
            ? `port ${currentCtx.odooHttpPort} in use by known stack "${holder}"`
            : `port ${currentCtx.odooHttpPort} in use by an unknown process`,
      });
    }

    if (rows !== null) {
      const byPort = new Map<number, Array<string>>();
      for (const row of rows) {
        if (row.odooHttpPort === 0) continue; // adopted rows: port unknown
        byPort.set(row.odooHttpPort, [...(byPort.get(row.odooHttpPort) ?? []), row.composeProject]);
      }
      const collisions = [...byPort.entries()].filter(([, stacks]) => stacks.length > 1);
      checks.push({
        name: "port-collisions",
        ok: collisions.length === 0,
        hard: false,
        detail:
          collisions.length === 0
            ? "no port collisions among known stacks"
            : collisions.map(([port, stacks]) => `port ${port}: ${stacks.join(", ")}`).join("; "),
      });
    }

    checks.push({
      name: "state-db",
      ok: rowsResult.ok,
      hard: true,
      detail: rowsResult.ok
        ? `${resolveStateDbPath()} (${rowsResult.rows.length} environment(s))`
        : rowsResult.message,
    });

    const gitVersion = yield* exec("git", ["--version"]);
    checks.push({
      name: "git",
      ok: gitVersion.exitCode === 0,
      hard: true,
      detail: gitVersion.exitCode === 0 ? gitVersion.stdout.trim() : "git not found on PATH",
    });

    checks.push({
      name: "wsl",
      ok: true,
      hard: false,
      detail: detectWsl(readProcVersion()) ? WSL_GUIDANCE : "not running under WSL",
    });

    const scopedRows =
      rows === null
        ? null
        : config.ok
          ? rows.filter((r) => r.projectId === config.recipe.project.id)
          : rows;
    const pruneCheck = yield* scopedRows === null
      ? Effect.succeed({ ok: true, detail: "skipped (state registry unavailable)" })
      : compose.listProjects().pipe(
          Effect.flatMap((dockerProjects) =>
            buildProbes(scopedRows).pipe(
              Effect.map((probes) => {
                const candidates = classifyEnvironments({
                  rows: scopedRows,
                  dockerProjects,
                  probes,
                  olderThanDays: null,
                  allowShared: false,
                  now: new Date().toISOString(),
                }).filter((c) => c.reason !== "keep" && c.reason !== "shared-skipped");
                return candidates.length === 0
                  ? { ok: true, detail: "no prune candidates" }
                  : {
                      ok: false,
                      detail: `${candidates.length} prune candidate(s) — run \`odoo-agentic-dev prune\``,
                    };
              }),
            ),
          ),
          Effect.catch(() => Effect.succeed({ ok: true, detail: "skipped (docker unavailable)" })),
        );
    checks.push({ name: "prune-candidates", hard: false, ...pruneCheck });

    return checks;
  });

export const doctorCommand = Command.make(
  "doctor",
  {
    json: Flag.boolean("json").pipe(Flag.withDescription("print machine-readable JSON")),
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    Effect.gen(function* () {
      const checks = yield* collectDoctorChecks(Option.getOrUndefined(flags.config));
      yield* Console.log(
        flags.json ? JSON.stringify({ checks }, null, 2) : formatDoctorReport(checks),
      );
      if (hasHardFailure(checks)) {
        process.exitCode = 1;
      }
    }),
).pipe(Command.withDescription("environment health report; exits 1 on hard failures"));
