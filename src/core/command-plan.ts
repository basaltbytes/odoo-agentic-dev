import type { OdooAgenticDevConfig, PostInitHook } from "./project-recipe.js";
import { substituteEnvTokens } from "./worktree-context.js";

// All database names reaching these builders have passed assertSafeDatabaseName
// (^[a-z][a-z0-9_]*$), which is what makes the string interpolation safe.

/**
 * In-container `--addons-path`: the image's base addons plus every configured
 * mount. Passed on every odoo invocation so projects need no odoo.conf for it.
 */
export const containerAddonsPath = (recipe: OdooAgenticDevConfig): string =>
  [recipe.odoo.baseAddonsPath, ...recipe.odoo.addons.map((mount) => mount.container)].join(",");

export const psqlArgs = (dbService: string, sql: string): Array<string> => [
  "exec",
  "-T",
  dbService,
  "psql",
  "-U",
  "odoo",
  "-d",
  "postgres",
  "-v",
  "ON_ERROR_STOP=1",
  "-c",
  sql,
];

export const terminateSessionsSql = (databaseName: string): string =>
  `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${databaseName}' AND pid <> pg_backend_pid()`;

export const dropDatabaseSql = (databaseName: string): string =>
  `DROP DATABASE IF EXISTS "${databaseName}"`;

export const createDatabaseSql = (databaseName: string): string =>
  `CREATE DATABASE "${databaseName}" OWNER "odoo"`;

export const createFromTemplateSql = (databaseName: string, templateName: string): string =>
  `CREATE DATABASE "${databaseName}" TEMPLATE "${templateName}"`;

/** Replace `to`'s filestore with a copy of `from`'s (guarded: `from` may not exist). */
export const copyFilestoreArgs = (odooService: string, from: string, to: string): Array<string> => [
  "run",
  "--rm",
  "--no-deps",
  "--entrypoint",
  "/bin/sh",
  odooService,
  "-c",
  `rm -rf /var/lib/odoo/filestore/${to} && if [ -d /var/lib/odoo/filestore/${from} ]; then cp -a /var/lib/odoo/filestore/${from} /var/lib/odoo/filestore/${to}; fi`,
];

export const removeFilestoreArgs = (odooService: string, databaseName: string): Array<string> => [
  "run",
  "--rm",
  "--no-deps",
  "--entrypoint",
  "/bin/sh",
  odooService,
  "-c",
  `rm -rf /var/lib/odoo/filestore/${databaseName}`,
];

export const odooInitArgs = (
  odooService: string,
  databaseName: string,
  addonsPath: string,
  modules: ReadonlyArray<string>,
  withoutDemo: string | false,
): Array<string> => [
  "run",
  "--rm",
  odooService,
  "odoo",
  "-d",
  databaseName,
  `--addons-path=${addonsPath}`,
  "-i",
  (modules.length > 0 ? modules : ["base"]).join(","),
  ...(withoutDemo === false ? [] : [`--without-demo=${withoutDemo}`]),
  "--stop-after-init",
];

export const odooUpdateArgs = (
  odooService: string,
  databaseName: string,
  addonsPath: string,
  modules: ReadonlyArray<string>,
): Array<string> => [
  "run",
  "--rm",
  odooService,
  "odoo",
  "-d",
  databaseName,
  `--addons-path=${addonsPath}`,
  "-u",
  modules.join(","),
  "--stop-after-init",
];

export const odooShellArgs = (
  odooService: string,
  databaseName: string,
  addonsPath: string,
): Array<string> => [
  "run",
  "--rm",
  "-T",
  odooService,
  "odoo",
  "shell",
  "-d",
  databaseName,
  `--addons-path=${addonsPath}`,
  "--no-http",
];

export type OdooTestOptions = {
  readonly tags?: string | undefined;
  readonly file?: string | undefined;
  readonly module?: string | undefined;
  readonly logLevel?: string | undefined;
  readonly extraArgs?: ReadonlyArray<string> | undefined;
};

export const odooTestArgs = (
  odooService: string,
  databaseName: string,
  addonsPath: string,
  options: OdooTestOptions,
): Array<string> => [
  "run",
  "--rm",
  odooService,
  "odoo",
  "-d",
  databaseName,
  `--addons-path=${addonsPath}`,
  "--test-enable",
  ...(options.tags !== undefined ? ["--test-tags", options.tags] : []),
  ...(options.file !== undefined ? ["--test-file", options.file] : []),
  ...(options.module !== undefined ? ["--test-tags", `/${options.module}`] : []),
  ...(options.logLevel !== undefined ? ["--log-level", options.logLevel] : []),
  ...(options.extraArgs ?? []),
  "--stop-after-init",
];

const pythonString = (value: string): string => JSON.stringify(value);

export const setIrConfigParameterCode = (key: string, value: string): string =>
  [
    `env["ir.config_parameter"].sudo().set_param(${pythonString(key)}, ${pythonString(value)})`,
    "env.cr.commit()",
  ].join("\n");

export type ExpandedHook =
  | { readonly kind: "odoo-shell"; readonly code: string }
  | { readonly kind: "odoo-shell-file"; readonly file: string }
  | {
      readonly kind: "host-command";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly cwd: string | undefined;
    };

export const expandHook = (hook: PostInitHook, env: Record<string, string> = {}): ExpandedHook => {
  switch (hook.type) {
    case "odoo-shell-file":
      return { kind: "odoo-shell-file", file: hook.file };
    case "odoo-shell-inline":
      return { kind: "odoo-shell", code: hook.code };
    case "set-ir-config-parameter":
      return {
        kind: "odoo-shell",
        code: setIrConfigParameterCode(hook.key, substituteEnvTokens(hook.value, env)),
      };
    case "command":
      return { kind: "host-command", command: hook.command, args: hook.args, cwd: hook.cwd };
  }
};
