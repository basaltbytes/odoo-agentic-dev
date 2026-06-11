import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import type { WorktreeContext } from "../core/worktree-context.js";
import { assertSharedDatabaseAllowed } from "../core/safety.js";
import { OdooLifecycle } from "../platform/odoo-lifecycle.js";
import { resolveContext } from "./resolve-context.js";
import type { RuntimeError } from "../errors/errors.js";

export const guardReset = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
  allowShared: boolean,
): void =>
  assertSharedDatabaseAllowed({
    databaseName: ctx.databaseName,
    sharedDatabase: recipe.project.sharedDatabase,
    allowShared,
    action: "reset-db",
  });

export const parseModulesFlag = (value: string | undefined): Array<string> | undefined =>
  value
    ?.split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);

export const resetDbCommand = Command.make(
  "reset-db",
  {
    allowShared: Flag.boolean("allow-shared"),
    modules: Flag.string("modules").pipe(
      Flag.optional,
      Flag.withDescription("comma-separated module list (defaults to recipe initialModules)"),
    ),
    withoutDemo: Flag.string("without-demo").pipe(Flag.optional),
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    Effect.gen(function* () {
      const { ctx, recipe } = yield* resolveContext(flags.config);
      yield* Effect.try({
        try: () => guardReset(recipe, ctx, flags.allowShared),
        catch: (e) => e as RuntimeError,
      });
      yield* Console.log(`Resetting database: ${ctx.databaseName}`);
      yield* Console.log(`Compose project:    ${ctx.composeProjectName}`);
      const lifecycle = yield* OdooLifecycle;
      yield* lifecycle.resetDatabase(recipe, ctx, {
        modules: parseModulesFlag(Option.getOrUndefined(flags.modules)),
        withoutDemo: Option.getOrUndefined(flags.withoutDemo),
      });
      yield* lifecycle.runPostInitHooks(recipe, ctx);
      yield* Console.log(`Done. Odoo URL: ${ctx.odooBaseUrl}/web?db=${ctx.databaseName}`);
    }),
);
