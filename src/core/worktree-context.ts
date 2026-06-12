import { createHash } from "node:crypto";
import { basename } from "node:path";
import { Effect } from "effect";
import { ConfigValidationError } from "../errors/errors.js";
import type { UnsafeDatabaseNameError } from "../errors/errors.js";
import type { OdooAgenticDevConfig } from "./project-recipe.js";
import { deriveDatabaseName } from "./database-name.js";
import { derivePorts } from "./port-allocator.js";
import { deriveComposeProjectName } from "./compose-project.js";

export type GitState =
  | { readonly _tag: "Branch"; readonly branch: string }
  | { readonly _tag: "Detached" }
  | { readonly _tag: "NotARepo" };

export type WorktreeContext = {
  readonly rootDir: string;
  readonly worktreeName: string;
  /** the real git branch; null when detached / not a repo (name overrides don't count) */
  readonly branch: string | null;
  readonly databaseName: string;
  readonly composeProjectName: string;
  readonly odooHttpPort: number;
  readonly odooBaseUrl: string;
  readonly companionPorts: ReadonlyMap<string, number>;
  readonly env: Record<string, string>;
};

/** Shell `[[ -n ]]` semantics: an empty-string env var counts as unset. */
const envValue = (env: Record<string, string | undefined>, key: string): string | undefined => {
  const value = env[key];
  return value === undefined || value === "" ? undefined : value;
};

const resolveEnvDatabase = (
  env: Record<string, string | undefined>,
): Effect.Effect<string | undefined, ConfigValidationError> => {
  const primary = envValue(env, "ODOO_DATABASE");
  const alias = envValue(env, "E2E_ODOO_DB");
  if (primary !== undefined && alias !== undefined && primary !== alias) {
    return Effect.fail(
      new ConfigValidationError({
        issues: [
          `ODOO_DATABASE ("${primary}") and E2E_ODOO_DB ("${alias}") disagree; unset one of them`,
        ],
      }),
    );
  }
  return Effect.succeed(primary ?? alias);
};

const fallbackWorktreeName = (rootDir: string): string =>
  `${basename(rootDir)}-${createHash("sha256").update(rootDir).digest("hex").slice(0, 8)}`;

export const buildWorktreeContext = (options: {
  readonly rootDir: string;
  readonly recipe: OdooAgenticDevConfig;
  readonly env: Record<string, string | undefined>;
  readonly git: GitState;
}): Effect.Effect<WorktreeContext, ConfigValidationError | UnsafeDatabaseNameError> =>
  Effect.gen(function* () {
    const { env, git, recipe, rootDir } = options;

    const branch = git._tag === "Branch" ? git.branch : undefined;
    const nameOverride = envValue(env, "ODOO_WORKTREE_NAME");
    const worktreeName = nameOverride ?? branch ?? fallbackWorktreeName(rootDir);
    // an explicit ODOO_WORKTREE_NAME also redefines what "branch" means for naming
    const effectiveBranch = nameOverride ?? branch;

    const envDatabase = yield* resolveEnvDatabase(env);
    const databaseName = yield* deriveDatabaseName({
      branch: effectiveBranch,
      worktreeName,
      dbPrefix: recipe.project.dbPrefix,
      sharedDatabase: recipe.project.sharedDatabase,
      sharedBranches: recipe.project.sharedBranches,
      stripBranchPrefixes: recipe.project.stripBranchPrefixes,
      envDatabase,
    });

    const { companionPorts, odooHttpPort } = yield* derivePorts({
      databaseName,
      ports: recipe.ports,
      companionApps: recipe.companionApps,
      envHttpPort: envValue(env, "ODOO_HTTP_PORT"),
    });

    const composeProjectName = yield* deriveComposeProjectName(recipe.project.id, databaseName);
    const odooBaseUrl = `http://127.0.0.1:${odooHttpPort}`;

    // env assembly order: canonical → companion vars → aliases
    const assembled: Record<string, string> = {
      ODOO_DATABASE: databaseName,
      E2E_ODOO_DB: databaseName,
      ODOO_BASE_URL: odooBaseUrl,
      ODOO_HTTP_PORT: String(odooHttpPort),
      ODOO_COMPOSE_PROJECT_NAME: composeProjectName,
    };
    for (const app of recipe.companionApps) {
      const port = companionPorts.get(app.name);
      if (port === undefined) continue;
      if (app.portEnv !== undefined) assembled[app.portEnv] = String(port);
      if (app.urlEnv !== undefined) assembled[app.urlEnv] = `http://localhost:${port}`;
    }
    const aliased: Record<string, string> = {};
    for (const [alias, target] of Object.entries(recipe.envAliases)) {
      const value = assembled[target];
      if (value === undefined) {
        return yield* Effect.fail(
          new ConfigValidationError({
            issues: [
              `envAliases: alias "${alias}" targets unknown env key "${target}"; available keys: ${Object.keys(assembled).join(", ")}`,
            ],
          }),
        );
      }
      aliased[alias] = value;
    }

    return {
      rootDir,
      worktreeName,
      branch: branch ?? null,
      databaseName,
      composeProjectName,
      odooHttpPort,
      odooBaseUrl,
      companionPorts,
      env: { ...assembled, ...aliased },
    };
  });

/** Replace $NAME tokens with values from `env`; unknown tokens are left intact. */
export const substituteEnvTokens = (value: string, env: Record<string, string>): string =>
  value.replace(/\$([A-Z][A-Z0-9_]*)/g, (token, name: string) => env[name] ?? token);
