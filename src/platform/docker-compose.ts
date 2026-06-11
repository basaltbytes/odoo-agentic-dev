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
import { CommandRunner } from "./command-runner.js";
import type { ExecResult } from "./command-runner.js";

export type ComposeRef = {
  readonly projectName: string;
  readonly composeFile: string;
  readonly projectDir: string;
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

export interface DockerComposeApi {
  readonly ensureAvailable: () => Effect.Effect<void, DockerUnavailableError>;
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
    options?: { readonly intervalMillis?: number; readonly maxAttempts?: number },
  ) => Effect.Effect<void, ComposeCommandError>;
}

export const DockerCompose = Context.Service<DockerComposeApi>("odoo-agentic-dev/DockerCompose");

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
        .run({ command: "docker", args: argv, cwd: ref.projectDir, stdin })
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
          if (recipe.compose.file !== null) {
            const file = isAbsolute(recipe.compose.file)
              ? recipe.compose.file
              : resolve(ctx.rootDir, recipe.compose.file);
            return {
              projectName: ctx.composeProjectName,
              composeFile: file,
              projectDir: ctx.rootDir,
            };
          }
          const file = join(ctx.rootDir, GENERATED_COMPOSE_RELATIVE_PATH);
          yield* Effect.try({
            try: () => {
              mkdirSync(dirname(file), { recursive: true });
              writeFileSync(file, renderComposeYaml(buildComposeModel(recipe, ctx)));
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
          };
        }),

      run,
      tryRun,

      stream: (ref, args) => {
        const argv = composeArgs(ref, args);
        return runner.runInherited({ command: "docker", args: argv, cwd: ref.projectDir }).pipe(
          Effect.mapError(toComposeError(argv)),
          Effect.flatMap((code) =>
            code === 0
              ? Effect.void
              : Effect.fail(
                  new ComposeCommandError({ args: argv, exitCode: code, stderrTail: "" }),
                ),
          ),
        );
      },

      waitForDb: (ref, dbService, options) => {
        const interval = options?.intervalMillis ?? 1000;
        const maxAttempts = options?.maxAttempts ?? 60;
        const args = ["exec", "-T", dbService, "pg_isready", "-U", "odoo", "-d", "postgres"];
        const argv = composeArgs(ref, args);
        const attempt = (n: number): Effect.Effect<void, ComposeCommandError> =>
          exec(ref, argv).pipe(
            Effect.flatMap((result) =>
              result.exitCode === 0
                ? Effect.void
                : n >= maxAttempts
                  ? Effect.fail(
                      new ComposeCommandError({
                        args: argv,
                        exitCode: result.exitCode,
                        stderrTail: `database not ready after ${maxAttempts} attempts`,
                      }),
                    )
                  : Effect.sleep(Duration.millis(interval)).pipe(
                      Effect.flatMap(() => attempt(n + 1)),
                    ),
            ),
          );
        return attempt(1);
      },
    };
  }),
);
