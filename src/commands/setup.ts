import { resolve } from "node:path";
import { Console, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import type { WorktreeContext } from "../core/worktree-context.js";
import { DockerCompose } from "../platform/docker-compose.js";
import { OdooLifecycle } from "../platform/odoo-lifecycle.js";
import { CommandRunner } from "../platform/command-runner.js";
import { resolveContext } from "./resolve-context.js";
import { guardReset } from "./reset-db.js";
import { buildInfoText } from "./info.js";
import { CommandFailedError } from "../errors/errors.js";
import type { RuntimeError } from "../errors/errors.js";

export type SetupStep =
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
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    Effect.gen(function* () {
      const { ctx, recipe } = yield* resolveContext(flags.config);
      const compose = yield* DockerCompose;
      const runner = yield* CommandRunner;
      const lifecycle = yield* OdooLifecycle;
      yield* compose.ensureAvailable();

      const runHost = (command: string, args: ReadonlyArray<string>, cwd: string) =>
        runner
          .runInherited({ command, args, cwd, env: ctx.env })
          .pipe(
            Effect.flatMap((code) =>
              code === 0
                ? Effect.void
                : Effect.fail(
                    new CommandFailedError({ command, args, cwd, exitCode: code, stderrTail: "" }),
                  ),
            ),
          );

      for (const step of buildSetupSteps(recipe, ctx, flags)) {
        switch (step.kind) {
          case "submodules":
            yield* Console.log("» git submodule update --init --recursive");
            yield* runHost("git", ["submodule", "update", "--init", "--recursive"], ctx.rootDir);
            break;
          case "install":
            yield* Console.log(`» ${step.command} ${step.args.join(" ")} (${step.cwd})`);
            yield* runHost(step.command, step.args, step.cwd);
            break;
          case "build": {
            const ref = yield* compose.prepareComposeFile(recipe, ctx);
            yield* compose.stream(ref, ["build", recipe.odoo.serviceName]);
            break;
          }
          case "reset-db":
            yield* Effect.try({
              try: () => guardReset(recipe, ctx, flags.allowShared),
              catch: (e) => e as RuntimeError,
            });
            yield* Console.log(`Resetting database: ${ctx.databaseName}`);
            yield* lifecycle.resetDatabase(recipe, ctx, {});
            yield* lifecycle.runPostInitHooks(recipe, ctx);
            break;
        }
      }
      yield* Console.log(buildInfoText(ctx));
    }),
);
