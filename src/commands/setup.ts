import { resolve } from "node:path";
import { Console, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import type { WorktreeContext } from "../core/worktree-context.js";
import { DockerCompose } from "../platform/docker-compose.js";
import { CommandRunner, runInheritedOrFail } from "../platform/command-runner.js";
import { resolveContext } from "./resolve-context.js";
import { guardReset, runResetFlow } from "./reset-db.js";
import { recordEnvironment, warnOrAutoClean } from "./state-hooks.js";
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
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    Effect.gen(function* () {
      const { ctx, recipe } = yield* resolveContext(flags.config);
      const compose = yield* DockerCompose;
      const runner = yield* CommandRunner;
      yield* compose.ensureAvailable();

      for (const step of buildSetupSteps(recipe, ctx, flags)) {
        switch (step.kind) {
          case "submodules":
            yield* Console.log("» git submodule update --init --recursive");
            yield* runInheritedOrFail(runner, {
              command: "git",
              args: ["submodule", "update", "--init", "--recursive"],
              cwd: ctx.rootDir,
              env: ctx.env,
            });
            break;
          case "install":
            yield* Console.log(`» ${step.command} ${step.args.join(" ")} (${step.cwd})`);
            yield* runInheritedOrFail(runner, {
              command: step.command,
              args: step.args,
              cwd: step.cwd,
              env: ctx.env,
            });
            break;
          case "build": {
            const ref = yield* compose.prepareComposeFile(recipe, ctx);
            yield* compose.stream(ref, ["build", recipe.odoo.serviceName]);
            break;
          }
          case "reset-db":
            yield* guardReset(recipe, ctx, flags.allowShared);
            yield* runResetFlow(recipe, ctx, {
              noTemplate: flags.noTemplate,
              refreshTemplate: flags.refreshTemplate,
              modules: undefined,
              withoutDemo: undefined,
            });
            break;
        }
      }
      yield* recordEnvironment(recipe, ctx);
      yield* Console.log(buildInfoText(ctx));
      yield* warnOrAutoClean(recipe, ctx);
    }),
);
