import { createHash } from "node:crypto";
import { basename } from "node:path";
import { ConfigValidationError } from "../errors/errors.js";
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
  readonly databaseName: string;
  readonly composeProjectName: string;
  readonly odooHttpPort: number;
  readonly odooBaseUrl: string;
  readonly companionPorts: ReadonlyMap<string, number>;
  readonly env: Record<string, string>;
};

const resolveEnvDatabase = (env: Record<string, string | undefined>): string | undefined => {
  const primary = env["ODOO_DATABASE"];
  const alias = env["E2E_ODOO_DB"];
  if (primary !== undefined && alias !== undefined && primary !== alias) {
    throw new ConfigValidationError({
      issues: [
        `ODOO_DATABASE ("${primary}") and E2E_ODOO_DB ("${alias}") disagree; unset one of them`,
      ],
    });
  }
  return primary ?? alias;
};

const fallbackWorktreeName = (rootDir: string): string =>
  `${basename(rootDir)}-${createHash("sha256").update(rootDir).digest("hex").slice(0, 8)}`;

export const buildWorktreeContext = (options: {
  readonly rootDir: string;
  readonly recipe: OdooAgenticDevConfig;
  readonly env: Record<string, string | undefined>;
  readonly git: GitState;
}): WorktreeContext => {
  const { env, git, recipe, rootDir } = options;

  const branch = git._tag === "Branch" ? git.branch : undefined;
  const worktreeName = env["ODOO_WORKTREE_NAME"] ?? branch ?? fallbackWorktreeName(rootDir);
  // an explicit ODOO_WORKTREE_NAME also redefines what "branch" means for naming
  const effectiveBranch = env["ODOO_WORKTREE_NAME"] ?? branch;

  const databaseName = deriveDatabaseName({
    branch: effectiveBranch,
    worktreeName,
    dbPrefix: recipe.project.dbPrefix,
    sharedDatabase: recipe.project.sharedDatabase,
    sharedBranches: recipe.project.sharedBranches,
    envDatabase: resolveEnvDatabase(env),
  });

  const { companionPorts, odooHttpPort } = derivePorts({
    databaseName,
    ports: recipe.ports,
    companionApps: recipe.companionApps,
    envHttpPort: env["ODOO_HTTP_PORT"],
  });

  const composeProjectName = deriveComposeProjectName(recipe.project.id, databaseName);
  const odooBaseUrl = `http://127.0.0.1:${odooHttpPort}`;

  const canonical: Record<string, string> = {
    ODOO_DATABASE: databaseName,
    E2E_ODOO_DB: databaseName,
    ODOO_BASE_URL: odooBaseUrl,
    ODOO_HTTP_PORT: String(odooHttpPort),
    ODOO_COMPOSE_PROJECT_NAME: composeProjectName,
  };
  const aliased: Record<string, string> = {};
  for (const [alias, target] of Object.entries(recipe.envAliases)) {
    aliased[alias] = canonical[target]!;
  }

  return {
    rootDir,
    worktreeName,
    databaseName,
    composeProjectName,
    odooHttpPort,
    odooBaseUrl,
    companionPorts,
    env: { ...canonical, ...aliased },
  };
};

/** Replace $NAME tokens with values from `env`; unknown tokens are left intact. */
export const substituteEnvTokens = (value: string, env: Record<string, string>): string =>
  value.replace(/\$([A-Z][A-Z0-9_]*)/g, (token, name: string) => env[name] ?? token);
