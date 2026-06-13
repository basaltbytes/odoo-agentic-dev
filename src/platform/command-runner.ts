import { Context, Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { CommandFailedError, tail } from "../errors/errors.js";

export type ExecSpec = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  /** merged over the parent process env */
  readonly env?: Record<string, string> | undefined;
  readonly stdin?: string | undefined;
  /** line prefix for runInherited streaming, e.g. "[pwa] " */
  readonly prefix?: string | undefined;
};

export type ExecResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type InheritedResult = {
  readonly exitCode: number;
  readonly outputTail: string;
};

export interface CommandRunnerApi {
  /** Run to completion capturing output. Non-zero exits RESOLVE (callers decide). Spawn failures FAIL. */
  readonly run: (spec: ExecSpec) => Effect.Effect<ExecResult, CommandFailedError>;
  /** Run streaming output lines to this process's stdout (with optional prefix), keeping a bounded tail. */
  readonly runInherited: (spec: ExecSpec) => Effect.Effect<InheritedResult, CommandFailedError>;
  /** Full stdio inheritance (TTY passthrough) for interactive children. Resolves with exit code. */
  readonly runInteractive: (spec: ExecSpec) => Effect.Effect<number, CommandFailedError>;
}

export const CommandRunner = Context.Service<CommandRunnerApi>("odoo-agentic-dev/CommandRunner");

/** runInherited, but a non-zero exit becomes a typed CommandFailedError. */
export const runInheritedOrFail = (
  runner: CommandRunnerApi,
  spec: ExecSpec,
): Effect.Effect<void, CommandFailedError> =>
  runner.runInherited(spec).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.void
        : Effect.fail(
            new CommandFailedError({
              command: spec.command,
              args: spec.args,
              cwd: spec.cwd,
              exitCode: result.exitCode,
              stderrTail: result.outputTail,
            }),
          ),
    ),
  );

const collectText = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

export const CommandRunnerLive = Layer.effect(
  CommandRunner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const spawn = (spec: ExecSpec) =>
      ChildProcess.make(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        extendEnv: true,
        // the spawner pipes a stdin Stream into the child and closes stdin when done
        stdin:
          spec.stdin === undefined
            ? "ignore"
            : Stream.succeed(new TextEncoder().encode(spec.stdin)),
      });

    const toFailure = (spec: ExecSpec) => (cause: unknown) =>
      new CommandFailedError({
        command: spec.command,
        args: spec.args,
        cwd: spec.cwd,
        exitCode: -1,
        stderrTail: tail(String(cause)),
      });

    const run = (spec: ExecSpec) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawn(spec);
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [collectText(handle.stdout), collectText(handle.stderr), handle.exitCode],
            { concurrency: "unbounded" },
          );
          return { exitCode: Number(exitCode), stdout, stderr };
        }),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.catch((cause) => Effect.fail(toFailure(spec)(cause))),
      );

    const runInherited = (spec: ExecSpec) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawn(spec);
          const prefix = spec.prefix ?? "";
          const lines: Array<string> = [];
          const echo = handle.all.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) =>
              Effect.sync(() => {
                lines.push(line);
                if (lines.length > 20) lines.shift();
                process.stdout.write(`${prefix}${line}\n`);
              }),
            ),
          );
          const [, exitCode] = yield* Effect.all([echo, handle.exitCode], {
            concurrency: "unbounded",
          });
          return { exitCode: Number(exitCode), outputTail: lines.join("\n") };
        }),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.catch((cause) => Effect.fail(toFailure(spec)(cause))),
      );

    // verified v4 beta fact: ChildProcess CommandOptions accept "inherit" for
    // stdin/stdout/stderr, so interactive passthrough needs no spawn fallback
    const runInteractive = (spec: ExecSpec) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* ChildProcess.make(spec.command, [...spec.args], {
            cwd: spec.cwd,
            env: spec.env,
            extendEnv: true,
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
          });
          return Number(yield* handle.exitCode);
        }),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.catch((cause) => Effect.fail(toFailure(spec)(cause))),
      );

    return { run, runInherited, runInteractive };
  }),
);
