import { DB_PREFIX_PATTERN } from "../config/schema.js";

// Pure, deterministic derivations + config renderer for `oad init`.
// Every function here is total and side-effect-free (no Effect): the command
// layer (src/commands/init.ts) wraps the impure file IO and proves the result.

const PROJECT_ID_FALLBACK = "odoo-project";
const DB_PREFIX_MAX = 8;

/**
 * A project id from a folder name: lowercase, non-alphanumerics collapse to
 * "-", repeats collapse, leading/trailing "-" trimmed. The id must start with
 * a letter (schema-safe for downstream derivations), so a leading-digit slug
 * gets an "odoo-" prefix. Never empty — falls back to "odoo-project".
 */
export const deriveProjectId = (folderName: string): string => {
  const slug = folderName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0) return PROJECT_ID_FALLBACK;
  return /^[a-z]/.test(slug) ? slug : `odoo-${slug}`;
};

/**
 * A database prefix from a project id: a multi-word ("-"-separated) id becomes
 * the initials of each word (kriss-laure → kl); a single word is truncated to
 * 8 chars. Anything outside [a-z0-9] is stripped, and the result is forced to
 * start with a letter (prefix "db") so it matches DB_PREFIX_PATTERN. Never
 * empty.
 */
export const deriveDbPrefix = (projectId: string): string => {
  const words = projectId.split("-").filter((word) => word.length > 0);
  const raw = words.length > 1 ? words.map((word) => word[0]).join("") : (words[0] ?? "");
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, DB_PREFIX_MAX);
  const prefix = cleaned.length === 0 ? "db" : /^[a-z]/.test(cleaned) ? cleaned : `db${cleaned}`;
  // invariant guard: the patterns above guarantee a match, but keep it total.
  return DB_PREFIX_PATTERN.test(prefix) ? prefix : "db";
};

export type RenderInitConfigOptions = {
  readonly id: string;
  readonly dbPrefix: string;
  readonly odooVersion: string;
  readonly addonsHost: string;
  /** whether the addons host is a placeholder (no ./addons dir found) */
  readonly addonsIsPlaceholder?: boolean;
};

/**
 * Render the scaffolded config file text. Minimal by design — defaults are the
 * product, so only the project identity, the Odoo version, and a single addons
 * mount are emitted. Adjust comments steer the user to the two values they most
 * likely need to change. Deterministic for identical inputs.
 */
export const renderInitConfig = (options: RenderInitConfigOptions): string => {
  const addonsComment =
    options.addonsIsPlaceholder === false ? "" : " // adjust to your addons directory";
  return `import { defineConfig } from "@basaltbytes/odoo-agentic-dev";

export default defineConfig({
  project: {
    id: ${JSON.stringify(options.id)},
    dbPrefix: ${JSON.stringify(options.dbPrefix)},
  },
  odoo: {
    version: ${JSON.stringify(options.odooVersion)}, // adjust to your Odoo version
    addons: [
      { host: ${JSON.stringify(options.addonsHost)}, container: "/mnt/extra-addons/custom" },${addonsComment}
    ],
  },
});
`;
};
