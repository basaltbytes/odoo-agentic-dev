import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Context, Effect, Layer } from "effect";
import { ConfigLoadError, OdooCommandError, tail } from "../errors/errors.js";
import type { ComposeCommandError, RuntimeError } from "../errors/errors.js";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import type { WorktreeContext } from "../core/worktree-context.js";
import {
  containerAddonsPath,
  copyFilestoreArgs,
  createDatabaseSql,
  createFromTemplateSql,
  databaseExistsArgs,
  dropDatabaseSql,
  expandHook,
  odooInitArgs,
  odooShellArgs,
  odooTestArgs,
  odooUpdateArgs,
  psqlArgs,
  removeFilestoreArgs,
  terminateSessionsSql,
} from "../core/command-plan.js";
import { templateDbName } from "../core/environment.js";
import type { OdooTestOptions } from "../core/command-plan.js";
import { DockerCompose } from "./docker-compose.js";
import type { ComposeRef } from "./docker-compose.js";
import { CommandRunner, runInheritedOrFail } from "./command-runner.js";

export interface OdooLifecycleApi {
  readonly databaseExists: (
    recipe: OdooAgenticDevConfig,
    ctx: WorktreeContext,
  ) => Effect.Effect<boolean, RuntimeError>;
  readonly resetDatabase: (
    recipe: OdooAgenticDevConfig,
    ctx: WorktreeContext,
    options: {
      readonly modules?: ReadonlyArray<string> | undefined;
      readonly withoutDemo?: string | false | undefined;
      readonly build?: boolean | undefined;
    },
  ) => Effect.Effect<void, RuntimeError>;
  readonly runPostInitHooks: (
    recipe: OdooAgenticDevConfig,
    ctx: WorktreeContext,
  ) => Effect.Effect<void, RuntimeError>;
  readonly updateModules: (
    recipe: OdooAgenticDevConfig,
    ctx: WorktreeContext,
    modules: ReadonlyArray<string>,
    options: { readonly restart: boolean; readonly build?: boolean | undefined },
  ) => Effect.Effect<void, RuntimeError>;
  /**
   * Snapshot `<db>` into `<db>__tpl` (database + filestore). Docker-only:
   * recording the template in the state registry is the caller's concern.
   */
  readonly snapshotTemplate: (
    recipe: OdooAgenticDevConfig,
    ctx: WorktreeContext,
  ) => Effect.Effect<void, RuntimeError>;
  /** Recreate `<db>` from `<db>__tpl` (database + filestore). Hooks are baked in. */
  readonly restoreFromTemplate: (
    recipe: OdooAgenticDevConfig,
    ctx: WorktreeContext,
    options?: { readonly build?: boolean | undefined },
  ) => Effect.Effect<void, RuntimeError>;
  /** Runs the test suite; reporting the tails is the caller's concern. */
  readonly runTests: (
    recipe: OdooAgenticDevConfig,
    ctx: WorktreeContext,
    options: OdooTestOptions,
  ) => Effect.Effect<
    { readonly exitCode: number; readonly stdoutTail: string; readonly stderrTail: string },
    RuntimeError
  >;
}

const toOdooError = (e: ComposeCommandError): OdooCommandError =>
  new OdooCommandError({ args: e.args, exitCode: e.exitCode, stderrTail: e.stderrTail });

export const OdooLifecycle = Context.Service<OdooLifecycleApi>("odoo-agentic-dev/OdooLifecycle");

