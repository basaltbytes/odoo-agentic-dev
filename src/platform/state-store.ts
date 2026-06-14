import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
// node:sqlite is imported lazily inside StateStoreLive: Node evaluates builtin
// modules before any user module runs, so a static import would emit the
// ExperimentalWarning before cli.ts can install its filter.
import type { DatabaseSync } from "node:sqlite";
import { Context, Effect, Layer } from "effect";
import type { EnvironmentRow } from "../core/environment.js";
import { StateError } from "../errors/errors.js";

/**
 * Upsert payload: the live identity of an environment. Timestamps and template
 * metadata are owned by the store — `created_at`, `template_db` and
 * `template_key` are preserved on existing rows, `last_used_at` is refreshed.
 * `now` exists so tests can inject a fixed clock; callers normally omit it.
 */
export type EnvironmentUpsert = {
  readonly composeProject: string;
  readonly projectId: string;
  readonly databaseName: string;
  readonly rootDir: string;
  readonly worktreeName: string;
  readonly branch: string | null;
  readonly odooHttpPort: number;
  readonly shared: boolean;
  readonly now?: string | undefined;
};

export interface StateStoreApi {
  readonly upsert: (env: EnvironmentUpsert) => Effect.Effect<void, StateError>;
  readonly touch: (composeProject: string) => Effect.Effect<void, StateError>;
  readonly get: (composeProject: string) => Effect.Effect<EnvironmentRow | undefined, StateError>;
  readonly list: (filter: {
    readonly projectId?: string | undefined;
  }) => Effect.Effect<ReadonlyArray<EnvironmentRow>, StateError>;
  readonly remove: (composeProject: string) => Effect.Effect<void, StateError>;
  readonly setTemplate: (
    composeProject: string,
    meta: { readonly databaseName: string; readonly key: string } | null,
  ) => Effect.Effect<void, StateError>;
  readonly setImageBuild: (
    composeProject: string,
    meta: { readonly key: string; readonly builtAt?: string | undefined } | null,
  ) => Effect.Effect<void, StateError>;
}

export const StateStore = Context.Service<StateStoreApi>("odoo-agentic-dev/StateStore");
export const StateDbPath = Context.Reference<string | null>("odoo-agentic-dev/StateDbPath", {
  defaultValue: () => null,
});
type SqliteModule = typeof import("node:sqlite");

const CONFIG_FILENAMES = [
  "odoo-agentic-dev.config.ts",
  "odoo-agentic-dev.config.mts",
  "odoo-agentic-dev.config.js",
  "odoo-agentic-dev.config.mjs",
] as const;

