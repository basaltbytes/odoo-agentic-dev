import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Context, Duration, Effect, Layer } from "effect";
import { ComposeCommandError, DockerUnavailableError, tail } from "../errors/errors.js";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import type { WorktreeContext } from "../core/worktree-context.js";
import {
  buildComposeModel,
  GENERATED_COMPOSE_RELATIVE_PATH,
  renderComposeYaml,
} from "../core/compose-model.js";
import { GENERATED_DOCKERFILE_RELATIVE_PATH, renderDockerfile } from "../core/dockerfile-model.js";
import { CommandRunner } from "./command-runner.js";
import type { ExecResult } from "./command-runner.js";

export type ComposeRef = {
  readonly projectName: string;
  readonly composeFile: string;
  readonly projectDir: string;
  /**
   * Context env handed to every compose subprocess (merged over the parent
   * env): project-supplied compose files interpolate `${ODOO_DATABASE:?}` /
   * `${ODOO_HTTP_PORT:?}` and would fail without it.
   */
  readonly env: Record<string, string>;
};

export const composeArgs = (ref: ComposeRef, rest: ReadonlyArray<string>): Array<string> => [
  "compose",
  "-p",
  ref.projectName,
  "-f",
  ref.composeFile,
  "--project-directory",
  ref.projectDir,
  ...rest,
];

export type ComposeProject = {
  readonly name: string;
  readonly running: boolean;
};

/** Identity labels read back from a container the generated compose stamped. */
export type LabeledContainer = {
  readonly composeProject: string;
  readonly projectId: string | null;
  readonly database: string | null;
  readonly rootDir: string | null;
  /** raw label value: "" means "no branch" (callers map it back to null) */
  readonly branch: string | null;
  readonly shared: boolean | null;
};

export interface DockerComposeApi {
  readonly ensureAvailable: () => Effect.Effect<void, DockerUnavailableError>;
  /** All compose projects on this docker host (`docker compose ls -a`). */
  readonly listProjects: () => Effect.Effect<ReadonlyArray<ComposeProject>, ComposeCommandError>;
  /** All containers stamped with our oad labels, deduped per compose project. */
  readonly listLabeledContainers: () => Effect.Effect<
    ReadonlyArray<LabeledContainer>,
    ComposeCommandError
  >;
  /**
   * Label-based teardown that works without the original compose file:
   * `docker rm -f` every container of the project, then remove its volumes.
   */
  readonly removeByLabel: (composeProject: string) => Effect.Effect<void, ComposeCommandError>;
  /** Write the generated compose file (or resolve the project-supplied one). */
  readonly prepareComposeFile: (
    recipe: OdooAgenticDevConfig,
    ctx: WorktreeContext,
  ) => Effect.Effect<ComposeRef, ComposeCommandError>;
  /** Captured run (optionally fed stdin); fails ComposeCommandError on non-zero exit. */
  readonly run: (
    ref: ComposeRef,
    args: ReadonlyArray<string>,
    stdin?: string,
  ) => Effect.Effect<ExecResult, ComposeCommandError>;
  /** Streamed to our stdout; fails ComposeCommandError on non-zero exit. */
  readonly stream: (
    ref: ComposeRef,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<void, ComposeCommandError>;
  /** Captured run returning the result even on non-zero exit (for polling). */
  readonly tryRun: (
    ref: ComposeRef,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<ExecResult, ComposeCommandError>;
  readonly waitForDb: (
    ref: ComposeRef,
    dbService: string,
    options?: {
      readonly intervalMillis?: number;
      readonly maxAttempts?: number;
      readonly stableAttempts?: number;
    },
  ) => Effect.Effect<void, ComposeCommandError>;
}

export const DockerCompose = Context.Service<DockerComposeApi>("odoo-agentic-dev/DockerCompose");

/**
 * Lenient parse of `docker compose ls -a --format json`: an array of
 * `{ Name, Status, ConfigFiles }` where Status reads like "running(2)" or
 * "exited(2)". Anything unrecognized is skipped rather than fatal.
 */
export const parseComposeLs = (stdout: string): Array<ComposeProject> => {
  const text = stdout.trim();
  if (text.length === 0) return [];
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) return [];
  const projects: Array<ComposeProject> = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record["Name"] !== "string" || record["Name"].length === 0) continue;
    projects.push({
      name: record["Name"],
      running: String(record["Status"] ?? "").startsWith("running"),
    });
  }
  return projects;
};

