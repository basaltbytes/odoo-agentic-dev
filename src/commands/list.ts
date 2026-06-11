import { basename } from "node:path";
import { Console, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { classifyEnvironments } from "../core/environment.js";
import type { EnvironmentRow, EnvStatus } from "../core/environment.js";
import type { StateError } from "../errors/errors.js";
import { DockerCompose } from "../platform/docker-compose.js";
import type {
  ComposeProject,
  DockerComposeApi,
  LabeledContainer,
} from "../platform/docker-compose.js";
import { StateStore } from "../platform/state-store.js";
import type { StateStoreApi } from "../platform/state-store.js";
import { resolveProjectId } from "./resolve-context.js";

export type ListEntry = {
  readonly row: EnvironmentRow;
  readonly status: EnvStatus;
};

/** Coarse relative age for table output; unparseable timestamps read as fresh. */
export const relativeAge = (iso: string, nowIso: string): string => {
  const ms = Date.parse(nowIso) - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

const flagsCell = (row: EnvironmentRow): string => {
  const flags = [row.shared ? "shared" : null, row.templateDb !== null ? "template" : null].filter(
    (flag): flag is string => flag !== null,
  );
  return flags.length === 0 ? "-" : flags.join(" ");
};

/** Plain padded-column table (no table dependency). */
export const buildListTable = (entries: ReadonlyArray<ListEntry>, nowIso: string): string => {
  const header = ["WORKTREE", "DATABASE", "PORT", "STATUS", "LAST USED", "FLAGS"];
  const body = entries.map(({ row, status }) => [
    row.worktreeName,
    row.databaseName,
    // adopted rows carry port 0: the labels do not record the port
    row.odooHttpPort === 0 ? "?" : String(row.odooHttpPort),
    status,
    relativeAge(row.lastUsedAt, nowIso),
    flagsCell(row),
  ]);
  const widths = header.map((cell, i) => Math.max(cell.length, ...body.map((r) => r[i]!.length)));
  return [header, ...body]
    .map((cells) =>
      cells
        .map((cell, i) => cell.padEnd(widths[i]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
};

const adoptionUpsert = (stack: LabeledContainer) =>
  stack.projectId === null || stack.database === null || stack.rootDir === null
    ? null
    : {
        composeProject: stack.composeProject,
        projectId: stack.projectId,
        databaseName: stack.database,
        rootDir: stack.rootDir,
        // the branch label is "" for "no branch" — map it back to null
        worktreeName:
          stack.branch !== null && stack.branch !== "" ? stack.branch : basename(stack.rootDir),
        branch: stack.branch === "" ? null : stack.branch,
        odooHttpPort: 0,
        shared: false,
      };

/**
 * State rows reconciled against docker reality. Labeled stacks unknown to the
 * registry are adopted (inserted best-effort from their labels) before
 * listing. When docker itself is unreachable the registry is still listed,
 * with every stack necessarily reading as `vanished` — callers should warn.
 */
export const collectListEntries = (
  projectId: string | undefined,
): Effect.Effect<
  { readonly entries: ReadonlyArray<ListEntry>; readonly dockerAvailable: boolean },
  StateError,
  StateStoreApi | DockerComposeApi
> =>
  Effect.gen(function* () {
    const store = yield* StateStore;
    const compose = yield* DockerCompose;
    const docker = yield* Effect.all([
      compose.listProjects(),
      compose.listLabeledContainers(),
    ]).pipe(
      Effect.map(([projects, labeled]) => ({ projects, labeled, available: true })),
      Effect.catch(() =>
        Effect.succeed({
          projects: [] as ReadonlyArray<ComposeProject>,
          labeled: [] as ReadonlyArray<LabeledContainer>,
          available: false,
        }),
      ),
    );

    const known = new Set((yield* store.list({})).map((row) => row.composeProject));
    for (const stack of docker.labeled) {
      if (known.has(stack.composeProject)) continue;
      const upsert = adoptionUpsert(stack);
      if (upsert !== null) yield* store.upsert(upsert);
    }

    const rows = yield* store.list({ projectId });
    const classified = classifyEnvironments({
      rows,
      dockerProjects: docker.projects,
      probes: new Map(),
      olderThanDays: null,
      allowShared: true,
      now: new Date().toISOString(),
    });
    return {
      entries: classified.map(({ row, status }) => ({ row, status })),
      dockerAvailable: docker.available,
    };
  });

export const listCommand = Command.make(
  "list",
  {
    allProjects: Flag.boolean("all-projects").pipe(
      Flag.withDescription("every project in the registry (works without a config)"),
    ),
    json: Flag.boolean("json").pipe(Flag.withDescription("print machine-readable JSON")),
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    Effect.gen(function* () {
      const projectId = yield* resolveProjectId(flags.config, flags.allProjects);
      const { dockerAvailable, entries } = yield* collectListEntries(projectId);
      if (!dockerAvailable) {
        yield* Console.error("warning: docker is unreachable — every stack reads as vanished");
      }
      if (flags.json) {
        yield* Console.log(
          JSON.stringify(
            entries.map(({ row, status }) => ({ ...row, status })),
            null,
            2,
          ),
        );
      } else if (entries.length === 0) {
        yield* Console.log("No environments recorded.");
      } else {
        yield* Console.log(buildListTable(entries, new Date().toISOString()));
      }
    }),
);
