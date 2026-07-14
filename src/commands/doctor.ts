import { readFileSync } from "node:fs";
import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { loadRecipe } from "../config/load-recipe.js";
import { classifyEnvironments, computeTemplateKey } from "../core/environment.js";
import { databaseExistsArgs } from "../core/command-plan.js";
import { computeTemplateInputHashForContext } from "../core/image-fingerprint.js";
import { computeImageKeyForContext } from "../core/image-fingerprint.js";
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
import {
  describeStateDbTarget,
  resolveStateDbPath,
  StateStore,
  withStateDbRoot,
} from "../platform/state-store.js";
import type { StateStoreApi } from "../platform/state-store.js";
import { buildProbes } from "./prune.js";

export type DoctorCheck = {
  readonly name: string;
  readonly ok: boolean;
  /** hard failures drive the exit code; soft ones are informational */
  readonly hard: boolean;
  readonly detail: string;
};

const NODE_VERSION_REQUIREMENT = "22.22.2+ on Node 22, or 24.15.0+";

const atLeast = (
  actual: readonly [number, number, number],
  expected: readonly [number, number, number],
): boolean => {
  for (let i = 0; i < expected.length; i++) {
    if (actual[i]! > expected[i]!) return true;
    if (actual[i]! < expected[i]!) return false;
  }
  return true;
};

/**
 * Runtime engine floor mirrors package.json and the npm runtime dependency
 * graph. node:sqlite arrives earlier, but npm installs warn below this range.
 */
