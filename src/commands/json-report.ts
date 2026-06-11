import { Console, Effect } from "effect";
import type { ResetPath } from "../core/environment.js";
import type { WorktreeContext } from "../core/worktree-context.js";

/**
 * Semantic action names for the reset paths. The nightly real-Odoo workflow
 * asserts these exact strings, so they are part of the CLI's contract.
 */
export const resetPathActions = (path: ResetPath): ReadonlyArray<string> =>
  path === "restore"
    ? ["restore-from-template"]
    : path === "full"
      ? ["full-init"]
      : ["full-init", "snapshot-template"];

/** The single object a lifecycle command prints to stdout under `--json`. */
export type JsonReport = {
  readonly ok: boolean;
  readonly command: string;
  /** null when the command failed before the context resolved */
  readonly database: string | null;
  readonly composeProject: string | null;
  readonly odooUrl: string | null;
  readonly actions: ReadonlyArray<string>;
  readonly durationMs: number;
  /** child exit code, when the command ran one to completion (`test`) */
  readonly exitCode?: number;
};

/**
 * Per-invocation reporter threaded through a lifecycle command. In text mode
 * `say` prints and everything else is bookkeeping; in json mode `say` is
 * recorded into `actions` instead of printed so stdout stays parseable.
 */
export interface CommandReporter {
  readonly json: boolean;
  /** decorative line: printed in text mode, recorded as an action in json mode */
  readonly say: (line: string) => Effect.Effect<void>;
  /** semantic action marker: always recorded, never printed */
  readonly action: (name: string) => Effect.Effect<void>;
  /** identity fields for the final report, set as soon as the context resolves */
  readonly setContext: (ctx: WorktreeContext) => Effect.Effect<void>;
  /** child exit code; a non-zero code makes the final report not-ok */
  readonly setExitCode: (code: number) => Effect.Effect<void>;
}

/**
 * Wrap a lifecycle command body with the `--json` reporting contract: collect
 * actions while the body runs, then print ONE single-line JSON object to
 * stdout — on success and on typed failure alike (the error still propagates,
 * so it renders on stderr and drives the exit code). Streamed child output may
 * precede it; consumers parse the LAST stdout line (`tail -n 1`).
 */
export const withJsonReport = <A, E, R>(
  command: string,
  json: boolean,
  body: (report: CommandReporter) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    const actions: Array<string> = [];
    let ctx: WorktreeContext | null = null;
    let exitCode: number | undefined;

    const record = (entry: string): Effect.Effect<void> =>
      Effect.sync(() => {
        actions.push(entry);
      });
    const reporter: CommandReporter = {
      json,
      say: (line) => (json ? record(line) : Console.log(line)),
      action: record,
      setContext: (value) =>
        Effect.sync(() => {
          ctx = value;
        }),
      setExitCode: (code) =>
        Effect.sync(() => {
          exitCode = code;
        }),
    };

    const emit = (succeeded: boolean): Effect.Effect<void> => {
      if (!json) return Effect.void;
      const resolved: WorktreeContext | null = ctx;
      const report: JsonReport = {
        ok: succeeded && (exitCode ?? 0) === 0,
        command,
        database: resolved === null ? null : resolved.databaseName,
        composeProject: resolved === null ? null : resolved.composeProjectName,
        odooUrl:
          resolved === null ? null : `${resolved.odooBaseUrl}/web?db=${resolved.databaseName}`,
        actions,
        durationMs: Date.now() - startedAt,
        ...(exitCode === undefined ? {} : { exitCode }),
      };
      return Console.log(JSON.stringify(report));
    };

    return yield* body(reporter).pipe(
      Effect.tap(() => emit(true)),
      Effect.tapError(() => emit(false)),
    );
  });
