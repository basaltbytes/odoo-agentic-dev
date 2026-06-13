import { resolve } from "node:path";
import { Console, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import type { WorktreeContext } from "../core/worktree-context.js";
import type { RuntimeError } from "../errors/errors.js";
import { DockerCompose } from "../platform/docker-compose.js";
import type { DockerComposeApi } from "../platform/docker-compose.js";
import { CommandRunner, runInheritedOrFail } from "../platform/command-runner.js";
import type { CommandRunnerApi } from "../platform/command-runner.js";
import { OdooLifecycle } from "../platform/odoo-lifecycle.js";
import type { OdooLifecycleApi } from "../platform/odoo-lifecycle.js";
import type { StateStoreApi } from "../platform/state-store.js";
import type { GitApi } from "../platform/git.js";
import { resolveContext } from "./resolve-context.js";
import { computeTemplateKeyForContext, guardReset, runResetFlow } from "./reset-db.js";
import { recordEnvironment, warnOrAutoClean } from "./state-hooks.js";
import { resetPathActions, resetPathMode, withJsonReport } from "./json-report.js";
import type { CommandReporter } from "./json-report.js";
import { buildInfoText } from "./info.js";

type SetupStep =
  | { readonly kind: "submodules" }
  | {
      readonly kind: "install";
      readonly cwd: string;
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    }
  | { readonly kind: "build" }
  | { readonly kind: "reset-db" };

export const buildSetupSteps = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
  flags: { readonly skipInstall: boolean; readonly skipDb: boolean },
): Array<SetupStep> => [
  ...(recipe.setup.submodules ? [{ kind: "submodules" } as const] : []),
  ...(flags.skipInstall
    ? []
    : recipe.setup.packageManagers.map((step) => ({
        kind: "install" as const,
        cwd: resolve(ctx.rootDir, step.cwd),
        command: step.command,
        args: step.args,
      }))),
  { kind: "build" } as const,
  ...(flags.skipDb ? [] : [{ kind: "reset-db" } as const]),
];

export type SetupFlags = {
  readonly skipInstall: boolean;
  readonly skipDb: boolean;
  readonly allowShared: boolean;
  readonly noTemplate: boolean;
  readonly refreshTemplate: boolean;
};

/** Everything `setup` does after the context resolves (extracted for tests). */
export const runSetup = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
  flags: SetupFlags,
  report: CommandReporter,
): Effect.Effect<
  void,
  RuntimeError,
  DockerComposeApi | CommandRunnerApi | OdooLifecycleApi | StateStoreApi | GitApi
> =>
  Effect.gen(function* () {
    const compose = yield* DockerCompose;
    const runner = yield* CommandRunner;
    yield* compose.ensureAvailable();
    // the row must exist BEFORE the reset step: template metadata is written
    // with an UPDATE keyed on the compose project, so a fresh setup recording
    // its row last would silently drop its own snapshot
    yield* recordEnvironment(recipe, ctx);

    for (const step of buildSetupSteps(recipe, ctx, flags)) {
      switch (step.kind) {
        case "submodules":
          yield* report.action("submodules");
          yield* report.say("» git submodule update --init --recursive");
          yield* runInheritedOrFail(runner, {
            command: "git",
            args: ["submodule", "update", "--init", "--recursive"],
            cwd: ctx.rootDir,
            env: ctx.env,
          });
          break;
        case "install":
          yield* report.action("install");
          yield* report.say(`» ${step.command} ${step.args.join(" ")} (${step.cwd})`);
          yield* runInheritedOrFail(runner, {
            command: step.command,
            args: step.args,
            cwd: step.cwd,
            env: ctx.env,
          });
          break;
        case "build": {
          yield* report.action("build-image");
          const ref = yield* compose.prepareComposeFile(recipe, ctx);
          yield* compose.stream(ref, ["build", recipe.odoo.serviceName]);
          break;
        }
        case "reset-db": {
          const lifecycle = yield* OdooLifecycle;
          const databaseExists =
            recipe.project.sharedDatabase === ctx.databaseName && !flags.allowShared
              ? yield* lifecycle.databaseExists(recipe, ctx)
              : undefined;
          yield* guardReset(recipe, ctx, flags.allowShared, { databaseExists });
          const path = yield* runResetFlow(recipe, ctx, {
            noTemplate: flags.noTemplate,
            refreshTemplate: flags.refreshTemplate,
            build: false,
            modules: undefined,
            withoutDemo: undefined,
            say: report.say,
          });
          yield* Effect.forEach(resetPathActions(path), report.action);
          yield* report.setExtra("mode", resetPathMode(path));
          yield* report.setExtra("templateKey", yield* computeTemplateKeyForContext(recipe, ctx));
          break;
        }
      }
    }
    // the info block is redundant with the json report's identity fields
    if (!report.json) yield* Console.log(buildInfoText(ctx));
    yield* warnOrAutoClean(recipe, ctx, report.say);
  });

export const setupCommand = Command.make(
  "setup",
  {
    skipInstall: Flag.boolean("skip-install"),
    skipDb: Flag.boolean("skip-db"),
    allowShared: Flag.boolean("allow-shared"),
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
    withJsonReport("setup", flags.json, (report) =>
      Effect.gen(function* () {
        const { ctx, recipe } = yield* resolveContext(flags.config);
        yield* report.setContext(ctx);
        yield* runSetup(recipe, ctx, flags, report);
      }),
    ),
).pipe(Command.withDescription("prepare the worktree: deps, image, database, template snapshot"));
