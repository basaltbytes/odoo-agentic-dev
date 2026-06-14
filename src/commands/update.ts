import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { UsageError } from "../errors/errors.js";
import { OdooLifecycle } from "../platform/odoo-lifecycle.js";
import { resolveContext } from "./resolve-context.js";
import {
  buildImageAndRecord,
  recordEnvironment,
  reportImageFreshness,
  warnIfImageStale,
} from "./state-hooks.js";
import { withJsonReport } from "./json-report.js";

export const updateCommand = Command.make(
  "update",
  {
    modules: Argument.string("modules"),
    noRestart: Flag.boolean("no-restart"),
    build: Flag.boolean("build").pipe(
      Flag.withDescription("rebuild the Odoo image before running the update container"),
    ),
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
            new UsageError({
              issues: ["update requires a non-empty comma-separated module list"],
            }),
          );
        }
        const { ctx, recipe } = yield* resolveContext(flags.config);
        yield* report.setContext(ctx);
        yield* recordEnvironment(recipe, ctx);
        if (!flags.build) {
          yield* reportImageFreshness(report, yield* warnIfImageStale(recipe, ctx, report.say));
        }
        const lifecycle = yield* OdooLifecycle;
        if (flags.build) {
          yield* buildImageAndRecord(recipe, ctx, report);
        }
        yield* report.say(`Updating modules [${list.join(", ")}] in ${ctx.databaseName}`);
        yield* lifecycle.updateModules(recipe, ctx, list, {
          restart: !flags.noRestart,
          build: false,
        });
        yield* report.action("update-modules");
      }),
    ),
).pipe(Command.withDescription("run odoo -u for the given modules"));
