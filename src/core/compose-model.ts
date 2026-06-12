import type { OdooAgenticDevConfig } from "./project-recipe.js";
import type { WorktreeContext } from "./worktree-context.js";
import { containerAddonsPath } from "./command-plan.js";
import { GENERATED_DOCKERFILE_RELATIVE_PATH } from "./dockerfile-model.js";

export type ComposeModel = {
  readonly services: Record<string, Record<string, unknown>>;
  readonly volumes: Record<string, { readonly labels: Record<string, string> }>;
};

export const GENERATED_COMPOSE_RELATIVE_PATH = ".odoo-agentic-dev/compose.generated.yml";

const hostPath = (host: string): string =>
  host.startsWith("/") || host.startsWith("./") || host.startsWith("../") ? host : `./${host}`;

/**
 * Drift-proofing labels stamped on every generated service and volume so
 * `list`/`prune`/`doctor` can reconcile Docker reality against the state
 * registry (and adopt stacks whose rows were lost) without the compose file.
 *
 * Portable mode (for `eject`) keeps the static identity labels but interpolates
 * the database and omits `root-dir`/`branch` (not part of the exported compose
 * env), so the ejected file works across worktrees.
 */
export const buildOadLabels = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
  options?: { readonly portable?: boolean },
): Record<string, string> =>
  options?.portable === true
    ? {
        "dev.basaltbytes.oad": "1",
        "dev.basaltbytes.oad.project-id": recipe.project.id,
        "dev.basaltbytes.oad.database": "${ODOO_DATABASE}",
      }
    : {
        "dev.basaltbytes.oad": "1",
        "dev.basaltbytes.oad.project-id": recipe.project.id,
        "dev.basaltbytes.oad.database": ctx.databaseName,
        "dev.basaltbytes.oad.root-dir": ctx.rootDir,
        "dev.basaltbytes.oad.branch": ctx.branch ?? "",
      };

/**
 * Build the compose model for a worktree.
 *
 * `options.portable` emits compose interpolations (`${KEY:?}`) instead of the
 * current worktree's baked database/port/env literals, so the result is a
 * worktree-independent file the `eject` command can write into a repo.
 * `options.dockerfilePath`, when set, overrides whatever `build.dockerfile`
 * path would otherwise be emitted (eject points it at the ejected Dockerfile).
 */
export const buildComposeModel = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
  options?: { readonly portable?: boolean; readonly dockerfilePath?: string },
): ComposeModel => {
  const portable = options?.portable === true;
  const dbService = recipe.odoo.databaseServiceName;
  const odooService = recipe.odoo.serviceName;
  const labels = buildOadLabels(recipe, ctx, { portable });

  const databaseArg = portable ? "${ODOO_DATABASE:?}" : ctx.databaseName;
  const portMapping = portable
    ? "127.0.0.1:${ODOO_HTTP_PORT:?}:8069"
    : `127.0.0.1:${ctx.odooHttpPort}:8069`;
  // each exported context key resolves at compose runtime via `${KEY:?}`;
  // the static HOST/USER/PASSWORD stay literal in both modes
  const contextEnv: Record<string, string> = portable
    ? Object.fromEntries(Object.keys(ctx.env).map((key) => [key, `\${${key}:?}`]))
    : ctx.env;

  const dockerfile =
    options?.dockerfilePath ??
    recipe.odoo.dockerfile ??
    (recipe.odoo.build !== null ? GENERATED_DOCKERFILE_RELATIVE_PATH : null);
  const imageOrBuild: Record<string, unknown> =
    dockerfile !== null
      ? {
          build: { context: ".", dockerfile },
          ...(recipe.odoo.imageName !== null ? { image: recipe.odoo.imageName } : {}),
        }
      : { image: `odoo:${recipe.odoo.version}` };

  return {
    services: {
      [dbService]: {
        image: recipe.odoo.postgresImage,
        restart: "unless-stopped",
        environment: { POSTGRES_USER: "odoo", POSTGRES_PASSWORD: "odoo", POSTGRES_DB: "postgres" },
        healthcheck: {
          test: ["CMD-SHELL", "pg_isready -U odoo -d postgres"],
          interval: "2s",
          timeout: "5s",
          retries: 30,
        },
        volumes: ["db-data:/var/lib/postgresql/data"],
        labels,
      },
      [odooService]: {
        ...imageOrBuild,
        restart: "unless-stopped",
        depends_on: { [dbService]: { condition: "service_healthy" } },
        // the official image's entrypoint turns HOST/USER/PASSWORD into db args;
        // the full context env rides along for post-init scripts and in-container tests
        environment: { HOST: dbService, USER: "odoo", PASSWORD: "odoo", ...contextEnv },
        // serve exactly this worktree's database, with the db manager hidden
        command: [
          "odoo",
          `--database=${databaseArg}`,
          "--no-database-list",
          `--addons-path=${containerAddonsPath(recipe)}`,
          ...(recipe.odoo.dev === false ? [] : [`--dev=${recipe.odoo.dev}`]),
        ],
        // loopback-only: never expose the dev Odoo on the LAN by default
        ports: [portMapping],
        volumes: [
          "web-data:/var/lib/odoo",
          ...recipe.odoo.addons.map((mount) => `${hostPath(mount.host)}:${mount.container}`),
          ...(recipe.odoo.configFile !== null
            ? [`${hostPath(recipe.odoo.configFile)}:/etc/odoo/odoo.conf`]
            : []),
        ],
        labels,
      },
    },
    volumes: { "db-data": { labels }, "web-data": { labels } },
  };
};

const renderScalar = (value: string | number | boolean): string =>
  typeof value === "string" ? JSON.stringify(value) : String(value);

const renderNode = (node: unknown, indent: number): Array<string> => {
  const pad = "  ".repeat(indent);
  if (Array.isArray(node)) {
    return node.map((item) => `${pad}- ${renderScalar(item as string)}`);
  }
  if (typeof node === "object" && node !== null) {
    return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => {
      if (value === undefined) return [];
      if (typeof value === "object" && value !== null) {
        if (!Array.isArray(value) && Object.keys(value).length === 0) return [`${pad}${key}: {}`];
        return [`${pad}${key}:`, ...renderNode(value, indent + 1)];
      }
      return [`${pad}${key}: ${renderScalar(value as string)}`];
    });
  }
  return [`${pad}${renderScalar(node as string)}`];
};

/** Deterministic hand-rolled YAML for the fixed compose shape (no YAML runtime dep). */
export const renderComposeYaml = (model: ComposeModel): string =>
  renderNode(model, 0).join("\n") + "\n";