const findNearestConfigDir = (startDir: string): string | null => {
  let dir = resolve(startDir);
  for (;;) {
    for (const filename of CONFIG_FILENAMES) {
      if (existsSync(join(dir, filename))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

export type StateDbTarget = {
  readonly path: string;
  readonly parentDir: string;
  readonly parentExists: boolean;
  readonly parentWritable: boolean;
  readonly override: boolean;
  readonly source: "env-override" | "shared-default" | "local-fallback";
};

export const localStateDbPath = (rootDir: string): string =>
  join(rootDir, ".odoo-agentic-dev", "state.db");

export const sharedStateDbPath = (env: Record<string, string | undefined> = process.env): string =>
  join(env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"), "odoo-agentic-dev", "state.db");

const prepareParent = (path: string): boolean => {
  try {
    const parent = dirname(path);
    mkdirSync(parent, { recursive: true });
    accessSync(parent, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

const defaultLocalStateDbPath = (cwd: string): string =>
  localStateDbPath(findNearestConfigDir(cwd) ?? resolve(cwd));

/**
 * State is shared by default so `list`/`prune` can see sibling worktrees. In a
 * sandbox where the shared location cannot be prepared, fall back to a
 * worktree-local DB. The env override remains absolute authority for tests,
 * CI, and users who intentionally want a specific registry path.
 */
export const resolveStateDbPath = (
  env: Record<string, string | undefined> = process.env,
  options: {
    readonly cwd?: string | undefined;
    readonly rootDir?: string | undefined;
    readonly fallbackPath?: string | undefined;
  } = {},
): string => {
  const override = env["ODOO_AGENTIC_DEV_STATE_DB"];
  if (override !== undefined && override !== "") return override;
  const cwd = options.cwd ?? process.cwd();
  const fallback =
    options.fallbackPath ??
    (options.rootDir !== undefined
      ? localStateDbPath(options.rootDir)
      : defaultLocalStateDbPath(cwd));
  const shared = sharedStateDbPath(env);
  return prepareParent(shared) ? shared : fallback;
};

export const describeStateDbTarget = (
  path: string = resolveStateDbPath(),
  env: Record<string, string | undefined> = process.env,
): StateDbTarget => {
  const parentDir = dirname(path);
  const parentExists = existsSync(parentDir);
  let parentWritable = false;
  if (parentExists) {
    try {
      accessSync(parentDir, constants.W_OK);
      parentWritable = true;
    } catch {
      parentWritable = false;
    }
  }
  const override = env["ODOO_AGENTIC_DEV_STATE_DB"];
  const hasOverride = override !== undefined && override !== "";
  const source = hasOverride
    ? "env-override"
    : path === sharedStateDbPath(env)
      ? "shared-default"
      : "local-fallback";
  return {
    path,
    parentDir,
    parentExists,
    parentWritable,
    override: hasOverride,
    source,
  };
};

export const withStateDbRoot = <A, E, R>(
  rootDir: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => Effect.provideService(effect, StateDbPath, localStateDbPath(rootDir));

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS environments (
  compose_project TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  database_name   TEXT NOT NULL,
  root_dir        TEXT NOT NULL,
  worktree_name   TEXT NOT NULL,
  branch          TEXT,
  odoo_http_port  INTEGER NOT NULL,
  shared          INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  last_used_at    TEXT NOT NULL,
  template_db     TEXT,
  template_key    TEXT,
  image_key       TEXT,
  image_built_at  TEXT
);
INSERT OR IGNORE INTO schema_meta (version) VALUES (1);
`;

const UPSERT_SQL = `
INSERT INTO environments (
  compose_project, project_id, database_name, root_dir, worktree_name,
  branch, odoo_http_port, shared, created_at, last_used_at, template_db, template_key,
  image_key, image_built_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
ON CONFLICT(compose_project) DO UPDATE SET
  project_id     = excluded.project_id,
  database_name  = excluded.database_name,
  root_dir       = excluded.root_dir,
  worktree_name  = excluded.worktree_name,
  branch         = excluded.branch,
  odoo_http_port = excluded.odoo_http_port,
  shared         = excluded.shared,
  last_used_at   = excluded.last_used_at
`;

const toRow = (record: Record<string, unknown>): EnvironmentRow => ({
  composeProject: String(record["compose_project"]),
  projectId: String(record["project_id"]),
  databaseName: String(record["database_name"]),
  rootDir: String(record["root_dir"]),
  worktreeName: String(record["worktree_name"]),
  branch: record["branch"] === null ? null : String(record["branch"]),
  odooHttpPort: Number(record["odoo_http_port"]),
  shared: Number(record["shared"]) !== 0,
  createdAt: String(record["created_at"]),
  lastUsedAt: String(record["last_used_at"]),
  templateDb: record["template_db"] === null ? null : String(record["template_db"]),
  templateKey: record["template_key"] === null ? null : String(record["template_key"]),
  imageKey: record["image_key"] === null ? null : String(record["image_key"]),
  imageBuiltAt: record["image_built_at"] === null ? null : String(record["image_built_at"]),
});

const migrateSchema = (db: DatabaseSync) => {
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(environments)")
      .all()
      .map((record) => String((record as Record<string, unknown>)["name"])),
  );
  if (!columns.has("image_key")) {
    db.exec("ALTER TABLE environments ADD COLUMN image_key TEXT;");
  }
  if (!columns.has("image_built_at")) {
    db.exec("ALTER TABLE environments ADD COLUMN image_built_at TEXT;");
  }
};

// All effects happen lazily per-operation inside withDb (open → run → close,
// so parallel agent sessions never hold the registry open); building the
// service itself is pure.
export const StateStoreLive = Layer.effect(
  StateStore,
  Effect.sync(() => {
    const attempt = <A>(
      label: string,
      path: string,
      thunk: () => A,
    ): Effect.Effect<A, StateError> =>
      Effect.try({
        try: thunk,
        catch: (cause) => {
          const target = describeStateDbTarget(path);
          return new StateError({
            reason: `${label}: ${String(cause)}`,
            path: target.path,
            parentDir: target.parentDir,
            parentExists: target.parentExists,
            parentWritable: target.parentWritable,
          });
        },
      });

    let sqlitePromise: Promise<SqliteModule> | undefined;
    const loadSqlite = (): Effect.Effect<SqliteModule, StateError> =>
      Effect.tryPromise({
        try: () => {
          sqlitePromise ??= import("node:sqlite");
          return sqlitePromise;
        },
        catch: (cause) => new StateError({ reason: `loading node:sqlite: ${String(cause)}` }),
      });

    const withDb = <A>(
      label: string,
      thunk: (db: DatabaseSync) => A,
    ): Effect.Effect<A, StateError> =>
      Effect.gen(function* () {
        const sqlite = yield* loadSqlite();
        const scopedPath = yield* StateDbPath;
        const path = resolveStateDbPath(process.env, { fallbackPath: scopedPath ?? undefined });
        return yield* attempt(label, path, () => {
          mkdirSync(dirname(path), { recursive: true });
          const db = new sqlite.DatabaseSync(path, { timeout: 5000 });
          try {
            db.exec("PRAGMA busy_timeout=5000;");
            db.exec("PRAGMA journal_mode=WAL;");
            db.exec(SCHEMA_SQL);
            migrateSchema(db);
            return thunk(db);
          } finally {
            db.close();
          }
        });
      });

    return {
      upsert: (env) =>
        withDb("upsert", (db) => {
          const now = env.now ?? new Date().toISOString();
          db.prepare(UPSERT_SQL).run(
            env.composeProject,
            env.projectId,
            env.databaseName,
            env.rootDir,
            env.worktreeName,
            env.branch,
            env.odooHttpPort,
            env.shared ? 1 : 0,
            now,
            now,
          );
        }),
      touch: (composeProject) =>
        withDb("touch", (db) => {
          db.prepare("UPDATE environments SET last_used_at = ? WHERE compose_project = ?").run(
            new Date().toISOString(),
            composeProject,
          );
        }),
      get: (composeProject) =>
        withDb("get", (db) => {
          const record = db
            .prepare("SELECT * FROM environments WHERE compose_project = ?")
            .get(composeProject);
          return record === undefined ? undefined : toRow(record);
        }),
      list: (filter) =>
        withDb("list", (db) => {
          const records =
            filter.projectId === undefined
              ? db.prepare("SELECT * FROM environments ORDER BY compose_project").all()
              : db
                  .prepare(
                    "SELECT * FROM environments WHERE project_id = ? ORDER BY compose_project",
                  )
                  .all(filter.projectId);
          return records.map(toRow);
        }),
      remove: (composeProject) =>
        withDb("remove", (db) => {
          db.prepare("DELETE FROM environments WHERE compose_project = ?").run(composeProject);
        }),
      setTemplate: (composeProject, meta) =>
        withDb("setTemplate", (db) => {
          db.prepare(
            "UPDATE environments SET template_db = ?, template_key = ? WHERE compose_project = ?",
          ).run(meta?.databaseName ?? null, meta?.key ?? null, composeProject);
        }),
      setImageBuild: (composeProject, meta) =>
        withDb("setImageBuild", (db) => {
          db.prepare(
            "UPDATE environments SET image_key = ?, image_built_at = ? WHERE compose_project = ?",
          ).run(
            meta?.key ?? null,
            meta === null ? null : (meta.builtAt ?? new Date().toISOString()),
            composeProject,
          );
        }),
    };
  }),
);
