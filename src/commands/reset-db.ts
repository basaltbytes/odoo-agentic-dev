import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import type { WorktreeContext } from "../core/worktree-context.js";
import { assertSharedDatabaseAllowed } from "../core/safety.js";
import { computeTemplateKey, decideResetPath, templateDbName } from "../core/environment.js";
import type { ResetPath } from "../core/environment.js";
import { OdooLifecycle } from "../platform/odoo-lifecycle.js";
import type { OdooLifecycleApi } from "../platform/odoo-lifecycle.js";
import { StateStore } from "../platform/state-store.js";
import type { StateStoreApi } from "../platform/state-store.js";
import { resolveContext } from "./resolve-context.js";
import { recordEnvironment } from "./state-hooks.js";
import type { RuntimeError, SharedDatabaseProtectionError } from "../errors/errors.js";

export const guardReset = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
  allowShared: boolean,
): Effect.Effect<void, SharedDatabaseProtectionError> =>
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

export type ResetFlowOptions = {
  readonly noTemplate: boolean;
  readonly refreshTemplate: boolean;
  readonly modules: ReadonlyArray<string> | undefined;
  readonly withoutDemo: string | undefined;
};

/**
 * The shared reset-db flow (used by `reset-db` and `setup`): decide between a
 * fast template restore and a full init, run it, and snapshot after the
 * post-init hooks when the decision calls for it. The pre-action line is
 * printed before any destructive work on every path.
 */
export const runResetFlow = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
  options: ResetFlowOptions,
): Effect.Effect<ResetPath, RuntimeError, OdooLifecycleApi | StateStoreApi> =>
  Effect.gen(function* () {
    const store = yield* StateStore;
    const lifecycle = yield* OdooLifecycle;
    const expectedKey = computeTemplateKey(recipe);
    const row = yield* store.get(ctx.composeProjectName);
    const path = decideResetPath({
      row,
      expectedKey,
      databaseName: ctx.databaseName,
      noTemplate: options.noTemplate,
      refreshTemplate: options.refreshTemplate,
      hasOverrides: options.modules !== undefined || options.withoutDemo !== undefined,
    });

    if (path === "restore") {
      yield* Console.log(
        `Restoring database: ${ctx.databaseName} (from template ${templateDbName(ctx.databaseName)})`,
      );
      yield* lifecycle.restoreFromTemplate(recipe, ctx);
      yield* Console.log("Restored from template (post-init hooks already baked in).");
      return path;
    }

    yield* Console.log(`Resetting database: ${ctx.databaseName}`);
    yield* Console.log(`Compose project:    ${ctx.composeProjectName}`);
    yield* lifecycle.resetDatabase(recipe, ctx, {
      modules: options.modules,
      withoutDemo: options.withoutDemo,
    });
    yield* lifecycle.runPostInitHooks(recipe, ctx);
    if (path === "full-then-snapshot") {
      yield* lifecycle.snapshotTemplate(recipe, ctx);
      yield* store.setTemplate(ctx.composeProjectName, {
        databaseName: templateDbName(ctx.databaseName),
        key: expectedKey,
      });
      yield* Console.log(`Template snapshot saved: ${templateDbName(ctx.databaseName)}`);
    }
    return path;
  });

export const resetDbCommand = Command.make(
  "reset-db",
  {
    allowShared: Flag.boolean("allow-shared"),
    modules: Flag.string("modules").pipe(
      Flag.optional,
      Flag.withDescription("comma-separated module list (defaults to recipe initialModules)"),
    ),
    withoutDemo: Flag.string("without-demo").pipe(Flag.optional),
    noTemplate: Flag.boolean("no-template").pipe(
      Flag.withDescription("full init even when a template snapshot exists (template kept)"),
    ),
    refreshTemplate: Flag.boolean("refresh-template").pipe(
      Flag.withDescription("full init and take a fresh template snapshot"),
    ),
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    Effect.gen(function* () {
      const { ctx, recipe } = yield* resolveContext(flags.config);
      yield* guardReset(recipe, ctx, flags.allowShared);
      yield* recordEnvironment(recipe, ctx);
      yield* runResetFlow(recipe, ctx, {
        noTemplate: flags.noTemplate,
        refreshTemplate: flags.refreshTemplate,
        modules: parseModulesFlag(Option.getOrUndefined(flags.modules)),
        withoutDemo: Option.getOrUndefined(flags.withoutDemo),
      });
      yield* Console.log(`Done. Odoo URL: ${ctx.odooBaseUrl}/web?db=${ctx.databaseName}`);
    }),
);
