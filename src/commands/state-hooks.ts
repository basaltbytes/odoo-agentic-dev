import { Console, Effect } from "effect";
import { PortConflictError } from "../errors/errors.js";
import type { ComposeCommandError, StateError } from "../errors/errors.js";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import type { WorktreeContext } from "../core/worktree-context.js";
import { isSharedDatabase } from "../core/safety.js";
import { classifyEnvironments } from "../core/environment.js";
import type { ClassifiedEnvironment } from "../core/environment.js";
import { StateStore } from "../platform/state-store.js";
import type { EnvironmentUpsert, StateStoreApi } from "../platform/state-store.js";
import { PortProbe } from "../platform/port-probe.js";
import type { PortProbeApi } from "../platform/port-probe.js";
import { DockerCompose } from "../platform/docker-compose.js";
import type { DockerComposeApi } from "../platform/docker-compose.js";
import type { GitApi } from "../platform/git.js";
import { buildProbes, runPrune } from "./prune.js";

/** The live identity of this command's environment, ready for StateStore.upsert. */
export const rowFromContext = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
): EnvironmentUpsert => ({
  composeProject: ctx.composeProjectName,
  projectId: recipe.project.id,
  databaseName: ctx.databaseName,
  rootDir: ctx.rootDir,
  worktreeName: ctx.worktreeName,
  branch: ctx.branch,
  odooHttpPort: ctx.odooHttpPort,
  shared: isSharedDatabase(ctx.databaseName, recipe.project.sharedDatabase),
});

/** Insert-or-touch the registry row for this environment. */
export const recordEnvironment = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
): Effect.Effect<void, StateError, StateStoreApi> =>
  Effect.gen(function* () {
    const store = yield* StateStore;
    yield* store.upsert(rowFromContext(recipe, ctx));
  });

/**
 * Fail fast before `up` when the derived port is taken — unless it is our own
 * already-running stack (idempotent up). The holder is named when the state
 * registry knows which stack sits on the port.
 */
export const ensurePortAvailable = (
  ctx: WorktreeContext,
): Effect.Effect<
  void,
  PortConflictError | ComposeCommandError | StateError,
  PortProbeApi | DockerComposeApi | StateStoreApi
> =>
  Effect.gen(function* () {
    const probe = yield* PortProbe;
    if (yield* probe.isFree(ctx.odooHttpPort)) return;
    const compose = yield* DockerCompose;
    const projects = yield* compose.listProjects();
    const ours = projects.find((p) => p.name === ctx.composeProjectName);
    if (ours !== undefined && ours.running) return;
    const store = yield* StateStore;
    const rows = yield* store.list({});
    const holder = rows.find(
      (row) =>
        row.odooHttpPort === ctx.odooHttpPort && row.composeProject !== ctx.composeProjectName,
    );
    return yield* Effect.fail(
      new PortConflictError({ port: ctx.odooHttpPort, holder: holder?.composeProject ?? null }),
    );
  });

/**
 * End-of-command cleanup hook for `up`/`setup`. Classifies this project's
 * registry rows against docker reality and either warns (default) or removes
 * them via the prune routine when `cleanup.auto` is set. Shared rows are
 * never auto-cleaned, and the environment the command is running in is never
 * a candidate on either path.
 */
export const warnOrAutoClean = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
): Effect.Effect<
  ReadonlyArray<ClassifiedEnvironment>,
  StateError | ComposeCommandError,
  StateStoreApi | DockerComposeApi | GitApi
> =>
  Effect.gen(function* () {
    if (recipe.cleanup.auto) {
      const report = yield* runPrune({
        olderThanDays: recipe.cleanup.maxAgeDays,
        yes: true,
        allowShared: false,
        projectId: recipe.project.id,
        excludeComposeProject: ctx.composeProjectName,
      });
      for (const removal of report.removed) {
        yield* Console.log(`auto-clean: removed ${removal.composeProject} (${removal.reason})`);
      }
      return report.candidates;
    }

    const store = yield* StateStore;
    const compose = yield* DockerCompose;
    const rows = yield* store.list({ projectId: recipe.project.id });
    const dockerProjects = yield* compose.listProjects();
    const probes = yield* buildProbes(rows);
    const classified = classifyEnvironments({
      rows,
      dockerProjects,
      probes,
      olderThanDays: recipe.cleanup.maxAgeDays,
      allowShared: false,
      now: new Date().toISOString(),
    });
    const candidates = classified.filter(
      (c) =>
        c.reason !== "keep" &&
        c.reason !== "shared-skipped" &&
        c.row.composeProject !== ctx.composeProjectName,
    );
    if (candidates.length === 0) return candidates;
    yield* Console.log(
      `${candidates.length} stale environment(s) — run \`odoo-agentic-dev prune\``,
    );
    return candidates;
  });
