import { Console, Effect } from "effect";
import type { ResetPath } from "../core/environment.js";
import type { WorktreeContext } from "../core/worktree-context.js";
import { isRuntimeError } from "../errors/errors.js";

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

/** Coarse mode classification of a reset path for the JSON report. */
export const resetPathMode = (path: ResetPath): "template-restore" | "full-init" =>
  path === "restore" ? "template-restore" : "full-init";

/** The typed-error summary emitted under `--json` when a command fails. */
export type JsonErrorReport = {
  /** the TaggedError `_tag` (e.g. "SharedDatabaseProtectionError") */
  readonly tag: string;
  readonly message: string;
};

/**
 * Per-command extra fields merged into the final report. Typed loosely on
 * purpose: every value is JSON-serialisable and the per-command set is small
 * (see each command's `setExtra` calls).
 */
export type JsonReportExtraValue = string | number | boolean | null | ReadonlyArray<string>;
export type JsonReportExtras = Record<string, JsonReportExtraValue>;

/** The fixed core of the object a lifecycle command prints under `--json`. */
export type JsonReport = {
  readonly ok: boolean;
  readonly command: string;
  /** null when the command failed before the context resolved */
  readonly database: string | null;
  /** plan name; `composeProject` is kept as a back-compat alias */
  readonly composeProjectName: string | null;
  /** legacy alias of `composeProjectName` (frozen e2e/nightly contract) */
  readonly composeProject: string | null;
  readonly odooHttpPort: number | null;
  readonly odooUrl: string | null;
  readonly odooExplicitDbUrl: string | null;
  readonly actions: ReadonlyArray<string>;
  readonly durationMs: number;
  /** child exit code, when the command ran one to completion (`test`) */
  readonly exitCode?: number;
  /** present only on failure */
  readonly error?: JsonErrorReport;
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
  /** attach a per-command field (mode, templateKey, volumesRemoved, tails…) */
  readonly setExtra: (key: string, value: JsonReportExtraValue) => Effect.Effect<void>;
}

/**
 * Hook-mode stdout purity (the `exec 1>&2` trick): everything written to
 * process.stdout while the effect runs — Console.log, streamed child output —
 * lands on stderr instead; the original writer is restored afterwards so the
 * caller can print the single contractual stdout line. Reused by `withJsonReport`
 * and by `worktree create --hook-json`.
 */
export const withStdoutRedirectedToStderr = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const original = process.stdout.write;
    process.stdout.write = ((...args: Parameters<typeof process.stderr.write>) =>
      process.stderr.write(...args)) as typeof process.stdout.write;
    return effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          process.stdout.write = original;
        }),
      ),
    );
  });

/** Best-effort tag/message extraction from an unknown failure value. */
const toErrorReport = (error: unknown): JsonErrorReport => {
  if (isRuntimeError(error)) {
    return { tag: error._tag, message: error.message };
  }
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = String((error as { _tag: unknown })._tag);
    const message =
      "message" in error && typeof (error as { message: unknown }).message === "string"
        ? (error as { message: string }).message
        : String(error);
    return { tag, message };
  }
  return { tag: "UnknownError", message: String(error) };
};

/**
 * Wrap a lifecycle command body with the `--json` reporting contract:
 *
 * - in json mode, redirect everything the body writes to stdout — Console.log,
 *   streamed compose/odoo subprocess output — onto stderr, so stdout carries
 *   EXACTLY ONE JSON object (the final line);
 * - collect actions/extras while the body runs, then print that single JSON
 *   line to the real stdout — on success and on typed failure alike (the error
 *   still propagates, so it renders on stderr and drives the exit code).
 */
export const withJsonReport = <A, E, R>(
  command: string,
  json: boolean,
  body: (report: CommandReporter) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    const actions: Array<string> = [];
    const extras: JsonReportExtras = {};
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
      setExtra: (key, value) =>
        Effect.sync(() => {
          extras[key] = value;
        }),
    };

    // the single contractual stdout line. In json mode the body ran with stdout
    // redirected to stderr, but `original` was captured and restored by then, so
    // this Console.log lands on the real stdout — alone.
    const emit = (succeeded: boolean, error: unknown): Effect.Effect<void> => {
      if (!json) return Effect.void;
      const resolved: WorktreeContext | null = ctx;
      const core: JsonReport = {
        ok: succeeded && (exitCode ?? 0) === 0,
        command,
        database: resolved === null ? null : resolved.databaseName,
        composeProjectName: resolved === null ? null : resolved.composeProjectName,
        composeProject: resolved === null ? null : resolved.composeProjectName,
        odooHttpPort: resolved === null ? null : resolved.odooHttpPort,
        odooUrl: resolved === null ? null : resolved.odooWebUrl,
        odooExplicitDbUrl:
          resolved === null ? null : `${resolved.odooWebUrl}?db=${resolved.databaseName}`,
        actions,
        durationMs: Date.now() - startedAt,
        ...(exitCode === undefined ? {} : { exitCode }),
        ...(succeeded ? {} : { error: toErrorReport(error) }),
      };
      // extras are merged AFTER the core so a command never clobbers a fixed key
      return Console.log(JSON.stringify({ ...core, ...extras }));
    };

    const run = json ? withStdoutRedirectedToStderr(body(reporter)) : body(reporter);
    return yield* run.pipe(
      Effect.tap(() => emit(true, undefined)),
      Effect.tapError((error) => emit(false, error)),
    );
  });
