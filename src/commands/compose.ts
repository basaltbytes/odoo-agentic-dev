import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import type { WorktreeContext } from "../core/worktree-context.js";
import { ConfigValidationError } from "../errors/errors.js";
import type { RuntimeError } from "../errors/errors.js";
import { trailingOperands } from "./trailing-args.js";
import type { CommandRunnerApi } from "../platform/command-runner.js";
import type { DockerComposeApi } from "../platform/docker-compose.js";
import type { StateStoreApi } from "../platform/state-store.js";
import { runInteractivePassthrough } from "./shell.js";
import { resolveContext } from "./resolve-context.js";

/**
 * `docker compose <trailing args>` against this worktree's stack: the
 * canonical preamble (-p/-f/--project-directory + context env) is prepended,
 * the trailing args land verbatim. Full stdio inheritance so `logs -f`
 * streams and interactive `exec` works; the child's exit code is propagated.
 */
export const runCompose = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
  args: ReadonlyArray<string>,
): Effect.Effect<number, RuntimeError, DockerComposeApi | CommandRunnerApi | StateStoreApi> =>
  runInteractivePassthrough(recipe, ctx, args);

export const composeCommand = Command.make(
  "compose",
  {
    args: Argument.string("args").pipe(
      Argument.variadic(),
      Argument.withDescription("docker compose arguments (pass them after --)"),
    ),
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    Effect.gen(function* () {
      const args = [...flags.args, ...trailingOperands()];
      if (args.length === 0) {
        return yield* Effect.fail(
          new ConfigValidationError({
            issues: [
              "compose requires docker compose arguments, e.g. `odoo-agentic-dev compose -- logs -f`",
            ],
          }),
        );
      }
      const { ctx, recipe } = yield* resolveContext(flags.config);
      yield* runCompose(recipe, ctx, args);
    }),
).pipe(
  Command.withDescription("docker compose passthrough scoped to this worktree's compose project"),
);
