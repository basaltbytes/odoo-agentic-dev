import { Console, Effect } from "effect";
import { ConfigLoadError, PortConflictError } from "../errors/errors.js";
import type { ComposeCommandError, StateError } from "../errors/errors.js";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import type { WorktreeContext } from "../core/worktree-context.js";
import { isSharedDatabase } from "../core/safety.js";
import { classifyEnvironments } from "../core/environment.js";
import type { ClassifiedEnvironment } from "../core/environment.js";
import {
  computeImageKeyForContext,
  imageReference,
  imageRepository,
  usesKeyedImage,
} from "../core/image-fingerprint.js";
import { StateStore } from "../platform/state-store.js";
import type { EnvironmentUpsert, StateStoreApi } from "../platform/state-store.js";
import { withStateDbRoot } from "../platform/state-store.js";
import { PortProbe } from "../platform/port-probe.js";
import type { PortProbeApi } from "../platform/port-probe.js";
import { DockerCompose } from "../platform/docker-compose.js";
import type { DockerComposeApi } from "../platform/docker-compose.js";
import type { GitApi } from "../platform/git.js";
import { OdooLifecycle } from "../platform/odoo-lifecycle.js";
import type { OdooLifecycleApi } from "../platform/odoo-lifecycle.js";
import { buildProbes, runPrune } from "./prune.js";
import type { CommandReporter } from "./json-report.js";
import type { RuntimeError } from "../errors/errors.js";

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
  withStateDbRoot(
    ctx.rootDir,
    Effect.gen(function* () {
      const store = yield* StateStore;
      yield* store.upsert(rowFromContext(recipe, ctx));
    }),
  );

export type ImageFreshness = {
  readonly managed: boolean;
  readonly fresh: boolean | null;
  readonly expectedImageKey: string | null;
  readonly recordedImageKey: string | null;
  readonly imageBuiltAt: string | null;
  readonly error: string | null;
};

export const checkImageFreshness = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
): Effect.Effect<ImageFreshness, StateError | ConfigLoadError, StateStoreApi> =>
  withStateDbRoot(
    ctx.rootDir,
    Effect.gen(function* () {
      const expectedImageKey = yield* computeImageKeyForContext(recipe, ctx);
      if (expectedImageKey === null) {
        return {
          managed: false,
          fresh: null,
          expectedImageKey: null,
          recordedImageKey: null,
          imageBuiltAt: null,
          error: null,
        };
      }
      const store = yield* StateStore;
      const row = yield* store.get(ctx.composeProjectName);
      const recordedImageKey = row?.imageKey ?? null;
      return {
        managed: true,
        fresh: recordedImageKey === expectedImageKey,
        expectedImageKey,
        recordedImageKey,
        imageBuiltAt: row?.imageBuiltAt ?? null,
        error: null,
      };
    }),
  );

export const recordImageBuild = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
): Effect.Effect<ImageFreshness, StateError | ConfigLoadError, StateStoreApi> =>
  withStateDbRoot(
    ctx.rootDir,
    Effect.gen(function* () {
      const store = yield* StateStore;
      const expectedImageKey = yield* computeImageKeyForContext(recipe, ctx);
      if (expectedImageKey === null) {
        yield* store.setImageBuild(ctx.composeProjectName, null);
        return {
          managed: false,
          fresh: null,
          expectedImageKey: null,
          recordedImageKey: null,
          imageBuiltAt: null,
          error: null,
        };
      }
      const imageBuiltAt = new Date().toISOString();
      yield* store.setImageBuild(ctx.composeProjectName, {
        key: expectedImageKey,
        builtAt: imageBuiltAt,
      });
      return {
        managed: true,
        fresh: true,
        expectedImageKey,
        recordedImageKey: expectedImageKey,
        imageBuiltAt,
        error: null,
      };
    }),
  );

const unknownImageFreshness = (error: ConfigLoadError): ImageFreshness => ({
  managed: true,
  fresh: null,
  expectedImageKey: null,
  recordedImageKey: null,
  imageBuiltAt: null,
  error: error.message,
});

