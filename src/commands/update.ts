import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ConfigValidationError } from "../errors/errors.js";
import { OdooLifecycle } from "../platform/odoo-lifecycle.js";
import { resolveContext } from "./resolve-context.js";
import { recordEnvironment } from "./state-hooks.js";
import { withJsonReport } from "./json-report.js";

export const updateCommand = Command.make(
  "update",
  {
    modules: Argument.string("modules"),
    noRestart: Flag.boolean("no-restart"),
    json: Flag.boolean("json").pipe(
      Flag.withDescription("suppress decorative output; print one final JSON report line"),
    ),
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    withJsonReport("update", flags.json, (report) =>
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
        yield* report.setContext(ctx);
        yield* recordEnvironment(recipe, ctx);
        const lifecycle = yield* OdooLifecycle;
        yield* report.say(`Updating modules [${list.join(", ")}] in ${ctx.databaseName}`);
        yield* lifecycle.updateModules(recipe, ctx, list, { restart: !flags.noRestart });
        yield* report.action("update-modules");
      }),
    ),
).pipe(Command.withDescription("run odoo -u for the given modules"));
