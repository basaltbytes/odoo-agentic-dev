import { Context, Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { CommandFailedError, tail } from "../errors/errors.js";

export type ExecSpec = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  /** merged over the parent process env */
  readonly env?: Record<string, string>;
  readonly stdin?: string;
  /** line prefix for runInherited streaming, e.g. "[pwa] " */
  readonly prefix?: string;
};

export type ExecResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export interface CommandRunnerApi {
  /** Run to completion capturing output. Non-zero exits RESOLVE (callers decide). Spawn failures FAIL. */
  readonly run: (spec: ExecSpec) => Effect.Effect<ExecResult, CommandFailedError>;
  /** Run streaming output lines to this process's stdout (with optional prefix). Resolves with exit code. */
  readonly runInherited: (spec: ExecSpec) => Effect.Effect<number, CommandFailedError>;
}

export const CommandRunner = Context.Service<CommandRunnerApi>("odoo-agentic-dev/CommandRunner");

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
          const echo = handle.all.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) =>
              Effect.sync(() => {
                process.stdout.write(`${prefix}${line}\n`);
              }),
            ),
          );
          const [, exitCode] = yield* Effect.all([echo, handle.exitCode], {
            concurrency: "unbounded",
          });
          return Number(exitCode);
        }),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.catch((cause) => Effect.fail(toFailure(spec)(cause))),
      );

    return { run, runInherited };
  }),
);