export const imageStaleMessage = (freshness: ImageFreshness): string | null => {
  if (!freshness.managed || freshness.fresh !== false) return null;
  const reason =
    freshness.recordedImageKey === null
      ? "no successful image build is recorded for this worktree"
      : "image inputs changed since the last successful build";
  return `Odoo image may be stale: ${reason}. Run \`oad restart --rebuild\`, \`oad setup\`, or re-run this command with \`--build\` when available.`;
};

export const warnIfImageStale = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
  say: (line: string) => Effect.Effect<void> = Console.log,
): Effect.Effect<ImageFreshness, StateError, StateStoreApi | DockerComposeApi> =>
  Effect.gen(function* () {
    let freshness = yield* checkImageFreshness(recipe, ctx).pipe(
      Effect.catchTag("ConfigLoadError", (error) =>
        say(
          `Could not compute Odoo image freshness: ${error.message}. Continuing without freshness check.`,
        ).pipe(Effect.as(unknownImageFreshness(error))),
      ),
    );
    // keyed images: the tag IS the key, so the exact reference existing beats
    // row-based freshness (a sibling worktree may have built it for us)
    if (
      freshness.fresh === false &&
      usesKeyedImage(recipe) &&
      freshness.expectedImageKey !== null
    ) {
      const compose = yield* DockerCompose;
      const exists = yield* compose
        .imageExists(imageReference(recipe, freshness.expectedImageKey))
        .pipe(Effect.catch(() => Effect.succeed(false)));
      if (exists) freshness = { ...freshness, fresh: true };
    }
    const message = imageStaleMessage(freshness);
    if (message !== null) yield* say(message);
    return freshness;
  });

export const reportImageFreshness = (
  report: CommandReporter,
  freshness: ImageFreshness,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* report.setExtra("imageManaged", freshness.managed);
    yield* report.setExtra("imageFresh", freshness.fresh);
    yield* report.setExtra("expectedImageKey", freshness.expectedImageKey);
    yield* report.setExtra("recordedImageKey", freshness.recordedImageKey);
    yield* report.setExtra("imageBuiltAt", freshness.imageBuiltAt);
    yield* report.setExtra("imageFreshnessError", freshness.error);
  });

export type ImageBuildDecision = "none" | "build" | "skip-fresh" | "skip-flag";

/**
 * Pure build/skip decision. `keyed` = fingerprint-keyed shared tag (managed
 * `odoo.build` without an explicit imageName): the tag existing means the
 * image matches the current inputs by construction. Fixed-name images fall
 * back to the per-worktree row freshness; a recipe that is applicable but not
 * verifiably fresh builds — with a warm layer cache that costs seconds, while
 * a wrongly skipped build silently runs stale code.
 */
export const decideImageBuild = (options: {
  readonly applicable: boolean;
  readonly keyed: boolean;
  readonly exists: boolean;
  readonly rowFresh: boolean;
  readonly force: boolean;
  readonly skip: boolean;
}): ImageBuildDecision => {
  if (!options.applicable) return "none";
  if (options.skip) return "skip-flag";
  if (options.force) return "build";
  if (!options.exists) return "build";
  if (options.keyed) return "skip-fresh";
  return options.rowFresh ? "skip-fresh" : "build";
};

/**
 * Best-effort GC after a successful keyed build: keyed tags of this project's
 * repository that no registry row references anymore are superseded input
 * generations — without this they would accumulate one full image per config
 * change. Never fails the command; images held by running containers survive
 * (docker refuses that removal and the whole sweep is swallowed).
 */
const gcKeyedImages = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
  currentKey: string,
  say: (line: string) => Effect.Effect<void>,
): Effect.Effect<void, never, DockerComposeApi | StateStoreApi> =>
  withStateDbRoot(
    ctx.rootDir,
    Effect.gen(function* () {
      const compose = yield* DockerCompose;
      const store = yield* StateStore;
      const repo = imageRepository(recipe);
      const tags = yield* compose.listImageTags(repo);
      const rows = yield* store.list({});
      const referenced = (ref: string): boolean => {
        const tag = ref.slice(repo.length + 1);
        return (
          currentKey.startsWith(tag) ||
          rows.some((row) => row.imageKey !== null && row.imageKey.startsWith(tag))
        );
      };
      const stale = tags.filter((ref) => ref.startsWith(`${repo}:`) && !referenced(ref));
      if (stale.length === 0) return;
      yield* compose.removeImages(stale);
      yield* say(`Removed ${stale.length} superseded Odoo image tag(s).`);
    }).pipe(Effect.catch(() => Effect.void)),
  );

