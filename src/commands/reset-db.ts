import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import type { WorktreeContext } from "../core/worktree-context.js";
import { assertSharedDatabaseAllowed, isSharedDatabase } from "../core/safety.js";
import { computeTemplateKey, decideResetPath, templateDbName } from "../core/environment.js";
import type { ResetPath } from "../core/environment.js";
import { computeTemplateInputHashForContext } from "../core/image-fingerprint.js";
import { OdooLifecycle } from "../platform/odoo-lifecycle.js";
import type { OdooLifecycleApi } from "../platform/odoo-lifecycle.js";
import { StateStore } from "../platform/state-store.js";
import type { StateStoreApi } from "../platform/state-store.js";
import { withStateDbRoot } from "../platform/state-store.js";
import { resolveContext } from "./resolve-context.js";
import {
  buildImageAndRecord,
  recordEnvironment,
  reportImageFreshness,
  warnIfImageStale,
} from "./state-hooks.js";
import { resetPathActions, resetPathMode, withJsonReport } from "./json-report.js";
import type { RuntimeError, SharedDatabaseProtectionError } from "../errors/errors.js";

export const guardReset = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
  allowShared: boolean,
  options?: { readonly databaseExists?: boolean | undefined },
): Effect.Effect<void, SharedDatabaseProtectionError> =>
  assertSharedDatabaseAllowed({
    databaseName: ctx.databaseName,
    sharedDatabase: recipe.project.sharedDatabase,
    allowShared,
    databaseExists: options?.databaseExists,
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
  readonly build: boolean;
  /** decorative-output sink; defaults to Console.log (json mode passes a recorder) */
  readonly say?: ((line: string) => Effect.Effect<void>) | undefined;
};

export const computeTemplateKeyForContext = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
): Effect.Effect<string, RuntimeError> =>
  Effect.gen(function* () {
    return computeTemplateKey(recipe, yield* computeTemplateInputHashForContext(recipe, ctx));
  });

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
  withStateDbRoot(
    ctx.rootDir,
    Effect.gen(function* () {
      const say = options.say ?? Console.log;
      const store = yield* StateStore;
      const lifecycle = yield* OdooLifecycle;
      const expectedKey = yield* computeTemplateKeyForContext(recipe, ctx);
      const row = yield* store.get(ctx.composeProjectName);
      const path = decideResetPath({
        row,
        expectedKey,
        databaseName: ctx.databaseName,
        noTemplate: options.noTemplate,
        refreshTemplate: options.refreshTemplate,
        hasOverrides: options.modules !== undefined || options.withoutDemo !== undefined,
        templateEnabled: recipe.database.template,
      });

      if (path === "restore") {
        yield* say(
          `Restoring database: ${ctx.databaseName} (from template ${templateDbName(ctx.databaseName)})`,
        );
        yield* lifecycle.restoreFromTemplate(recipe, ctx, { build: options.build });
        yield* say("Restored from template (post-init hooks already baked in).");
        return path;
      }

      yield* say(`Resetting database: ${ctx.databaseName}`);
      yield* say(`Compose project:    ${ctx.composeProjectName}`);
      yield* lifecycle.resetDatabase(recipe, ctx, {
        modules: options.modules,
        withoutDemo: options.withoutDemo,
        build: options.build,
      });
      yield* lifecycle.runPostInitHooks(recipe, ctx);
      if (path === "full-then-snapshot") {
        yield* lifecycle.snapshotTemplate(recipe, ctx);
        yield* store.setTemplate(ctx.composeProjectName, {
          databaseName: templateDbName(ctx.databaseName),
          key: expectedKey,
        });
        yield* say(`Template snapshot saved: ${templateDbName(ctx.databaseName)}`);
      } else if (!recipe.database.template) {
        yield* store.setTemplate(ctx.composeProjectName, null);
      }
      return path;
    }),
  );

/** Outcome of the pre-test template freshness guard (see `ensureFreshTemplateForTests`). */
export type TemplateGuardOutcome = "disabled" | "fresh" | "rebuilt" | "stale-shared";