/**
 * Lenient parse of `docker ps --format json` output (NDJSON, one container per
 * line; a top-level array is tolerated). `Labels` is a comma-joined `k=v`
 * string, so label values containing commas are truncated — acceptable for the
 * best-effort adoption this feeds. Unparseable lines are skipped.
 */
export const parseLabeledPs = (stdout: string): Array<LabeledContainer> => {
  const containers = new Map<string, LabeledContainer>();
  for (const line of stdout.split(/\r?\n/)) {
    const text = line.trim();
    if (text.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (typeof item !== "object" || item === null) continue;
      const labelsRaw = (item as Record<string, unknown>)["Labels"];
      if (typeof labelsRaw !== "string") continue;
      const labels = new Map<string, string>();
      for (const part of labelsRaw.split(",")) {
        const eq = part.indexOf("=");
        if (eq > 0) labels.set(part.slice(0, eq), part.slice(eq + 1));
      }
      const composeProject = labels.get("com.docker.compose.project");
      if (composeProject === undefined || containers.has(composeProject)) continue;
      containers.set(composeProject, {
        composeProject,
        projectId: labels.get("dev.basaltbytes.oad.project-id") ?? null,
        database: labels.get("dev.basaltbytes.oad.database") ?? null,
        rootDir: labels.get("dev.basaltbytes.oad.root-dir") ?? null,
        branch: labels.get("dev.basaltbytes.oad.branch") ?? null,
        shared:
          labels.get("dev.basaltbytes.oad.shared") === undefined
            ? null
            : labels.get("dev.basaltbytes.oad.shared") === "true",
      });
    }
  }
  return [...containers.values()];
};

const splitLines = (stdout: string): Array<string> =>
  stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