export const nodeVersionOk = (version: string): boolean => {
  const [major = 0, minor = 0, patch = 0] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  const actual = [major, minor, patch] as const;
  if (major === 22) return atLeast(actual, [22, 22, 2]);
  if (major >= 24) return atLeast(actual, [24, 15, 0]);
  return false;
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

const CONSTRAINED_POOL_SUBNET = /^172\.(1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3}\/\d{1,2}$/;

/**
 * Docker's stock daemon carves local bridge networks out of two pools:
 * fifteen /16 blocks in 172.16.0.0/12 (docker0 included) and sixteen /20
 * blocks in 192.168.0.0/16. One compose project per worktree takes one /16,
 * so the first pool exhausts around 15 live environments with "could not find
 * an available, non-overlapping IPv4 address pool". This counts allocations
 * inside 172.16.0.0/12 only — hosts with a widened `default-address-pools`
 * allocate elsewhere and naturally stop matching.
 */
export const assessNetworkPools = (
  subnets: ReadonlyArray<string>,
): { readonly ok: boolean; readonly detail: string } => {
  const constrained = subnets.filter((subnet) =>
    CONSTRAINED_POOL_SUBNET.test(subnet.trim()),
  ).length;
  return constrained < 10
    ? { ok: true, detail: `${constrained} of ~15 default 172.16/12 pool slots allocated` }
    : {
        ok: false,
        detail:
          `${constrained} of ~15 default 172.16/12 pool slots allocated — nearing "no available, non-overlapping IPv4 address pool". ` +
          'Run `oad prune --yes` (and `oad down` idle stacks), or widen the pool in Docker daemon settings: "default-address-pools": [{"base":"10.201.0.0/16","size":24}]',
      };
};

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

const formatStateDbDetail = (rowCount: number, rootDir: string | null): string => {
  const target = describeStateDbTarget(
    resolveStateDbPath(process.env, { rootDir: rootDir ?? undefined }),
  );
  const sourceLabel =
    target.source === "env-override"
      ? "env override"
      : target.source === "shared-default"
        ? "shared default"
        : "worktree-local fallback";
  return `${target.path} (${rowCount} environment(s); parent ${
    target.parentExists ? "exists" : "missing"
  }, ${target.parentWritable ? "writable" : "not writable"}, ${sourceLabel})`;
};

/**
 * Run every doctor probe and fold each outcome — success or failure — into a
 * check row. This never fails: a broken docker/state/config is a finding, not
 * an error. The exit-code decision belongs to the command via hasHardFailure.
 */
export const collectDoctorChecks = (
  explicitConfigPath: string | undefined,
  options: { readonly deep?: boolean | undefined } = {},
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
      detail: `node ${process.versions.node} (need ${NODE_VERSION_REQUIREMENT})`,
    });

    if (dockerVersion.exitCode === 0) {
      const networkIds = yield* exec("docker", ["network", "ls", "-q"]);
      const ids = networkIds.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const inspected =
        networkIds.exitCode === 0 && ids.length > 0
          ? yield* exec("docker", [
              "network",
              "inspect",
              ...ids,
              "--format",
              "{{range .IPAM.Config}}{{.Subnet}} {{end}}",
            ])
          : { exitCode: 0, stdout: "", stderr: "" };
      const pools =
        networkIds.exitCode === 0 && inspected.exitCode === 0
          ? assessNetworkPools(inspected.stdout.split(/\s+/).filter((s) => s.length > 0))
          : { ok: true, detail: "skipped (network inspection failed)" };
      checks.push({ name: "network-pools", hard: false, ...pools });
    } else {
      checks.push({
        name: "network-pools",
        ok: true,
        hard: false,
        detail: "skipped (docker unavailable)",
      });
    }

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

    const rowsResult = yield* (
      config.ok ? withStateDbRoot(config.rootDir, store.list({})) : store.list({})
    ).pipe(
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
        ? formatStateDbDetail(rowsResult.rows.length, config.ok ? config.rootDir : null)
        : rowsResult.message,
    });

    if (config.ok && ctx !== null) {
      const currentCtx = ctx;
      const row = rows?.find((r) => r.composeProject === currentCtx.composeProjectName);
      const image = yield* computeImageKeyForContext(config.recipe, currentCtx).pipe(
        Effect.map((key) => ({ ok: true as const, key })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
      );
      checks.push({
        name: "image-inputs",
        ok: image.ok,
        hard: false,
        detail: image.ok
          ? image.key === null
            ? "stock/prebuilt image; no oad-managed build inputs"
            : `managed image key ${image.key.slice(0, 12)}`
          : image.message,
      });

      if (image.ok) {
        const fresh = image.key === null || row?.imageKey === image.key;
        checks.push({
          name: "image-fresh",
          ok: fresh,
          hard: false,
          detail:
            image.key === null
              ? "not applicable for stock/prebuilt images"
              : row === undefined
                ? "no state row for this worktree yet; run setup/up/restart --rebuild"
                : row.imageKey === null
                  ? "no successful image build recorded for this worktree"
                  : fresh
                    ? `last built ${row.imageBuiltAt ?? "(unknown time)"}`
                    : "image inputs changed since the last successful build",
        });
      }

      const template = yield* computeTemplateInputHashForContext(config.recipe, currentCtx).pipe(
        Effect.map((inputHash) => ({
          ok: true as const,
          key: computeTemplateKey(config.recipe, inputHash),
        })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
      );
      if (!template.ok) {
        checks.push({
          name: "template-snapshot",
          ok: false,
          hard: false,
          detail: template.message,
        });
      } else if (!config.recipe.database.template) {
        checks.push({
          name: "template-snapshot",
          ok: true,
          hard: false,
          detail: "disabled by database.template: false",
        });
      } else if (row === undefined) {
        checks.push({
          name: "template-snapshot",
          ok: false,
          hard: false,
          detail: `no state row for this worktree yet; expected key ${template.key}`,
        });
      } else if (row.templateDb === null || row.templateKey === null) {
        checks.push({
          name: "template-snapshot",
          ok: false,
          hard: false,
          detail: `no template recorded for this worktree; expected key ${template.key}`,
        });
      } else {
        const fresh = row.templateKey === template.key;
        checks.push({
          name: "template-snapshot",
          ok: fresh,
          hard: false,
          detail: fresh
            ? `recorded ${row.templateDb}, key ${row.templateKey}`
            : `stale recorded key ${row.templateKey}; expected ${template.key} for ${row.templateDb}`,
        });
      }

      if (
        options.deep === true &&
        config.recipe.database.template &&
        row?.templateDb !== undefined &&
        row.templateDb !== null
      ) {
        const templateDb = row.templateDb;
        const exists = yield* compose.prepareComposeFile(config.recipe, currentCtx).pipe(
          Effect.flatMap((ref) =>
            compose.stream(ref, ["up", "-d", config.recipe.odoo.databaseServiceName]).pipe(
              Effect.andThen(
                compose.waitForDb(ref, config.recipe.odoo.databaseServiceName, {
                  intervalMillis: 200,
                  maxAttempts: 15,
                  stableAttempts: 1,
                }),
              ),
              Effect.andThen(
                compose.tryRun(
                  ref,
                  databaseExistsArgs(config.recipe.odoo.databaseServiceName, templateDb),
                ),
              ),
            ),
          ),
          Effect.map((result) => ({
            ok: result.exitCode === 0 && result.stdout.trim() === "1",
            detail:
              result.exitCode === 0 && result.stdout.trim() === "1"
                ? `${templateDb} exists`
                : `${templateDb} not found`,
          })),
          Effect.catch((error) =>
            Effect.succeed({ ok: false, detail: tail(String(error)) || String(error) }),
          ),
        );
        checks.push({
          name: "template-db-exists",
          ok: exists.ok,
          hard: false,
          detail: exists.detail,
        });
      }

      if (options.deep === true && image.ok) {
        const browserDeps = yield* compose.prepareComposeFile(config.recipe, currentCtx).pipe(
          Effect.flatMap((ref) =>
            compose.tryRun(ref, [
              "run",
              "--rm",
              "--no-deps",
              config.recipe.odoo.serviceName,
              "python3",
              "-c",
              "import websocket",
            ]),
          ),
          Effect.map((result) => ({
            ok: result.exitCode === 0,
            detail:
              result.exitCode === 0
                ? "websocket-client import works in the Odoo image"
                : tail(result.stderr || result.stdout) || `python exited ${result.exitCode}`,
          })),
          Effect.catch((error) =>
            Effect.succeed({ ok: false, detail: tail(String(error)) || String(error) }),
          ),
        );
        checks.push({
          name: "browser-test-deps",
          ok: browserDeps.ok,
          hard: false,
          detail: browserDeps.detail,
        });
      }
    }

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
    deep: Flag.boolean("deep").pipe(
      Flag.withDescription("run slower container probes such as browser-test dependency checks"),
    ),
    json: Flag.boolean("json").pipe(Flag.withDescription("print machine-readable JSON")),
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    Effect.gen(function* () {
      const checks = yield* collectDoctorChecks(Option.getOrUndefined(flags.config), {
        deep: flags.deep,
      });
      yield* Console.log(
        flags.json ? JSON.stringify({ checks }, null, 2) : formatDoctorReport(checks),
      );
      if (hasHardFailure(checks)) {
        process.exitCode = 1;
      }
    }),
).pipe(Command.withDescription("environment health report; exits 1 on hard failures"));
