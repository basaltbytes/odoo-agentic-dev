import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import type { WorktreeContext } from "../core/worktree-context.js";
import { resolveContext } from "./resolve-context.js";
import { runInteractivePassthrough } from "./shell.js";

export const buildPsqlArgs = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
  extraArgs: ReadonlyArray<string>,
): Array<string> => [
  "exec",
  recipe.odoo.databaseServiceName,
  "psql",
  "-U",
  "odoo",
  "-d",
  ctx.databaseName,
  ...extraArgs,
];

export const psqlCommand = Command.make(
  "psql",
  {
    args: Argument.string("args").pipe(
      Argument.variadic(),
      Argument.withDescription("extra psql arguments (pass them after --)"),
    ),
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    Effect.gen(function* () {
      const { ctx, recipe } = yield* resolveContext(flags.config);
      yield* runInteractivePassthrough(recipe, ctx, buildPsqlArgs(recipe, ctx, flags.args));
    }),
);