/**
 * The one image gate every image-dependent command runs: build when needed,
 * skip when the current inputs are already built (see decideImageBuild), and
 * report either way. `force` maps from `--build`/`--rebuild`, `skip` from
 * `up --no-build` (skip only warns, like the old warn-only paths).
 */
export const ensureImageBuilt = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
  flags: { readonly force: boolean; readonly skip?: boolean },
  report: CommandReporter,
): Effect.Effect<
  ImageBuildDecision,
  RuntimeError,
  OdooLifecycleApi | DockerComposeApi | StateStoreApi
> =>
  Effect.gen(function* () {
    const applicable = recipe.odoo.build !== null || recipe.odoo.dockerfile !== null;
    if (!applicable) {
      yield* report.setExtra("imageBuild", "none");
      return "none";
    }
    if (flags.skip === true) {
      yield* reportImageFreshness(report, yield* warnIfImageStale(recipe, ctx, report.say));
      yield* report.setExtra("imageBuild", "skip-flag");
      return "skip-flag";
    }
    const compose = yield* DockerCompose;
    const keyed = usesKeyedImage(recipe);
    // fingerprint failure (e.g. a deleted requirements file) reads as "unknown,
    // so build": the build itself then fails with the real docker error
    const expectedKey = yield* computeImageKeyForContext(recipe, ctx).pipe(
      Effect.catchTag("ConfigLoadError", () => Effect.succeed(null)),
    );
    const reference =
      keyed && expectedKey !== null
        ? imageReference(recipe, expectedKey)
        : // compose's default image name for built services
          (recipe.odoo.imageName ?? `${ctx.composeProjectName}-${recipe.odoo.serviceName}`);
    const exists =
      (!keyed || expectedKey !== null) &&
      (yield* compose.imageExists(reference).pipe(Effect.catch(() => Effect.succeed(false))));
    const row = yield* withStateDbRoot(
      ctx.rootDir,
      Effect.gen(function* () {
        const store = yield* StateStore;
        return yield* store.get(ctx.composeProjectName);
      }),
    );
    const rowFresh = expectedKey !== null && row?.imageKey === expectedKey;
    const decision = decideImageBuild({
      applicable,
      keyed,
      exists,
      rowFresh,
      force: flags.force,
      skip: false,
    });

    if (decision === "build") {
      const lifecycle = yield* OdooLifecycle;
      yield* lifecycle.buildImage(recipe, ctx);
      yield* report.action("build-image");
      const freshness = yield* recordImageBuild(recipe, ctx);
      yield* reportImageFreshness(report, freshness);
      if (keyed && expectedKey !== null) {
        yield* gcKeyedImages(recipe, ctx, expectedKey, report.say);
      }
    } else {
      // adopt a sibling worktree's build into this row so doctor/list agree;
      // builtAt then reads as "verified fresh here", not the docker build time
      const freshness = rowFresh
        ? {
            managed: true,
            fresh: true,
            expectedImageKey: expectedKey,
            recordedImageKey: expectedKey,
            imageBuiltAt: row?.imageBuiltAt ?? null,
            error: null,
          }
        : yield* recordImageBuild(recipe, ctx);
      yield* reportImageFreshness(report, freshness);
    }
    yield* report.setExtra("imageBuild", decision);
    return decision;
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
  withStateDbRoot(
    ctx.rootDir,
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
    }),
  );

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
  say: (line: string) => Effect.Effect<void> = Console.log,
): Effect.Effect<
  ReadonlyArray<ClassifiedEnvironment>,
  StateError | ComposeCommandError,
  StateStoreApi | DockerComposeApi | GitApi
> =>
  withStateDbRoot(
    ctx.rootDir,
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
          yield* say(`auto-clean: removed ${removal.composeProject} (${removal.reason})`);
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
      yield* say(`${candidates.length} stale environment(s) — run \`odoo-agentic-dev prune\``);
      return candidates;
    }),
  );
