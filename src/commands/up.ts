import { resolve } from "node:path";
import { Console, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { UsageError } from "../errors/errors.js";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import type { WorktreeContext } from "../core/worktree-context.js";
import { substituteEnvTokens } from "../core/worktree-context.js";
import type { CompanionSpec } from "../platform/process-supervisor.js";
import { ProcessSupervisor } from "../platform/process-supervisor.js";
import { DockerCompose } from "../platform/docker-compose.js";
import { resolveContext } from "./resolve-context.js";
import {
  ensureImageBuilt,
  ensurePortAvailable,
  recordEnvironment,
  warnOrAutoClean,
} from "./state-hooks.js";
import { withJsonReport } from "./json-report.js";
import { buildInfoText } from "./info.js";

type UpFlags = { odooOnly: boolean; detach: boolean; logs: boolean };

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
  // no `--build`: ensureImageBuilt decides beforehand whether a build is
  // needed, so `up` itself never rescans the build context
  upArgs: ["up", "-d", recipe.odoo.serviceName],
  companions: flags.odooOnly ? [] : buildCompanionSpecs(recipe, ctx),
});

/**
 * Attached `up` (no --detach) streams Odoo/companion output until interrupted,
 * so it can never reach a final single JSON line; `--json` is only meaningful
 * detached. Reject up front with guidance pointing at --detach.
 */
export const guardUpJson = (flags: {
  readonly json: boolean;
  readonly detach: boolean;
}): Effect.Effect<void, UsageError> =>
  flags.json && !flags.detach
    ? Effect.fail(
        new UsageError({
          issues: [
            "up --json requires --detach (attached up streams forever and never emits a final JSON line)",
          ],
        }),
      )
    : Effect.void;

/** `--build` forces, `--no-build` skips; asking for both is a contradiction. */
export const guardUpBuildFlags = (flags: {
  readonly build: boolean;
  readonly noBuild: boolean;
}): Effect.Effect<void, UsageError> =>
  flags.build && flags.noBuild
    ? Effect.fail(new UsageError({ issues: ["up --build and --no-build are mutually exclusive"] }))
    : Effect.void;

export const upCommand = Command.make(
  "up",
  {
    odooOnly: Flag.boolean("odoo-only").pipe(Flag.withDescription("skip companion apps")),
    build: Flag.boolean("build").pipe(
      Flag.withDescription("force the image build even when inputs are unchanged"),
    ),
    noBuild: Flag.boolean("no-build").pipe(
      Flag.withDescription("never build; warn when the image looks stale"),
    ),
    logs: Flag.boolean("logs").pipe(Flag.withDescription("follow odoo logs after start")),
    detach: Flag.boolean("detach").pipe(Flag.withDescription("start containers and return")),
    json: Flag.boolean("json").pipe(
      Flag.withDescription("suppress decorative output; print one final JSON report line"),
    ),
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    withJsonReport("up", flags.json, (report) =>
      Effect.gen(function* () {
        yield* guardUpJson(flags);
        yield* guardUpBuildFlags(flags);
        const { ctx, recipe } = yield* resolveContext(flags.config);
        yield* report.setContext(ctx);
        const compose = yield* DockerCompose;
        yield* compose.ensureAvailable();
        yield* ensurePortAvailable(ctx);
        yield* recordEnvironment(recipe, ctx);
        yield* ensureImageBuilt(recipe, ctx, { force: flags.build, skip: flags.noBuild }, report);
        const ref = yield* compose.prepareComposeFile(recipe, ctx);
        const plan = buildUpPlan(recipe, ctx, flags);
        yield* compose.stream(ref, plan.upArgs);
        yield* report.action("compose-up");
        // the info block is redundant with the json report's identity fields
        if (!report.json) yield* Console.log(buildInfoText(ctx));
        yield* warnOrAutoClean(recipe, ctx, report.say);
        if (plan.companions.length > 0 && !flags.detach) {
          yield* report.action("companions");
          const supervisor = yield* ProcessSupervisor;
          yield* supervisor.runAll(plan.companions);
        } else if (flags.logs && !flags.detach) {
          yield* compose.stream(ref, ["logs", "-f", recipe.odoo.serviceName]);
        }
      }),
    ),
).pipe(Command.withDescription("start Odoo + companion apps on the derived ports"));
