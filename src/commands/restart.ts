import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import type { WorktreeContext } from "../core/worktree-context.js";
import { UsageError } from "../errors/errors.js";
import type { RuntimeError } from "../errors/errors.js";
import { DockerCompose } from "../platform/docker-compose.js";
import type { DockerComposeApi } from "../platform/docker-compose.js";
import type { OdooLifecycleApi } from "../platform/odoo-lifecycle.js";
import type { StateStoreApi } from "../platform/state-store.js";
import {
  ensureImageBuilt,
  ensurePortAvailable,
  recordEnvironment,
  reportImageFreshness,
  warnIfImageStale,
} from "./state-hooks.js";
import { resolveContext } from "./resolve-context.js";
import { withJsonReport } from "./json-report.js";
import type { CommandReporter } from "./json-report.js";
import type { PortProbeApi } from "../platform/port-probe.js";
import type { ComposeCommandError } from "../errors/errors.js";

export type RestartFlags = {
  readonly rebuild: boolean;
  readonly logs: boolean;
};

export type RestartPlan = {
  readonly ensureDbArgs: Array<string>;
  readonly removeOdooArgs: Array<string> | null;
  readonly restartOdooArgs: Array<string>;
  readonly logsArgs: Array<string> | null;
};

export const buildRestartPlan = (
  recipe: OdooAgenticDevConfig,
  flags: RestartFlags,
): RestartPlan => ({
  ensureDbArgs: ["up", "-d", recipe.odoo.databaseServiceName],
  removeOdooArgs: flags.rebuild ? ["rm", "-sf", recipe.odoo.serviceName] : null,
  restartOdooArgs: flags.rebuild
    ? ["up", "-d", recipe.odoo.serviceName]
    : ["restart", recipe.odoo.serviceName],
  logsArgs: flags.logs ? ["logs", "-f", recipe.odoo.serviceName] : null,
});

export const guardRestartJson = (flags: {
  readonly json: boolean;
  readonly logs: boolean;
}): Effect.Effect<void, UsageError> =>
  flags.json && flags.logs
    ? Effect.fail(
        new UsageError({
          issues: [
            "restart --json cannot be combined with --logs (log following streams forever and never emits a final JSON line)",
          ],
        }),
      )
    : Effect.void;

export const missingRestartContainerMessage = (serviceName: string): string =>
  `No existing "${serviceName}" container could be restarted. Fast restart only works after Odoo has been created for this worktree. Run \`oad up --detach\` to create/start it, or run \`oad restart --rebuild\` to rebuild and recreate it.`;

export const isMissingRestartContainerError = (error: ComposeCommandError): boolean => {
  const output = error.stderrTail;
  return /\b(no containers? to restart|has no container to restart)\b/i.test(output);
};

const restartOrExplain = (
  compose: DockerComposeApi,
  ref: Parameters<DockerComposeApi["stream"]>[0],
  serviceName: string,
  args: ReadonlyArray<string>,
): Effect.Effect<void, ComposeCommandError | UsageError> =>
  compose
    .stream(ref, args)
    .pipe(
      Effect.mapError((error) =>
        isMissingRestartContainerError(error)
          ? new UsageError({ issues: [missingRestartContainerMessage(serviceName)] })
          : error,
      ),
    );

export const runRestart = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
  flags: RestartFlags,
  report: CommandReporter,
): Effect.Effect<
  void,
  RuntimeError,
  DockerComposeApi | PortProbeApi | StateStoreApi | OdooLifecycleApi
> =>
  Effect.gen(function* () {
    const compose = yield* DockerCompose;
    yield* compose.ensureAvailable();
    yield* ensurePortAvailable(ctx);
    yield* recordEnvironment(recipe, ctx);
    if (flags.rebuild) {
      // force through the shared image gate (build + record + keyed-tag GC)
      yield* ensureImageBuilt(recipe, ctx, { force: true }, report);
    } else {
      // a plain restart reuses the existing container, so a fresher image
      // would not be picked up anyway — warn instead of building
      yield* reportImageFreshness(report, yield* warnIfImageStale(recipe, ctx, report.say));
    }

    const ref = yield* compose.prepareComposeFile(recipe, ctx);
    const plan = buildRestartPlan(recipe, flags);
    yield* compose.stream(ref, plan.ensureDbArgs);
    yield* compose.waitForDb(ref, recipe.odoo.databaseServiceName);
    yield* report.action("ensure-db");

    if (plan.removeOdooArgs !== null) {
      yield* compose.stream(ref, plan.removeOdooArgs);
      yield* report.action("remove-odoo");
    }

    yield* restartOrExplain(compose, ref, recipe.odoo.serviceName, plan.restartOdooArgs);
    yield* report.action("restart-odoo");

    yield* report.setExtra("rebuilt", flags.rebuild);
    yield* report.setExtra("logsFollowed", flags.logs);
    if (plan.logsArgs !== null) {
      yield* compose.stream(ref, plan.logsArgs);
    }
  });

export const restartCommand = Command.make(
  "restart",
  {
    rebuild: Flag.boolean("rebuild").pipe(
      Flag.withDescription("rebuild the Odoo image, remove the Odoo container, and recreate it"),
    ),
    logs: Flag.boolean("logs").pipe(Flag.withDescription("follow Odoo logs after restart")),
    json: Flag.boolean("json").pipe(
      Flag.withDescription("suppress decorative output; print one final JSON report line"),
    ),
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    withJsonReport("restart", flags.json, (report) =>
      Effect.gen(function* () {
        yield* guardRestartJson(flags);
        const { ctx, recipe } = yield* resolveContext(flags.config);
        yield* report.setContext(ctx);
        yield* runRestart(recipe, ctx, flags, report);
      }),
    ),
).pipe(Command.withDescription("restart Odoo for this worktree (--rebuild to rebuild first)"));
