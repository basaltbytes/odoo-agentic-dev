import { existsSync } from "node:fs";
import { Console, Effect } from "effect";
import { PortConflictError } from "../errors/errors.js";
import type { ComposeCommandError, StateError } from "../errors/errors.js";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import type { WorktreeContext } from "../core/worktree-context.js";
import { isSharedDatabase } from "../core/safety.js";
import { classifyEnvironments } from "../core/environment.js";
import type { ClassifiedEnvironment, EnvironmentProbe } from "../core/environment.js";
import { StateStore } from "../platform/state-store.js";
import type { EnvironmentUpsert, StateStoreApi } from "../platform/state-store.js";
import { PortProbe } from "../platform/port-probe.js";
import type { PortProbeApi } from "../platform/port-probe.js";
import { DockerCompose } from "../platform/docker-compose.js";
import type { DockerComposeApi } from "../platform/docker-compose.js";

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
 * registry rows against docker reality and either warns (default) or — once
 * Task 7 lands the prune routine — removes them when `cleanup.auto` is set.
 * The environment the command is running in is never a candidate. Until
 * `Git.branchExists` exists (Task 7) probes carry root-dir existence only, so
 * the rule set is reduced to vanished/gone-rootdir/stale.
 */
export const warnOrAutoClean = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
): Effect.Effect<
  ReadonlyArray<ClassifiedEnvironment>,
  StateError | ComposeCommandError,
  StateStoreApi | DockerComposeApi
> =>
  Effect.gen(function* () {
    const store = yield* StateStore;
    const compose = yield* DockerCompose;
    const rows = yield* store.list({ projectId: recipe.project.id });
    const dockerProjects = yield* compose.listProjects();
    const probes = new Map<string, EnvironmentProbe>(
      rows.map((row) => [
        row.composeProject,
        { rootDirExists: existsSync(row.rootDir), branchExists: null },
      ]),
    );
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
    // recipe.cleanup.auto: Task 7 plugs the prune routine in here; until then
    // the auto branch degrades to the same warning as the default path.
    yield* Console.log(
      `${candidates.length} stale environment(s) — run \`odoo-agentic-dev prune\``,
    );
    return candidates;
  });
