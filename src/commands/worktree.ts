import { appendFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import {
  ConfigValidationError,
  GitError,
  UsageError,
  isRuntimeError,
  renderError,
  tail,
} from "../errors/errors.js";
import type { RuntimeError } from "../errors/errors.js";
import { loadRecipe } from "../config/load-recipe.js";
import { buildWorktreeContext } from "../core/worktree-context.js";
import { isSharedDatabase } from "../core/safety.js";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import { CommandRunner } from "../platform/command-runner.js";
import type { CommandRunnerApi } from "../platform/command-runner.js";
import { Git } from "../platform/git.js";
import type { GitApi } from "../platform/git.js";
import { DockerCompose } from "../platform/docker-compose.js";
import type { DockerComposeApi } from "../platform/docker-compose.js";
import { StateStore } from "../platform/state-store.js";
import type { StateStoreApi } from "../platform/state-store.js";
import { withStateDbRoot } from "../platform/state-store.js";
import type { OdooLifecycleApi } from "../platform/odoo-lifecycle.js";
import { runSetup } from "./setup.js";
import { withStdoutRedirectedToStderr } from "./json-report.js";
import type { CommandReporter } from "./json-report.js";

// the stdout→stderr stream-swap now lives in json-report (shared with --json);
// re-exported here so existing importers keep working
export { withStdoutRedirectedToStderr } from "./json-report.js";

// --- hook payloads ----------------------------------------------------------

const parseHookJson = (
  text: string,
): Effect.Effect<Record<string, unknown>, ConfigValidationError> =>
  Effect.try({
    try: () => {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error("payload is not a JSON object");
      }
      return parsed as Record<string, unknown>;
    },
    catch: (cause) =>
      new ConfigValidationError({ issues: [`invalid hook JSON payload: ${String(cause)}`] }),
  });

const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

/** Claude Code WorktreeCreate hook payload: requires worktree_name + worktree_path. */
export const parseCreateHookPayload = (
  text: string,
): Effect.Effect<
  { readonly worktreeName: string; readonly worktreePath: string },
  ConfigValidationError
> =>
  parseHookJson(text).pipe(
    Effect.flatMap((record) => {
      const worktreeName = stringField(record, "worktree_name");
      const worktreePath = stringField(record, "worktree_path");
      return worktreeName === undefined || worktreePath === undefined
        ? Effect.fail(
            new ConfigValidationError({
              issues: ["hook payload must carry non-empty worktree_name and worktree_path strings"],
            }),
          )
        : Effect.succeed({ worktreeName, worktreePath });
    }),
  );

/** Claude Code WorktreeRemove hook payload: requires worktree_path. */
export const parseRemoveHookPayload = (
  text: string,
): Effect.Effect<{ readonly worktreePath: string }, ConfigValidationError> =>
  parseHookJson(text).pipe(
    Effect.flatMap((record) => {
      const worktreePath = stringField(record, "worktree_path");
      return worktreePath === undefined
        ? Effect.fail(
            new ConfigValidationError({
              issues: ["hook payload must carry a non-empty worktree_path string"],
            }),
          )
        : Effect.succeed({ worktreePath });
    }),
  );

// --- small pure pieces ------------------------------------------------------

/**
 * Base ref precedence: --base flag, then ODOO_WORKTREE_BASE_REF (empty =
 * unset, shell `[[ -n ]]` parity), then origin's HEAD symbolic ref with its
 * refs/remotes/ prefix stripped, then plain HEAD.
 */