export const DockerComposeLive = Layer.effect(
  DockerCompose,
  Effect.gen(function* () {
    const runner = yield* CommandRunner;

    const toComposeError =
      (args: ReadonlyArray<string>) => (cause: { readonly stderrTail?: string }) =>
        new ComposeCommandError({
          args,
          exitCode: -1,
          stderrTail: cause.stderrTail ?? String(cause),
        });

    /**
     * Single captured execution path: the caller hands over the fully expanded
     * argv exactly once, and that same argv is shared by the runner spec and
     * the error mapping (and, in `run`, by `failOnNonZero`). Never re-expand
     * `composeArgs` for the same invocation.
     */
    const exec = (ref: ComposeRef, argv: ReadonlyArray<string>, stdin?: string) =>
      runner
        .run({ command: "docker", args: argv, cwd: ref.projectDir, env: ref.env, stdin })
        .pipe(Effect.mapError(toComposeError(argv)));

    const tryRun = (ref: ComposeRef, args: ReadonlyArray<string>) =>
      exec(ref, composeArgs(ref, args));

    /** Spec rule: never dump huge logs inline — full output goes to .odoo-agentic-dev/logs/, the error keeps a tail + the path. */
    const writeFailureLog = (
      ref: ComposeRef,
      argv: ReadonlyArray<string>,
      result: ExecResult,
    ): string | undefined => {
      try {
        const dir = join(ref.projectDir, ".odoo-agentic-dev", "logs");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `compose-${Date.now()}.log`);
        writeFileSync(
          file,
          `$ docker ${argv.join(" ")}\nexit ${result.exitCode}\n\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`,
        );
        return file;
      } catch {
        return undefined;
      }
    };

    const failOnNonZero =
      (ref: ComposeRef, argv: ReadonlyArray<string>) => (result: ExecResult) => {
        if (result.exitCode === 0) return Effect.succeed(result);
        const logFile = writeFailureLog(ref, argv, result);
        return Effect.fail(
          new ComposeCommandError({
            args: argv,
            exitCode: result.exitCode,
            stderrTail:
              tail(result.stderr || result.stdout) +
              (logFile !== undefined ? `\nfull log: ${logFile}` : ""),
          }),
        );
      };

    const run = (ref: ComposeRef, args: ReadonlyArray<string>, stdin?: string) => {
      const argv = composeArgs(ref, args);
      return exec(ref, argv, stdin).pipe(Effect.flatMap(failOnNonZero(ref, argv)));
    };

    /** Top-level `docker <argv>` (no compose ref): captured, fails typed on non-zero. */
    const dockerRun = (
      argv: ReadonlyArray<string>,
    ): Effect.Effect<ExecResult, ComposeCommandError> =>
      runner.run({ command: "docker", args: argv }).pipe(
        Effect.mapError(toComposeError(argv)),
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result)
            : Effect.fail(
                new ComposeCommandError({
                  args: argv,
                  exitCode: result.exitCode,
                  stderrTail: tail(result.stderr || result.stdout),
                }),
              ),
        ),
      );

    const parseWith =
      <A>(
        argv: ReadonlyArray<string>,
        parse: (stdout: string) => A,
      ): ((result: ExecResult) => Effect.Effect<A, ComposeCommandError>) =>
      (result) =>
        Effect.try({
          try: () => parse(result.stdout),
          catch: (cause) =>
            new ComposeCommandError({
              args: argv,
              exitCode: 0,
              stderrTail: `unparseable docker output: ${String(cause)}`,
            }),
        });

    const listProjects = (): Effect.Effect<ReadonlyArray<ComposeProject>, ComposeCommandError> => {
      const argv = ["compose", "ls", "-a", "--format", "json"];
      return dockerRun(argv).pipe(Effect.flatMap(parseWith(argv, parseComposeLs)));
    };

    const listLabeledContainers = (): Effect.Effect<
      ReadonlyArray<LabeledContainer>,
      ComposeCommandError
    > => {
      const argv = ["ps", "-a", "--filter", "label=dev.basaltbytes.oad=1", "--format", "json"];
      return dockerRun(argv).pipe(Effect.flatMap(parseWith(argv, parseLabeledPs)));
    };

    const removeByLabel = (composeProject: string): Effect.Effect<void, ComposeCommandError> =>
      Effect.gen(function* () {
        const filters = [
          "--filter",
          `label=com.docker.compose.project=${composeProject}`,
          "--filter",
          "label=dev.basaltbytes.oad=1",
        ];
        const ids = splitLines((yield* dockerRun(["ps", "-aq", ...filters])).stdout);
        if (ids.length > 0) yield* dockerRun(["rm", "-f", ...ids]);
        const volumes = splitLines((yield* dockerRun(["volume", "ls", "-q", ...filters])).stdout);
        if (volumes.length > 0) yield* dockerRun(["volume", "rm", ...volumes]);
      });

    return {
      ensureAvailable: () =>
        runner.run({ command: "docker", args: ["version", "--format", "json"] }).pipe(
          Effect.mapError(
            (e) => new DockerUnavailableError({ reason: e.stderrTail || "docker CLI not found" }),
          ),
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : Effect.fail(
                  new DockerUnavailableError({
                    reason: tail(result.stderr) || `docker exited ${result.exitCode}`,
                  }),
                ),
          ),
        ),

      prepareComposeFile: (recipe, ctx) =>
        Effect.gen(function* () {
          const writeGeneratedDockerfile = () => {
            if (recipe.odoo.build !== null) {
              writeFileSync(
                join(ctx.rootDir, GENERATED_DOCKERFILE_RELATIVE_PATH),
                renderDockerfile(recipe.odoo.version, recipe.odoo.build),
              );
            }
          };
          if (recipe.compose.file !== null) {
            const file = isAbsolute(recipe.compose.file)
              ? recipe.compose.file
              : resolve(ctx.rootDir, recipe.compose.file);
            yield* Effect.try({
              try: () => {
                mkdirSync(join(ctx.rootDir, ".odoo-agentic-dev"), { recursive: true });
                writeGeneratedDockerfile();
              },
              catch: (cause) =>
                new ComposeCommandError({
                  args: ["<prepare>"],
                  exitCode: -1,
                  stderrTail: String(cause),
                }),
            });
            return {
              projectName: ctx.composeProjectName,
              composeFile: file,
              projectDir: ctx.rootDir,
              env: ctx.env,
            };
          }
          const file = join(ctx.rootDir, GENERATED_COMPOSE_RELATIVE_PATH);
          yield* Effect.try({
            try: () => {
              mkdirSync(dirname(file), { recursive: true });
              writeFileSync(file, renderComposeYaml(buildComposeModel(recipe, ctx)));
              writeGeneratedDockerfile();
            },
            catch: (cause) =>
              new ComposeCommandError({
                args: ["<prepare>"],
                exitCode: -1,
                stderrTail: String(cause),
              }),
          });
          return {
            projectName: ctx.composeProjectName,
            composeFile: file,
            projectDir: ctx.rootDir,
            env: ctx.env,
          };
        }),

      listProjects,
      listLabeledContainers,
      removeByLabel,
      run,
      tryRun,

      stream: (ref, args) => {
        const argv = composeArgs(ref, args);
        return runner
          .runInherited({ command: "docker", args: argv, cwd: ref.projectDir, env: ref.env })
          .pipe(
            Effect.mapError(toComposeError(argv)),
            Effect.flatMap((result) =>
              result.exitCode === 0
                ? Effect.void
                : Effect.fail(
                    new ComposeCommandError({
                      args: argv,
                      exitCode: result.exitCode,
                      stderrTail: result.outputTail,
                    }),
                  ),
            ),
          );
      },

      waitForDb: (ref, dbService, options) => {
        const interval = options?.intervalMillis ?? 1000;
        const stableAttempts = Math.max(1, options?.stableAttempts ?? 2);
        const maxAttempts = Math.max(stableAttempts, options?.maxAttempts ?? 60);
        const probe =
          "pg_isready -U odoo -d postgres >/dev/null && psql -U odoo -d postgres -tAc 'SELECT 1' >/dev/null";
        const args = ["exec", "-T", dbService, "sh", "-c", probe];
        const argv = composeArgs(ref, args);
        const attempt = (n: number, stable: number): Effect.Effect<void, ComposeCommandError> =>
          exec(ref, argv).pipe(
            Effect.flatMap((result) => {
              const nextStable = result.exitCode === 0 ? stable + 1 : 0;
              if (nextStable >= stableAttempts) return Effect.void;
              if (n >= maxAttempts) {
                const lastOutput = tail(result.stderr || result.stdout);
                return Effect.fail(
                  new ComposeCommandError({
                    args: argv,
                    exitCode: result.exitCode === 0 ? -1 : result.exitCode,
                    stderrTail:
                      lastOutput.length > 0
                        ? `database not ready after ${maxAttempts} attempts; last probe: ${lastOutput}`
                        : `database not ready after ${maxAttempts} attempts`,
                  }),
                );
              }
              return Effect.sleep(Duration.millis(interval)).pipe(
                Effect.flatMap(() => attempt(n + 1, nextStable)),
              );
            }),
          );
        return attempt(1, 0);
      },
    };
  }),
);
