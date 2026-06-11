import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Context, Effect, Layer } from "effect";
import { CommandFailedError, ConfigLoadError, OdooCommandError, tail } from "../errors/errors.js";
import type { RuntimeError } from "../errors/errors.js";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import type { WorktreeContext } from "../core/worktree-context.js";
import {
  createDatabaseSql,
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
import type { OdooTestOptions } from "../core/command-plan.js";
import { DockerCompose } from "./docker-compose.js";
import type { ComposeRef } from "./docker-compose.js";
import { CommandRunner } from "./command-runner.js";

export interface OdooLifecycleApi {
  readonly resetDatabase: (
    recipe: OdooAgenticDevConfig,
    ctx: WorktreeContext,
    options: {
      readonly modules?: ReadonlyArray<string> | undefined;
      readonly withoutDemo?: string | false | undefined;
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
    options: { readonly restart: boolean },
  ) => Effect.Effect<void, RuntimeError>;
  readonly runTests: (
    recipe: OdooAgenticDevConfig,
    ctx: WorktreeContext,
    options: OdooTestOptions,
  ) => Effect.Effect<number, RuntimeError>;
}

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

    const runShellCode = (
      recipe: OdooAgenticDevConfig,
      ctx: WorktreeContext,
      ref: ComposeRef,
      code: string,
    ) => compose.run(ref, odooShellArgs(recipe.odoo.serviceName, ctx.databaseName), code);

    return {
      resetDatabase: (recipe, ctx, options) =>
        Effect.gen(function* () {
          const ref = yield* compose.prepareComposeFile(recipe, ctx);
          yield* ensureDbReady(recipe, ref);
          const db = recipe.odoo.databaseServiceName;
          yield* compose.run(ref, psqlArgs(db, terminateSessionsSql(ctx.databaseName)));
          yield* compose.run(ref, psqlArgs(db, dropDatabaseSql(ctx.databaseName)));
          yield* compose.run(ref, psqlArgs(db, createDatabaseSql(ctx.databaseName)));
          yield* compose.run(ref, removeFilestoreArgs(recipe.odoo.serviceName, ctx.databaseName));
          const initArgs = odooInitArgs(
            recipe.odoo.serviceName,
            ctx.databaseName,
            options.modules ?? recipe.database.initialModules,
            options.withoutDemo ?? recipe.database.withoutDemo,
          );
          yield* compose.stream(ref, initArgs).pipe(
            Effect.mapError(
              (e) =>
                new OdooCommandError({
                  args: e.args,
                  exitCode: e.exitCode,
                  stderrTail: e.stderrTail,
                }),
            ),
          );
        }),

      runPostInitHooks: (recipe, ctx) =>
        Effect.gen(function* () {
          if (recipe.database.postInit.length === 0) return;
          const ref = yield* compose.prepareComposeFile(recipe, ctx);
          for (const hook of recipe.database.postInit) {
            const expanded = expandHook(hook);
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
                const code = yield* runner.runInherited({
                  command: expanded.command,
                  args: expanded.args,
                  cwd,
                  env: ctx.env,
                  prefix: `[hook:${expanded.command}] `,
                });
                if (code !== 0) {
                  yield* Effect.fail(
                    new CommandFailedError({
                      command: expanded.command,
                      args: expanded.args,
                      cwd,
                      exitCode: code,
                      stderrTail: "",
                    }),
                  );
                }
                break;
              }
            }
          }
        }),

      updateModules: (recipe, ctx, modules, options) =>
        Effect.gen(function* () {
          const ref = yield* compose.prepareComposeFile(recipe, ctx);
          yield* ensureDbReady(recipe, ref);
          yield* compose.stream(ref, ["stop", recipe.odoo.serviceName]);
          yield* compose
            .stream(ref, odooUpdateArgs(recipe.odoo.serviceName, ctx.databaseName, modules))
            .pipe(
              Effect.mapError(
                (e) =>
                  new OdooCommandError({
                    args: e.args,
                    exitCode: e.exitCode,
                    stderrTail: e.stderrTail,
                  }),
              ),
            );
          if (options.restart) {
            yield* compose.stream(ref, ["up", "-d", recipe.odoo.serviceName]);
          }
        }),

      runTests: (recipe, ctx, options) =>
        Effect.gen(function* () {
          const ref = yield* compose.prepareComposeFile(recipe, ctx);
          yield* ensureDbReady(recipe, ref);
          const result = yield* compose.tryRun(
            ref,
            odooTestArgs(recipe.odoo.serviceName, ctx.databaseName, options),
          );
          if (result.stdout.length > 0) {
            yield* Effect.sync(() => {
              process.stdout.write(tail(result.stdout, 200) + "\n");
            });
          }
          if (result.stderr.length > 0) {
            yield* Effect.sync(() => {
              process.stderr.write(tail(result.stderr, 200) + "\n");
            });
          }
          return result.exitCode;
        }),
    };
  }),
);