export const resolveBaseRef = (options: {
  readonly flag: string | undefined;
  readonly env: Record<string, string | undefined>;
  readonly originHead: string | undefined;
}): string => {
  const envBase = options.env["ODOO_WORKTREE_BASE_REF"];
  const fromEnv = envBase === undefined || envBase === "" ? undefined : envBase;
  const fromOrigin = options.originHead?.replace(/^refs\/remotes\//, "");
  return options.flag ?? fromEnv ?? fromOrigin ?? "HEAD";
};

/** Default worktree location: the sibling `<repo-basename>-<name>` of the project root. */
export const defaultWorktreePath = (rootDir: string, name: string): string =>
  resolve(rootDir, "..", `${basename(rootDir)}-${name}`);

/** Split recipe worktree.copyFiles into the ones present in the project root and the rest. */
export const planCopyFiles = (
  copyFiles: ReadonlyArray<string>,
  rootDir: string,
  exists: (path: string) => boolean = existsSync,
): { readonly copy: Array<string>; readonly skip: Array<string> } => {
  const copy: Array<string> = [];
  const skip: Array<string> = [];
  for (const file of copyFiles) {
    (exists(join(rootDir, file)) ? copy : skip).push(file);
  }
  return { copy, skip };
};

/** Step logger: append to --log-file (directory created) when given, else the fallback sink. */
export const makeStepLogger = (
  logFile: string | undefined,
  fallback: (line: string) => Effect.Effect<void>,
): ((line: string) => Effect.Effect<void>) =>
  logFile === undefined
    ? fallback
    : (line) =>
        Effect.sync(() => {
          mkdirSync(dirname(logFile), { recursive: true });
          appendFileSync(logFile, `${line}\n`);
        });

/** Read stdin to the end (the hook payload arrives this way). */
const readStdinText: Effect.Effect<string, ConfigValidationError> = Effect.tryPromise({
  try: async () => {
    const chunks: Array<Buffer> = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
    }
    return Buffer.concat(chunks).toString("utf8");
  },
  catch: (cause) =>
    new ConfigValidationError({
      issues: [`could not read the hook payload from stdin: ${String(cause)}`],
    }),
});

// --- create -----------------------------------------------------------------

const queryOriginHead = (
  runner: CommandRunnerApi,
  rootDir: string,
): Effect.Effect<string | undefined> =>
  runner
    .run({
      command: "git",
      args: ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
      cwd: rootDir,
    })
    .pipe(
      Effect.map((result) => {
        const head = result.stdout.trim();
        return result.exitCode === 0 && head.length > 0 ? head : undefined;
      }),
      Effect.catch(() => Effect.succeed(undefined)),
    );

const ignoreOutcome = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
  effect.pipe(
    Effect.asVoid,
    Effect.catch(() => Effect.void),
  );

export type WorktreeCreateOptions = {
  /** the CURRENT project's recipe (worktree.copyFiles / branchPrefix) */
  readonly recipe: OdooAgenticDevConfig;
  /** the CURRENT project root (git commands run here; copyFiles source) */
  readonly rootDir: string;
  readonly name: string;
  /** final worktree directory */
  readonly path: string;
  readonly base: string | undefined;
  readonly env: Record<string, string | undefined>;
  /** hook mode also force-removes the half-made worktree when setup fails */
  readonly hookJson: boolean;
  readonly say: (line: string) => Effect.Effect<void>;
};

/**
 * The WorktreeCreate flow: best-effort fetch, base-ref resolution,
 * `git worktree add`, recipe copyFiles, then the FULL existing setup flow with
 * the worktree as the project root. Returns the worktree path.
 */
export const runWorktreeCreate = (
  options: WorktreeCreateOptions,
): Effect.Effect<
  string,
  RuntimeError,
  CommandRunnerApi | GitApi | DockerComposeApi | OdooLifecycleApi | StateStoreApi