export const OdooLifecycleLive = Layer.effect(
  OdooLifecycle,
  Effect.gen(function* () {
    const compose = yield* DockerCompose;
    const runner = yield* CommandRunner;

    const ensureDbReady = (recipe: OdooAgenticDevConfig, ref: ComposeRef) =>
      compose
        .stream(ref, ["up", "-d", recipe.odoo.databaseServiceName])
        .pipe(Effect.andThen(compose.waitForDb(ref, recipe.odoo.databaseServiceName)));

    const buildOdooImage = (recipe: OdooAgenticDevConfig, ref: ComposeRef) =>
      compose.stream(ref, ["build", recipe.odoo.serviceName]);

    const maybeBuildOdooImage = (
      recipe: OdooAgenticDevConfig,
      ref: ComposeRef,
      build: boolean | undefined,
    ) => (build === true ? buildOdooImage(recipe, ref) : Effect.void);

    const odooServiceRunning = (recipe: OdooAgenticDevConfig, ref: ComposeRef) =>
      compose
        .tryRun(ref, ["ps", "--status", "running", "--services", recipe.odoo.serviceName])
        .pipe(
          Effect.map(
            (result) =>
              result.exitCode === 0 &&
              result.stdout
                .split(/\r?\n/)
                .map((line) => line.trim())
                .includes(recipe.odoo.serviceName),
          ),
        );

    const stopOdooForMutation = (recipe: OdooAgenticDevConfig, ref: ComposeRef) =>
      Effect.gen(function* () {
        const wasRunning = yield* odooServiceRunning(recipe, ref);
        if (wasRunning) yield* compose.stream(ref, ["stop", recipe.odoo.serviceName]);
        return wasRunning;
      });

    const restartOdooIfNeeded = (
      recipe: OdooAgenticDevConfig,
      ref: ComposeRef,
      shouldRestart: boolean,
    ) => (shouldRestart ? compose.stream(ref, ["up", "-d", recipe.odoo.serviceName]) : Effect.void);

    const runShellCode = (
      recipe: OdooAgenticDevConfig,
      ctx: WorktreeContext,
      ref: ComposeRef,
      code: string,
    ) =>
      compose.run(
        ref,
        odooShellArgs(recipe.odoo.serviceName, ctx.databaseName, containerAddonsPath(recipe)),
        code,
      );

    return {
      databaseExists: (recipe, ctx) =>
        Effect.gen(function* () {
          const ref = yield* compose.prepareComposeFile(recipe, ctx);
          yield* ensureDbReady(recipe, ref);
          const result = yield* compose.run(
            ref,
            databaseExistsArgs(recipe.odoo.databaseServiceName, ctx.databaseName),
          );
          return result.stdout.trim() === "1";
        }),

      resetDatabase: (recipe, ctx, options) =>
        Effect.gen(function* () {
          const ref = yield* compose.prepareComposeFile(recipe, ctx);
          yield* maybeBuildOdooImage(recipe, ref, options.build);
          yield* ensureDbReady(recipe, ref);
          const restartOdoo = yield* stopOdooForMutation(recipe, ref);
          const db = recipe.odoo.databaseServiceName;
          yield* compose.run(ref, psqlArgs(db, terminateSessionsSql(ctx.databaseName)));
          yield* compose.run(ref, psqlArgs(db, dropDatabaseSql(ctx.databaseName)));
          yield* compose.run(ref, psqlArgs(db, createDatabaseSql(ctx.databaseName)));
          yield* compose.run(ref, removeFilestoreArgs(recipe.odoo.serviceName, ctx.databaseName));
          const initArgs = odooInitArgs(
            recipe.odoo.serviceName,
            ctx.databaseName,
            containerAddonsPath(recipe),
            options.modules ?? recipe.database.initialModules,
            options.withoutDemo ?? recipe.database.withoutDemo,
          );
          yield* compose.stream(ref, initArgs).pipe(Effect.mapError(toOdooError));
          yield* restartOdooIfNeeded(recipe, ref, restartOdoo);
        }),

      runPostInitHooks: (recipe, ctx) =>
        Effect.gen(function* () {
          if (recipe.database.postInit.length === 0) return;
          const ref = yield* compose.prepareComposeFile(recipe, ctx);
          for (const hook of recipe.database.postInit) {
            const expanded = expandHook(hook, ctx.env);
            switch (expanded.kind) {
              case "odoo-shell": {
                yield* runShellCode(recipe, ctx, ref, expanded.code);
                break;
              }
              case "odoo-shell-file": {
                const path = isAbsolute(expanded.file)
                  ? expanded.file
                  : resolve(ctx.rootDir, expanded.file);
                const code = yield* Effect.try({
                  try: () => readFileSync(path, "utf8"),
                  catch: (cause) => new ConfigLoadError({ path, reason: String(cause) }),
                });
                yield* runShellCode(recipe, ctx, ref, code);
                break;
              }
              case "host-command": {
                const cwd =
                  expanded.cwd === undefined ? ctx.rootDir : resolve(ctx.rootDir, expanded.cwd);
                yield* runInheritedOrFail(runner, {
                  command: expanded.command,
                  args: expanded.args,
                  cwd,
                  env: ctx.env,
                  prefix: `[hook:${expanded.command}] `,
                });
                break;
              }
            }
          }
        }),

      snapshotTemplate: (recipe, ctx) =>
        Effect.gen(function* () {
          const ref = yield* compose.prepareComposeFile(recipe, ctx);
          yield* ensureDbReady(recipe, ref);
          const restartOdoo = yield* stopOdooForMutation(recipe, ref);
          const db = recipe.odoo.databaseServiceName;
          const tpl = templateDbName(ctx.databaseName);
          yield* compose.run(ref, psqlArgs(db, terminateSessionsSql(ctx.databaseName)));
          yield* compose.run(ref, psqlArgs(db, dropDatabaseSql(tpl)));
          yield* compose.run(ref, psqlArgs(db, createFromTemplateSql(tpl, ctx.databaseName)));
          yield* compose.run(
            ref,
            copyFilestoreArgs(recipe.odoo.serviceName, ctx.databaseName, tpl),
          );
          yield* restartOdooIfNeeded(recipe, ref, restartOdoo);
        }),

      restoreFromTemplate: (recipe, ctx, options) =>
        Effect.gen(function* () {
          const ref = yield* compose.prepareComposeFile(recipe, ctx);
          yield* maybeBuildOdooImage(recipe, ref, options?.build);
          yield* ensureDbReady(recipe, ref);
          const restartOdoo = yield* stopOdooForMutation(recipe, ref);
          const db = recipe.odoo.databaseServiceName;
          const tpl = templateDbName(ctx.databaseName);
          yield* compose.run(ref, psqlArgs(db, terminateSessionsSql(ctx.databaseName)));
          yield* compose.run(ref, psqlArgs(db, dropDatabaseSql(ctx.databaseName)));
          yield* compose.run(ref, psqlArgs(db, createFromTemplateSql(ctx.databaseName, tpl)));
          yield* compose.run(
            ref,
            copyFilestoreArgs(recipe.odoo.serviceName, tpl, ctx.databaseName),
          );
          yield* restartOdooIfNeeded(recipe, ref, restartOdoo);
        }),

      updateModules: (recipe, ctx, modules, options) =>
        Effect.gen(function* () {
          const ref = yield* compose.prepareComposeFile(recipe, ctx);
          yield* maybeBuildOdooImage(recipe, ref, options.build);
          yield* ensureDbReady(recipe, ref);
          yield* compose.stream(ref, ["stop", recipe.odoo.serviceName]);
          yield* compose
            .stream(
              ref,
              odooUpdateArgs(
                recipe.odoo.serviceName,
                ctx.databaseName,
                containerAddonsPath(recipe),
                modules,
              ),
            )
            .pipe(Effect.mapError(toOdooError));
          if (options.restart) {
            yield* compose.stream(ref, ["up", "-d", recipe.odoo.serviceName]);
          }
        }),

      runTests: (recipe, ctx, options) =>
        Effect.gen(function* () {
          const ref = yield* compose.prepareComposeFile(recipe, ctx);
          yield* maybeBuildOdooImage(recipe, ref, options.build);
          yield* ensureDbReady(recipe, ref);
          const result = yield* compose.tryRun(
            ref,
            odooTestArgs(
              recipe.odoo.serviceName,
              ctx.databaseName,
              containerAddonsPath(recipe),
              options,
            ),
          );
          return {
            exitCode: result.exitCode,
            stdoutTail: tail(result.stdout, 200),
            stderrTail: tail(result.stderr, 200),
          };
        }),
    };
  }),
);
