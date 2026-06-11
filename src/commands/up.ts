import { resolve } from "node:path";
import { Console, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import type { WorktreeContext } from "../core/worktree-context.js";
import { substituteEnvTokens } from "../core/worktree-context.js";
import type { CompanionSpec } from "../platform/process-supervisor.js";
import { ProcessSupervisor } from "../platform/process-supervisor.js";
import { DockerCompose } from "../platform/docker-compose.js";
import { resolveContext } from "./resolve-context.js";
import { buildInfoText } from "./info.js";

type UpFlags = { odooOnly: boolean; noBuild: boolean; detach: boolean; logs: boolean };

const buildCompanionSpecs = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
): Array<CompanionSpec> =>
  recipe.companionApps.map((app) => {
    const extra: Record<string, string> = {};
    for (const [key, value] of Object.entries(app.env ?? {})) {
      extra[key] = substituteEnvTokens(value, ctx.env);
    }
    const port = ctx.companionPorts.get(app.name);
    if (app.portEnv !== undefined && port !== undefined) extra[app.portEnv] = String(port);
    return {
      name: app.name,
      cwd: resolve(ctx.rootDir, app.cwd),
      command: app.command,
      args: app.args,
      env: { ...ctx.env, ...extra },
    };
  });

export const buildUpPlan = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
  flags: UpFlags,
): {
  readonly upArgs: Array<string>;
  readonly companions: Array<CompanionSpec>;
} => ({
  upArgs: ["up", "-d", ...(flags.noBuild ? [] : ["--build"]), recipe.odoo.serviceName],
  companions: flags.odooOnly ? [] : buildCompanionSpecs(recipe, ctx),
});

export const upCommand = Command.make(
  "up",
  {
    odooOnly: Flag.boolean("odoo-only").pipe(Flag.withDescription("skip companion apps")),
    noBuild: Flag.boolean("no-build"),
    logs: Flag.boolean("logs").pipe(Flag.withDescription("follow odoo logs after start")),
    detach: Flag.boolean("detach").pipe(Flag.withDescription("start containers and return")),
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    Effect.gen(function* () {
      const { ctx, recipe } = yield* resolveContext(flags.config);
      const compose = yield* DockerCompose;
      yield* compose.ensureAvailable();
      const ref = yield* compose.prepareComposeFile(recipe, ctx);
      const plan = buildUpPlan(recipe, ctx, flags);
      yield* compose.stream(ref, plan.upArgs);
      yield* Console.log(buildInfoText(ctx));
      if (plan.companions.length > 0 && !flags.detach) {
        const supervisor = yield* ProcessSupervisor;
        yield* supervisor.runAll(plan.companions);
      } else if (flags.logs && !flags.detach) {
        yield* compose.stream(ref, ["logs", "-f", recipe.odoo.serviceName]);
      }
    }),
);