> =>
  Effect.gen(function* () {
    const { env, name, path, recipe, rootDir, say } = options;
    const runner = yield* CommandRunner;

    yield* say("» git fetch origin (best effort)");
    yield* ignoreOutcome(runner.run({ command: "git", args: ["fetch", "origin"], cwd: rootDir }));

    const envBase = env["ODOO_WORKTREE_BASE_REF"];
    const hasPreset = options.base !== undefined || (envBase !== undefined && envBase !== "");
    const originHead = hasPreset ? undefined : yield* queryOriginHead(runner, rootDir);
    const base = resolveBaseRef({ flag: options.base, env, originHead });

    const branch = `${recipe.worktree.branchPrefix}${name}`;
    yield* say(`» git worktree add -b ${branch} ${path} ${base}`);
    const added = yield* runner
      .run({ command: "git", args: ["worktree", "add", "-b", branch, path, base], cwd: rootDir })
      .pipe(Effect.mapError((e) => new GitError({ reason: e.stderrTail || String(e) })));
    if (added.exitCode !== 0) {
      return yield* Effect.fail(
        new GitError({
          reason: `git worktree add exited ${added.exitCode}: ${tail(added.stderr || added.stdout)}`,
        }),
      );
    }

    const finishInsideWorktree = Effect.gen(function* () {
      const plan = planCopyFiles(recipe.worktree.copyFiles, rootDir);
      for (const file of plan.copy) {
        yield* Effect.try({
          try: () => {
            const dest = join(path, file);
            mkdirSync(dirname(dest), { recursive: true });
            cpSync(join(rootDir, file), dest, { recursive: true });
          },
          catch: (cause) =>
            new GitError({ reason: `copying ${file} into the worktree failed: ${String(cause)}` }),
        });
        yield* say(`copied ${file}`);
      }
      for (const file of plan.skip) {
        yield* say(`skipped ${file} (not present in ${rootDir})`);
      }

      // the full setup flow with the WORKTREE as the project root — reuse, do
      // not duplicate: same recipe discovery, context derivation, and steps
      // a manual `setup` inside the worktree would run
      const worktree = yield* loadRecipe({ cwd: path, env });
      const git = yield* Git;
      const gitState = yield* git.state(worktree.rootDir);
      const ctx = yield* buildWorktreeContext({
        rootDir: worktree.rootDir,
        recipe: worktree.recipe,
        env,
        git: gitState,
      });
      const reporter: CommandReporter = {
        json: false,
        say,
        action: () => Effect.void,
        setContext: () => Effect.void,
        setExitCode: () => Effect.void,
        setExtra: () => Effect.void,
      };
      yield* runSetup(
        worktree.recipe,
        ctx,
        {
          skipInstall: false,
          skipDb: false,
          allowShared: false,
          noTemplate: false,
          refreshTemplate: false,
        },
        reporter,
      );
      return path;
    });

    // hook contract: a failed setup aborts the creation, so the half-made
    // worktree is force-removed (best effort) before the error propagates
    return yield* options.hookJson
      ? finishInsideWorktree.pipe(
          Effect.tapError(() =>
            ignoreOutcome(
              runner.run({
                command: "git",
                args: ["worktree", "remove", "--force", path],
                cwd: rootDir,
              }),
            ),
          ),
        )
      : finishInsideWorktree;
  });

// --- remove -----------------------------------------------------------------

export type WorktreeRemoveOptions = {
  /** the worktree directory (may no longer exist) */
  readonly path: string;
  readonly allowShared: boolean;
  readonly env: Record<string, string | undefined>;
  /** where to discover the CURRENT project config for the dir-gone fallback */
  readonly cwd: string;
  readonly configFlag: string | undefined;
  readonly log: (line: string) => Effect.Effect<void>;
};

/**
 * The WorktreeRemove flow: resolve the worktree's own context when its
 * directory (and config) still exist and run `down --volumes` semantics;
 * when the directory is gone, rebuild the identity from the directory name
 * against the current project root and tear down by container label. A shared
 * database is never torn down without --allow-shared.
 */
