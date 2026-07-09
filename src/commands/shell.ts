import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { containerAddonsPath } from "../core/command-plan.js";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import type { WorktreeContext } from "../core/worktree-context.js";
import type { RuntimeError } from "../errors/errors.js";
import { CommandRunner } from "../platform/command-runner.js";
import type { CommandRunnerApi } from "../platform/command-runner.js";
import { composeArgs, DockerCompose } from "../platform/docker-compose.js";
import type { DockerComposeApi } from "../platform/docker-compose.js";
import type { StateStoreApi } from "../platform/state-store.js";
import { recordEnvironment } from "./state-hooks.js";
import { resolveContext } from "./resolve-context.js";

/**
 * `compose run` (not exec) so the session gets its own container and TTY.
 * `run` replaces the service `command:`, so `--addons-path` must be repeated
 * here or the shell falls back to the image's odoo.conf and skips every
 * mounted addon; `--no-http` keeps the injected ODOO_HTTP_PORT context env
 * from rebinding the shell container's HTTP server (Odoo 19+ reads ODOO_*
 * env vars as config).
 */
export const buildShellArgs = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
): Array<string> => [
  "run",
  "--rm",
  recipe.odoo.serviceName,
  "odoo",
  "shell",
  "-d",
  ctx.databaseName,
  `--addons-path=${containerAddonsPath(recipe)}`,
  "--no-http",
];

/**
 * Shared by `shell` and `psql`: record/touch the environment in the registry,
 * run the compose args with full stdio inheritance, and propagate a non-zero
 * child exit code to process.exitCode (the Effect itself still succeeds —
 * quitting a REPL non-zero is not a runtime error).
 */
export const runInteractivePassthrough = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
  args: ReadonlyArray<string>,
): Effect.Effect<number, RuntimeError, DockerComposeApi | CommandRunnerApi | StateStoreApi> =>
  Effect.gen(function* () {
    const compose = yield* DockerCompose;
    const runner = yield* CommandRunner;
    yield* compose.ensureAvailable();
    yield* recordEnvironment(recipe, ctx);
    const ref = yield* compose.prepareComposeFile(recipe, ctx);
    const exitCode = yield* runner.runInteractive({
      command: "docker",
      args: composeArgs(ref, args),
      cwd: ref.projectDir,
      env: ref.env,
    });
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
    return exitCode;
  });

export const shellCommand = Command.make(
  "shell",
  {
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    Effect.gen(function* () {
      const { ctx, recipe } = yield* resolveContext(flags.config);
      yield* runInteractivePassthrough(recipe, ctx, buildShellArgs(recipe, ctx));
    }),
).pipe(Command.withDescription("open an odoo shell bound to this worktree's database"));
