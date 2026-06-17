import { existsSync } from "node:fs";
import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { classifyEnvironments } from "../core/environment.js";
import type {
  ClassifiedEnvironment,
  EnvironmentProbe,
  EnvironmentRow,
  PruneReason,
} from "../core/environment.js";
import { UsageError } from "../errors/errors.js";
import type { ComposeCommandError, StateError } from "../errors/errors.js";
import { DockerCompose } from "../platform/docker-compose.js";
import type { DockerComposeApi } from "../platform/docker-compose.js";
import { Git } from "../platform/git.js";
import type { GitApi } from "../platform/git.js";
import { StateStore } from "../platform/state-store.js";
import type { StateStoreApi } from "../platform/state-store.js";
import { withStateDbRoot } from "../platform/state-store.js";
import { relativeAge } from "./list.js";
import { resolveProjectScope } from "./resolve-context.js";

/**
 * Filesystem/git facts per registry row. A probe failure (root dir exists but
 * is no longer a repo, odd git states) maps to `branchExists: null` — the
 * conservative "branch rule does not apply" answer — never to a prune.
 */
export const buildProbes = (
  rows: ReadonlyArray<EnvironmentRow>,
): Effect.Effect<ReadonlyMap<string, EnvironmentProbe>, never, GitApi> =>
  Effect.gen(function* () {
    const git = yield* Git;
    const probes = new Map<string, EnvironmentProbe>();
    for (const row of rows) {
      const rootDirExists = existsSync(row.rootDir);
      const branchExists =
        rootDirExists && row.branch !== null
          ? yield* git
              .branchExists(row.rootDir, row.branch)
              .pipe(Effect.catch(() => Effect.succeed<boolean | null>(null)))
          : null;
      probes.set(row.composeProject, { rootDirExists, branchExists });
    }
    return probes;
  });

export type PruneOptions = {
  /** stale threshold; null = staleness never makes a row a candidate */
  readonly olderThanDays: number | null;
  /** without it the run is a dry run: candidates are computed, nothing acts */
  readonly yes: boolean;
  readonly allowShared: boolean;
  /** undefined = all projects */
  readonly projectId: string | undefined;
  /** auto-clean shield: the environment the calling command runs in is never a candidate */
  readonly excludeComposeProject?: string | undefined;
};

export type PruneRemoval = {
  readonly composeProject: string;
  readonly reason: PruneReason;
};

export type PruneReport = {
  readonly candidates: ReadonlyArray<ClassifiedEnvironment>;
  readonly removed: ReadonlyArray<PruneRemoval>;
};

/**
 * The prune routine shared by the `prune` command and `cleanup.auto`. Unlike
 * the auto-clean warning path this has no notion of a "current" environment;
 * callers that have one pass `excludeComposeProject`.
 */
export const runPrune = (
  options: PruneOptions,
): Effect.Effect<
  PruneReport,
  StateError | ComposeCommandError,
  StateStoreApi | DockerComposeApi | GitApi
> =>
  Effect.gen(function* () {
    const store = yield* StateStore;
    const compose = yield* DockerCompose;
    const rows = yield* store.list({ projectId: options.projectId });
    // an empty registry can have no candidates: skip docker discovery entirely
    // so `prune` still works (and exits 0) where docker is absent or down
    if (rows.length === 0) return { candidates: [], removed: [] };
    const dockerProjects = yield* compose.listProjects();
    const probes = yield* buildProbes(rows);
    const classified = classifyEnvironments({
      rows,
      dockerProjects,
      probes,
      olderThanDays: options.olderThanDays,
      allowShared: options.allowShared,
      now: new Date().toISOString(),
    });
    const candidates = classified.filter(
      (c) =>
        c.reason !== "keep" &&
        c.reason !== "shared-skipped" &&
        c.row.composeProject !== options.excludeComposeProject,
    );
    if (!options.yes) return { candidates, removed: [] };

    const removed: Array<PruneRemoval> = [];
    for (const candidate of candidates) {
      // teardown order: docker resources first, then the row — failing midway
      // leaves the row behind for the next run instead of orphaning containers.
      // vanished rows are swept too: a manual `docker compose down` removes
      // the containers but can leave labeled volumes/networks behind (no-op otherwise)
      yield* compose.removeByLabel(candidate.row.composeProject);
      yield* store.remove(candidate.row.composeProject);
      removed.push({ composeProject: candidate.row.composeProject, reason: candidate.reason });
    }
    return { candidates, removed };
  });

/**
 * Render a prune report and apply the exit-code contract: a dry run that
 * found candidates exits 1 (via process.exitCode — the Effect still succeeds).
 */
export const reportPrune = (
  report: PruneReport,
  options: { readonly yes: boolean; readonly json: boolean },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (options.json) {
      yield* Console.log(
        JSON.stringify(
          {
            applied: options.yes,
            candidates: report.candidates.map((c) => ({
              ...c.row,
              status: c.status,
              reason: c.reason,
            })),
            removed: report.removed,
          },
          null,
          2,
        ),
      );
    } else if (report.candidates.length === 0) {
      yield* Console.log("Nothing to prune.");
    } else {
      const now = new Date().toISOString();
      for (const c of report.candidates) {
        yield* Console.log(
          `${c.row.composeProject}  ${c.row.databaseName}  ${relativeAge(c.row.lastUsedAt, now)}  ${c.reason}`,
        );
      }
      yield* options.yes
        ? Console.log(`Removed ${report.removed.length} environment(s).`)
        : Console.log("Dry run — re-run with --yes to remove these environments.");
    }
    if (!options.yes && report.candidates.length > 0) {
      process.exitCode = 1;
    }
  });

export const pruneCommand = Command.make(
  "prune",
  {
    olderThan: Flag.integer("older-than").pipe(
      Flag.optional,
      Flag.withDescription("also prune environments unused for more than <days>"),
    ),
    allProjects: Flag.boolean("all-projects").pipe(
      Flag.withDescription("every project in the registry (works without a config)"),
    ),
    yes: Flag.boolean("yes").pipe(
      Flag.withDescription("actually remove (without it: dry run, exit 1 when candidates exist)"),
    ),
    allowShared: Flag.boolean("allow-shared"),
    json: Flag.boolean("json").pipe(Flag.withDescription("print machine-readable JSON")),
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    Effect.gen(function* () {
      const olderThanDays = Option.getOrUndefined(flags.olderThan) ?? null;
      if (olderThanDays !== null && olderThanDays < 1) {
        return yield* Effect.fail(
          new UsageError({
            issues: [`--older-than must be an integer >= 1, got ${olderThanDays}`],
          }),
        );
      }
      const scope = yield* resolveProjectScope(flags.config, flags.allProjects);
      const report = yield* scope.rootDir === undefined
        ? runPrune({
            olderThanDays,
            yes: flags.yes,
            allowShared: flags.allowShared,
            projectId: scope.projectId,
          })
        : withStateDbRoot(
            scope.rootDir,
            runPrune({
              olderThanDays,
              yes: flags.yes,
              allowShared: flags.allowShared,
              projectId: scope.projectId,
            }),
          );
      yield* reportPrune(report, { yes: flags.yes, json: flags.json });
    }),
).pipe(Command.withDescription("remove environments whose branches are gone (dry-run by default)"));