export const runWorktreeRemove = (
  options: WorktreeRemoveOptions,
): Effect.Effect<void, RuntimeError, DockerComposeApi | StateStoreApi | GitApi> =>
  Effect.gen(function* () {
    const { allowShared, configFlag, cwd, env, log, path } = options;
    const compose = yield* DockerCompose;
    const store = yield* StateStore;

    const guardShared = (databaseName: string, sharedDatabase: string | null) =>
      isSharedDatabase(databaseName, sharedDatabase) && !allowShared;

    const removeRecordedRow = (reason: string) =>
      Effect.gen(function* () {
        const rows = yield* store.list({});
        const row = rows.find((candidate) => resolve(candidate.rootDir) === resolve(path));
        if (row === undefined) return false;
        if (row.shared && !allowShared) {
          yield* log(
            `skip: ${row.databaseName} is the shared database (pass --allow-shared to tear it down)`,
          );
          return true;
        }
        yield* log(`${reason}; tearing down ${row.composeProject} by container label`);
        yield* compose.ensureAvailable();
        yield* compose.removeByLabel(row.composeProject);
        yield* store.remove(row.composeProject);
        yield* log(`removed ${row.composeProject} from the registry`);
        return true;
      });

    if (existsSync(path)) {
      // a worktree dir without a discoverable config falls through to the
      // label-based path — same as a vanished dir, we only have the name
      const discovered = yield* loadRecipe({ cwd: path, env }).pipe(
        Effect.map(
          (
            value,
          ): { readonly rootDir: string; readonly recipe: OdooAgenticDevConfig } | undefined =>
            value,
        ),
        Effect.catch((error) =>
          error._tag === "ConfigLoadError" ? Effect.succeed(undefined) : Effect.fail(error),
        ),
      );
      if (discovered !== undefined) {
        const git = yield* Git;
        const gitState = yield* git.state(discovered.rootDir);
        const ctx = yield* buildWorktreeContext({
          rootDir: discovered.rootDir,
          recipe: discovered.recipe,
          env,
          git: gitState,
        });
        if (guardShared(ctx.databaseName, discovered.recipe.project.sharedDatabase)) {
          yield* log(
            `skip: ${ctx.databaseName} is the shared database (pass --allow-shared to tear it down)`,
          );
          return;
        }
        yield* log(`tearing down ${ctx.composeProjectName} (database ${ctx.databaseName})`);
        yield* compose.ensureAvailable();
        const ref = yield* compose.prepareComposeFile(discovered.recipe, ctx);
        yield* compose.run(ref, ["down", "--volumes"]);
        yield* withStateDbRoot(discovered.rootDir, store.remove(ctx.composeProjectName));
        yield* log(`removed ${ctx.composeProjectName} from the registry`);
        return;
      }
    }

    if (yield* removeRecordedRow("worktree identity found in the registry")) return;

    const current = yield* loadRecipe({ cwd, explicitPath: configFlag, env });
    const ctx = yield* buildWorktreeContext({
      rootDir: current.rootDir,
      recipe: current.recipe,
      env: { ...env, ODOO_WORKTREE_NAME: basename(path) },
      git: { _tag: "NotARepo" },
    });
    if (guardShared(ctx.databaseName, current.recipe.project.sharedDatabase)) {
      yield* log(
        `skip: ${ctx.databaseName} is the shared database (pass --allow-shared to tear it down)`,
      );
      return;
    }
    yield* log(`worktree dir gone; tearing down ${ctx.composeProjectName} by container label`);
    yield* compose.ensureAvailable();
    yield* compose.removeByLabel(ctx.composeProjectName);
    yield* withStateDbRoot(current.rootDir, store.remove(ctx.composeProjectName));
    yield* log(`removed ${ctx.composeProjectName} from the registry`);
  });

/**
 * Hook-mode wrapper around the remove flow: the WorktreeRemove hook CANNOT
 * block, so every failure (unparseable payload, docker down, anything) is
 * logged and swallowed — the Effect never fails, the process exits 0.
 */
export const runWorktreeRemoveHook = (options: {
  readonly stdinText: string;
  readonly allowShared: boolean;
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly configFlag: string | undefined;
  readonly log: (line: string) => Effect.Effect<void>;
}): Effect.Effect<void, never, DockerComposeApi | StateStoreApi | GitApi> =>
  parseRemoveHookPayload(options.stdinText).pipe(
    Effect.flatMap((payload) =>
      runWorktreeRemove({
        path: resolve(options.cwd, payload.worktreePath),
        allowShared: options.allowShared,
        env: options.env,
        cwd: options.cwd,
        configFlag: options.configFlag,
        log: options.log,
      }),
    ),
    Effect.catch((error) =>
      options.log(
        `worktree remove failed (ignored — the hook cannot block): ${
          isRuntimeError(error) ? renderError(error) : String(error)
        }`,
      ),
    ),
    Effect.catchDefect((defect) =>
      options.log(`worktree remove crashed (ignored — the hook cannot block): ${String(defect)}`),
    ),
  );

// --- commands ---------------------------------------------------------------

