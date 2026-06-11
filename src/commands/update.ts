import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ConfigValidationError } from "../errors/errors.js";
import { OdooLifecycle } from "../platform/odoo-lifecycle.js";
import { resolveContext } from "./resolve-context.js";
import { recordEnvironment } from "./state-hooks.js";

export const updateCommand = Command.make(
  "update",
  {
    modules: Argument.string("modules"),
    noRestart: Flag.boolean("no-restart"),
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    Effect.gen(function* () {
      const list = flags.modules
        .split(",")
        .map((m) => m.trim())
        .filter((m) => m.length > 0);
      if (list.length === 0) {
        return yield* Effect.fail(
          new ConfigValidationError({
            issues: ["update requires a non-empty comma-separated module list"],
          }),
        );
      }
      const { ctx, recipe } = yield* resolveContext(flags.config);
      yield* recordEnvironment(recipe, ctx);
      const lifecycle = yield* OdooLifecycle;
      yield* Console.log(`Updating modules [${list.join(", ")}] in ${ctx.databaseName}`);
      yield* lifecycle.updateModules(recipe, ctx, list, { restart: !flags.noRestart });
    }),
);
