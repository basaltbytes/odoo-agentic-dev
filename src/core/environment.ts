import { createHash } from "node:crypto";
import type { OdooAgenticDevConfig } from "./project-recipe.js";

/**
 * One row of the global state registry's `environments` table (camelCase
 * mirror of the SQL schema). Nullable columns are `T | null`, never optional,
 * so rows survive `exactOptionalPropertyTypes` round-trips through SQLite.
 */
export type EnvironmentRow = {
  readonly composeProject: string;
  readonly projectId: string;
  readonly databaseName: string;
  readonly rootDir: string;
  readonly worktreeName: string;
  /** null when detached / not a repo */
  readonly branch: string | null;
  readonly odooHttpPort: number;
  readonly shared: boolean;
  /** ISO 8601 UTC */
  readonly createdAt: string;
  /** ISO 8601 UTC */
  readonly lastUsedAt: string;
  /** e.g. kl_feature_x__tpl */
  readonly templateDb: string | null;
  /** hash of (modules, withoutDemo, odoo.version, postInit) */
  readonly templateKey: string | null;
};

export const TEMPLATE_SUFFIX = "__tpl";

/**
 * Longest database name that still fits `TEMPLATE_SUFFIX` within PostgreSQL's
 * 63-char identifier limit. Derived names are truncated to this budget;
 * explicit overrides may exceed it and then simply skip template snapshots.
 */
export const TEMPLATE_BASE_NAME_BUDGET = 58;

export const templateDbName = (db: string): string => `${db}${TEMPLATE_SUFFIX}`;

/**
 * Identity of a template snapshot: everything baked into the database by a
 * full init (modules, demo data, Odoo version, post-init hooks, and the Odoo
 * image identity). Any change here must invalidate existing snapshots.
 */
export const computeTemplateKey = (
  recipe: OdooAgenticDevConfig,
  imageInputsHash: string | null = null,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        recipe.database.initialModules,
        recipe.database.withoutDemo,
        recipe.odoo.version,
        recipe.database.postInit,
        recipe.odoo.baseAddonsPath,
        recipe.odoo.addons,
        recipe.odoo.configFile,
        recipe.odoo.build,
        recipe.odoo.dockerfile,
        recipe.odoo.imageName,
        imageInputsHash,
      ]),
    )
    .digest("hex")
    .slice(0, 8);

export type EnvStatus = "running" | "stopped" | "vanished";

export type PruneReason =
  | "keep"
  | "gone-branch"
  | "gone-rootdir"
  | "vanished"
  | "stale"
  | "shared-skipped";

/** Filesystem/git facts about a row, gathered by the caller (IO stays there). */
export type EnvironmentProbe = {
  readonly rootDirExists: boolean;
  /** null = not a repo / no branch recorded — the branch rule does not apply */
  readonly branchExists: boolean | null;
};

export type ClassifiedEnvironment = {
  readonly row: EnvironmentRow;
  readonly status: EnvStatus;
  readonly reason: PruneReason;
};

const DAY_MS = 86_400_000;

/**
 * Pure prune/list decision. Docker is the truth for status; prune reasons are
 * evaluated in strict priority order: shared shield, vanished stack, deleted
 * root dir, deleted branch, staleness (only when `olderThanDays` is set).
 * Rows with no probe entry are conservatively kept.
 */
export const classifyEnvironments = (input: {
  readonly rows: ReadonlyArray<EnvironmentRow>;
  readonly dockerProjects: ReadonlyArray<{ readonly name: string; readonly running: boolean }>;
  readonly probes: ReadonlyMap<string, EnvironmentProbe>;
  readonly olderThanDays: number | null;
  readonly allowShared: boolean;
  /** ISO 8601 UTC */
  readonly now: string;
}): ReadonlyArray<ClassifiedEnvironment> => {
  const dockerByName = new Map(input.dockerProjects.map((p) => [p.name, p.running]));
  const nowMs = Date.parse(input.now);

  return input.rows.map((row) => {
    const running = dockerByName.get(row.composeProject);
    const status: EnvStatus = running === undefined ? "vanished" : running ? "running" : "stopped";
    const probe = input.probes.get(row.composeProject) ?? {
      rootDirExists: true,
      branchExists: null,
    };
    const stale =
      input.olderThanDays !== null &&
      nowMs - Date.parse(row.lastUsedAt) > input.olderThanDays * DAY_MS;

    const reason: PruneReason =
      row.shared && !input.allowShared
        ? "shared-skipped"
        : status === "vanished"
          ? "vanished"
          : !probe.rootDirExists
            ? "gone-rootdir"
            : probe.branchExists === false
              ? "gone-branch"
              : stale
                ? "stale"
                : "keep";

    return { row, status, reason };
  });
};

export type ResetPath = "restore" | "full" | "full-then-snapshot";

/**
 * Pure reset-path decision for `reset-db`/`setup`. Snapshots are only ever
 * planned for names within `TEMPLATE_BASE_NAME_BUDGET` — over-budget names
 * (explicit overrides) degrade every snapshot outcome to a plain `full`.
 */
export const decideResetPath = (input: {
  readonly row: EnvironmentRow | undefined;
  readonly expectedKey: string;
  readonly databaseName: string;
  readonly noTemplate: boolean;
  readonly refreshTemplate: boolean;
  readonly hasOverrides: boolean;
}): ResetPath => {
  const snapshotFits = input.databaseName.length <= TEMPLATE_BASE_NAME_BUDGET;
  if (input.hasOverrides) return "full";
  if (input.refreshTemplate) return snapshotFits ? "full-then-snapshot" : "full";
  if (input.noTemplate) return "full";
  if (
    input.row !== undefined &&
    input.row.templateDb !== null &&
    input.row.templateKey === input.expectedKey &&
    snapshotFits
  ) {
    return "restore";
  }
  return snapshotFits ? "full-then-snapshot" : "full";
};