const createCommand = Command.make(
  "create",
  {
    name: Argument.string("name").pipe(
      Argument.optional,
      Argument.withDescription("worktree name (omit with --hook-json)"),
    ),
    path: Flag.string("path").pipe(
      Flag.optional,
      Flag.withDescription("worktree directory (default: sibling <repo-basename>-<name>)"),
    ),
    base: Flag.string("base").pipe(
      Flag.optional,
      Flag.withDescription("base ref (default: $ODOO_WORKTREE_BASE_REF, origin HEAD, or HEAD)"),
    ),
    hookJson: Flag.boolean("hook-json").pipe(
      Flag.withDescription(
        "Claude Code hook mode: read {worktree_name, worktree_path} JSON from stdin; stdout carries only the final path",
      ),
    ),
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    Effect.gen(function* () {
      const env = process.env;
      const { recipe, rootDir } = yield* loadRecipe({
        cwd: process.cwd(),
        explicitPath: Option.getOrUndefined(flags.config),
        env,
      });
      if (flags.hookJson) {
        const payload = yield* readStdinText.pipe(Effect.flatMap(parseCreateHookPayload));
        const finalPath = yield* withStdoutRedirectedToStderr(
          runWorktreeCreate({
            recipe,
            rootDir,
            name: payload.worktreeName,
            path: resolve(process.cwd(), payload.worktreePath),
            base: Option.getOrUndefined(flags.base),
            env,
            hookJson: true,
            say: Console.log,
          }),
        );
        // the hook contract: stdout is exactly one line — the final path
        yield* Effect.sync(() => {
          process.stdout.write(`${finalPath}\n`);
        });
        return;
      }
      const name = Option.getOrUndefined(flags.name);
      if (name === undefined) {
        return yield* Effect.fail(
          new UsageError({
            issues: ["worktree create requires a <name> argument (or --hook-json)"],
          }),
        );
      }
      const path = Option.match(flags.path, {
        onNone: () => defaultWorktreePath(rootDir, name),
        onSome: (p) => resolve(process.cwd(), p),
      });
      const finalPath = yield* runWorktreeCreate({
        recipe,
        rootDir,
        name,
        path,
        base: Option.getOrUndefined(flags.base),
        env,
        hookJson: false,
        say: Console.log,
      });
      yield* Console.log(`Worktree ready: ${finalPath}`);
    }),
).pipe(Command.withDescription("create a git worktree and run the full setup flow inside it"));

const removeCommand = Command.make(
  "remove",
  {
    path: Argument.string("path").pipe(
      Argument.optional,
      Argument.withDescription("worktree directory (omit with --hook-json)"),
    ),
    hookJson: Flag.boolean("hook-json").pipe(
      Flag.withDescription(
        "Claude Code hook mode: read {worktree_path} JSON from stdin and always exit 0",
      ),
    ),
    allowShared: Flag.boolean("allow-shared"),
    logFile: Flag.string("log-file").pipe(
      Flag.optional,
      Flag.withDescription("append step logs to this file (its directory is created)"),
    ),
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    Effect.gen(function* () {
      const env = process.env;
      if (flags.hookJson) {
        const log = makeStepLogger(Option.getOrUndefined(flags.logFile), Console.error);
        yield* readStdinText.pipe(
          Effect.flatMap((stdinText) =>
            runWorktreeRemoveHook({
              stdinText,
              allowShared: flags.allowShared,
              env,
              cwd: process.cwd(),
              configFlag: Option.getOrUndefined(flags.config),
              log,
            }),
          ),
          // even an unreadable stdin must not block the hook
          Effect.catch((error) =>
            log(`worktree remove failed (ignored — the hook cannot block): ${renderError(error)}`),
          ),
        );
        return;
      }
      const path = Option.getOrUndefined(flags.path);
      if (path === undefined) {
        return yield* Effect.fail(
          new UsageError({
            issues: ["worktree remove requires a <path> argument (or --hook-json)"],
          }),
        );
      }
      const log = makeStepLogger(Option.getOrUndefined(flags.logFile), Console.log);
      yield* runWorktreeRemove({
        path: resolve(process.cwd(), path),
        allowShared: flags.allowShared,
        env,
        cwd: process.cwd(),
        configFlag: Option.getOrUndefined(flags.config),
        log,
      });
    }),
).pipe(
  Command.withDescription(
    "tear down a worktree's environment (down --volumes, or by label when the dir is gone)",
  ),
);

export const worktreeCommand = Command.make("worktree").pipe(
  Command.withDescription("create and remove git worktrees with their managed environments"),
  Command.withSubcommands([createCommand, removeCommand]),
);
