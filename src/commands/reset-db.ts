import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import type { WorktreeContext } from "../core/worktree-context.js";
import { assertSharedDatabaseAllowed } from "../core/safety.js";
import { computeTemplateKey, decideResetPath, templateDbName } from "../core/environment.js";
import type { ResetPath } from "../core/environment.js";
import { renderDockerfile } from "../core/dockerfile-model.js";
import { OdooLifecycle } from "../platform/odoo-lifecycle.js";
import type { OdooLifecycleApi } from "../platform/odoo-lifecycle.js";
import { StateStore } from "../platform/state-store.js";
import type { StateStoreApi } from "../platform/state-store.js";
import { resolveContext } from "./resolve-context.js";
import { recordEnvironment } from "./state-hooks.js";
import { resetPathActions, resetPathMode, withJsonReport } from "./json-report.js";
import type { RuntimeError, SharedDatabaseProtectionError } from "../errors/errors.js";
import { ConfigLoadError } from "../errors/errors.js";

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

const updatePathFingerprint = (
  hash: ReturnType<typeof createHash>,
  rootDir: string,
  sourcePath: string,
) => {
  const absolute = isAbsolute(sourcePath) ? sourcePath : resolvePath(rootDir, sourcePath);
  const visit = (path: string) => {
    const stat = lstatSync(path);
    const name = relative(rootDir, path) || ".";
    if (stat.isSymbolicLink()) {
      hash.update(`symlink:${name}:${readlinkSync(path)}\0`);
      return;
    }
    if (stat.isDirectory()) {
      hash.update(`dir:${name}\0`);
      for (const entry of readdirSync(path).sort()) visit(resolvePath(path, entry));
      return;
    }
    if (stat.isFile()) {
      hash.update(`file:${name}\0`);
      hash.update(readFileSync(path));
      hash.update("\0");
      return;
    }
    hash.update(`other:${name}:${stat.mode}:${stat.size}\0`);
  };
  visit(absolute);
};

export const computeTemplateKeyForContext = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
): Effect.Effect<string, ConfigLoadError> =>
  Effect.try({
    try: () => {
      const imageHash = createHash("sha256");
      let hasImageInputs = false;
      if (recipe.odoo.build !== null) {
        hasImageInputs = true;
        imageHash.update(renderDockerfile(recipe.odoo.version, recipe.odoo.build));
        for (const source of recipe.odoo.build.pipRequirements) {
          imageHash.update(`pipRequirements:${source}\0`);
          updatePathFingerprint(imageHash, ctx.rootDir, source);
        }
        for (const entry of recipe.odoo.build.copy) {
          imageHash.update(`copy:${entry.from}:${entry.to}\0`);
          updatePathFingerprint(imageHash, ctx.rootDir, entry.from);
        }
      }
      if (recipe.odoo.dockerfile !== null) {
        hasImageInputs = true;
        imageHash.update(`dockerfile:${recipe.odoo.dockerfile}\0`);
        updatePathFingerprint(imageHash, ctx.rootDir, recipe.odoo.dockerfile);
      }
      if (recipe.odoo.configFile !== null) {
        hasImageInputs = true;
        imageHash.update(`configFile:${recipe.odoo.configFile}\0`);
        updatePathFingerprint(imageHash, ctx.rootDir, recipe.odoo.configFile);
      }
      return computeTemplateKey(recipe, hasImageInputs ? imageHash.digest("hex") : null);
    },
    catch: (cause) =>
      new ConfigLoadError({
        path: ctx.rootDir,
        reason: `could not fingerprint image inputs for the template cache key: ${String(cause)}`,
      }),
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
    }
    return path;
  });

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
        const path = yield* runResetFlow(recipe, ctx, {
          noTemplate: flags.noTemplate,
          refreshTemplate: flags.refreshTemplate,
          build: flags.build,
          modules: parseModulesFlag(Option.getOrUndefined(flags.modules)),
          withoutDemo: Option.getOrUndefined(flags.withoutDemo),
          say: report.say,
        });
        yield* Effect.forEach(resetPathActions(path), report.action);
        yield* report.setExtra("mode", resetPathMode(path));
        yield* report.setExtra("templateKey", yield* computeTemplateKeyForContext(recipe, ctx));
        yield* report.say(`Done. Odoo URL: ${ctx.odooBaseUrl}/web?db=${ctx.databaseName}`);
      }),
    ),
).pipe(Command.withDescription("drop and re-initialize this worktree's database"));
