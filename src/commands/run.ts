import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ConfigLoadError } from "../errors/errors.js";
import type { RuntimeError } from "../errors/errors.js";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import type { WorktreeContext } from "../core/worktree-context.js";
import { CommandRunner } from "../platform/command-runner.js";
import type { CommandRunnerApi } from "../platform/command-runner.js";
import type { StateStoreApi } from "../platform/state-store.js";
import { recordEnvironment } from "./state-hooks.js";
import { resolveContext } from "./resolve-context.js";

/**
 * Minimal dotenv subset (predictability over features): `KEY=value` lines,
 * blank and `#` lines skipped, keys/values trimmed, one layer of surrounding
 * single or double quotes stripped — no escapes, no expansion, no `export`.
 */
export const parseEnvFile = (content: string): Record<string, string> => {
  const vars: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key.length === 0) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
};

/** Read + parse each file in order (later files win). A missing file is a ConfigLoadError. */
export const loadEnvFiles = (
  paths: ReadonlyArray<string>,
): Effect.Effect<Record<string, string>, ConfigLoadError> =>
  Effect.gen(function* () {
    const merged: Record<string, string> = {};
    for (const path of paths) {
      const content = yield* Effect.try({
        try: () => readFileSync(path, "utf8"),
        catch: (cause) => new ConfigLoadError({ path, reason: String(cause) }),
      });
      Object.assign(merged, parseEnvFile(content));
    }
    return merged;
  });

/**
 * Execute a host command with the worktree env injected. Layering order
 * (later wins): parent process env < ctx.env < --env-file files — env files
 * are documented as explicit overrides. The parent layer comes from the
 * runner's extendEnv merge; the spec env carries the other two.
 */
export const runHostCommand = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
  options: {
    readonly envFiles: ReadonlyArray<string>;
    readonly argv: ReadonlyArray<string>;
  },
): Effect.Effect<number, RuntimeError, CommandRunnerApi | StateStoreApi> =>
  Effect.gen(function* () {
    const runner = yield* CommandRunner;
    const fileVars = yield* loadEnvFiles(options.envFiles);
    yield* recordEnvironment(recipe, ctx);
    const [command, ...args] = options.argv;
    const exitCode = yield* runner.runInteractive({
      command: command!,
      args,
      env: { ...ctx.env, ...fileVars },
    });
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
    return exitCode;
  });

export const runCommand = Command.make(
  "run",
  {
    argv: Argument.string("command").pipe(
      Argument.variadic({ min: 1 }),
      Argument.withDescription("host command and its arguments (pass them after --)"),
    ),
    envFile: Flag.string("env-file").pipe(
      Flag.atLeast(0),
      Flag.withDescription(
        "dotenv-style file layered over the worktree env (repeatable; later files win)",
      ),
    ),
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    Effect.gen(function* () {
      const { ctx, recipe } = yield* resolveContext(flags.config);
      yield* runHostCommand(recipe, ctx, { envFiles: flags.envFile, argv: flags.argv });
    }),
).pipe(Command.withDescription("execute a host command with the worktree env injected"));