/**
 * Make `oad test` run against a database that reflects the current code.
 *
 * `oad test` runs `--test-enable` against the live worktree database; it does
 * not restore or rebuild on its own, and it only warns about a stale Docker
 * *image*, never a stale database *template*. So after a change that is applied
 * at database init — seeded demo/data, security, views, i18n, manifests — the
 * template snapshot is stale and the suite silently replays the old seed (false
 * passes and failures). This reuses the same staleness decision as `reset-db`
 * (`decideResetPath` over the template input hash) and rebuilds the template
 * before the suite runs when it is stale or missing; when it is fresh it is a
 * no-op, so the common fast-iteration path keeps its speed.
 *
 * Note: the template hash deliberately excludes model `*.py`, so a change to a
 * field's storage/compute that touches no init-time file is not detected here —
 * run `oad reset-db` by hand for that case.
 *
 * The shared database is never rebuilt (that has no reset guard); a stale shared
 * template only warns, mirroring `oad reset-db`'s shared-database protection.
 */
export const ensureFreshTemplateForTests = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
  options?: { readonly say?: ((line: string) => Effect.Effect<void>) | undefined },
): Effect.Effect<TemplateGuardOutcome, RuntimeError, OdooLifecycleApi | StateStoreApi> =>
  withStateDbRoot(
    ctx.rootDir,
    Effect.gen(function* () {
      const say = options?.say ?? Console.log;
      if (!recipe.database.template) return "disabled";
      const store = yield* StateStore;
      const expectedKey = yield* computeTemplateKeyForContext(recipe, ctx);
      const row = yield* store.get(ctx.composeProjectName);
      const path = decideResetPath({
        row,
        expectedKey,
        databaseName: ctx.databaseName,
        noTemplate: false,
        refreshTemplate: false,
        hasOverrides: false,
        templateEnabled: recipe.database.template,
      });
      if (path === "restore") return "fresh";
      if (isSharedDatabase(ctx.databaseName, recipe.project.sharedDatabase)) {
        yield* say(
          "warning: the database template is stale but the database is shared; not rebuilding it. " +
            "Test results may not reflect your init-time changes (demo/data/security/views/i18n). " +
            "Run the suite on a worktree, or `oad reset-db --allow-shared` deliberately.",
        );
        return "stale-shared";
      }
      yield* say("Database template is stale or missing; rebuilding it before the test suite…");
      yield* runResetFlow(recipe, ctx, {
        noTemplate: false,
        refreshTemplate: false,
        build: false,
        modules: undefined,
        withoutDemo: undefined,
        say,
      });
      return "rebuilt";
    }),
  );

export const resetDbCommand = Command.make(
  "reset-db",
  {
    allowShared: Flag.boolean("allow-shared"),
    build: Flag.boolean("build").pipe(
      Flag.withDescription("rebuild the Odoo image before running reset containers"),
    ),
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
    json: Flag.boolean("json").pipe(
      Flag.withDescription("suppress decorative output; print one final JSON report line"),
    ),
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    withJsonReport("reset-db", flags.json, (report) =>
      Effect.gen(function* () {
        const { ctx, recipe } = yield* resolveContext(flags.config);
        yield* report.setContext(ctx);
        const lifecycle = yield* OdooLifecycle;
        const databaseExists =
          recipe.project.sharedDatabase === ctx.databaseName && !flags.allowShared
            ? yield* lifecycle.databaseExists(recipe, ctx)
            : undefined;
        yield* guardReset(recipe, ctx, flags.allowShared, { databaseExists });
        yield* recordEnvironment(recipe, ctx);
        if (!flags.build) {
          yield* reportImageFreshness(report, yield* warnIfImageStale(recipe, ctx, report.say));
        } else {
          yield* buildImageAndRecord(recipe, ctx, report);
        }
        const path = yield* runResetFlow(recipe, ctx, {
          noTemplate: flags.noTemplate,
          refreshTemplate: flags.refreshTemplate,
          build: false,
          modules: parseModulesFlag(Option.getOrUndefined(flags.modules)),
          withoutDemo: Option.getOrUndefined(flags.withoutDemo),
          say: report.say,
        });
        yield* Effect.forEach(resetPathActions(path), report.action);
        yield* report.setExtra("mode", resetPathMode(path));
        yield* report.setExtra("templateKey", yield* computeTemplateKeyForContext(recipe, ctx));
        yield* report.say(`Done. Odoo URL: ${ctx.odooWebUrl}`);
      }),
    ),
).pipe(Command.withDescription("drop and re-initialize this worktree's database"));
