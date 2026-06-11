import type { OdooAgenticDevConfig } from "./project-recipe.js";
import type { WorktreeContext } from "./worktree-context.js";

export type ComposeModel = {
  readonly services: Record<string, Record<string, unknown>>;
  readonly volumes: Record<string, Record<string, never>>;
};

export const GENERATED_COMPOSE_RELATIVE_PATH = ".odoo-agentic-dev/compose.generated.yml";

const hostPath = (host: string): string =>
  host.startsWith("/") || host.startsWith("./") || host.startsWith("../") ? host : `./${host}`;

export const buildComposeModel = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
): ComposeModel => {
  const dbService = recipe.odoo.databaseServiceName;
  const odooService = recipe.odoo.serviceName;

  const imageOrBuild: Record<string, unknown> =
    recipe.odoo.dockerfile !== null
      ? {
          build: { context: ".", dockerfile: recipe.odoo.dockerfile },
          ...(recipe.odoo.imageName !== null ? { image: recipe.odoo.imageName } : {}),
        }
      : { image: `odoo:${recipe.odoo.version}` };

  return {
    services: {
      [dbService]: {
        image: recipe.odoo.postgresImage,
        environment: { POSTGRES_USER: "odoo", POSTGRES_PASSWORD: "odoo", POSTGRES_DB: "postgres" },
        healthcheck: {
          test: ["CMD-SHELL", "pg_isready -U odoo -d postgres"],
          interval: "2s",
          timeout: "5s",
          retries: 30,
        },
        volumes: ["db-data:/var/lib/postgresql/data"],
      },
      [odooService]: {
        ...imageOrBuild,
        depends_on: { [dbService]: { condition: "service_healthy" } },
        environment: { HOST: dbService, USER: "odoo", PASSWORD: "odoo" },
        ports: [`${ctx.odooHttpPort}:8069`],
        volumes: [
          "web-data:/var/lib/odoo",
          ...recipe.odoo.addons.map((mount) => `${hostPath(mount.host)}:${mount.container}`),
          ...(recipe.odoo.configFile !== null
            ? [`${hostPath(recipe.odoo.configFile)}:/etc/odoo/odoo.conf`]
            : []),
        ],
      },
    },
    volumes: { "db-data": {}, "web-data": {} },
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
