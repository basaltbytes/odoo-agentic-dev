export const CANONICAL_ENV_VARS = [
  "ODOO_DATABASE",
  "E2E_ODOO_DB",
  "ODOO_BASE_URL",
  "ODOO_HTTP_PORT",
  "ODOO_COMPOSE_PROJECT_NAME",
] as const;
export type CanonicalEnvVar = (typeof CANONICAL_ENV_VARS)[number];

export type OdooAddonMount = {
  readonly host: string;
  readonly container: string;
  /** allow host paths outside the project root (default false) */
  readonly allowOutsideRepo?: boolean;
};

export type PostInitHook =
  | { readonly type: "odoo-shell-file"; readonly file: string }
  | { readonly type: "odoo-shell-inline"; readonly code: string }
  | { readonly type: "set-ir-config-parameter"; readonly key: string; readonly value: string }
  | {
      readonly type: "command";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly cwd?: string;
    };

export type CompanionAppConfig = {
  readonly name: string;
  readonly cwd: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** env var name that receives the allocated port */
  readonly portEnv?: string;
  /** extra env; values may reference canonical vars as "$ODOO_DATABASE" etc. */
  readonly env?: Readonly<Record<string, string>>;
};

export type PackageManagerStep = {
  readonly cwd: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
};

export type OdooProjectConfig = {
  readonly id: string;
  readonly dbPrefix: string;
  readonly sharedDatabase?: string;
  readonly sharedBranches?: ReadonlyArray<string>;
};

export type OdooRuntimeConfig = {
  readonly version: string;
  readonly serviceName?: string;
  readonly databaseServiceName?: string;
  readonly postgresImage?: string;
  readonly configFile?: string;
  readonly dockerfile?: string;
  readonly imageName?: string;
  readonly addons: ReadonlyArray<OdooAddonMount>;
  /** path to a local Odoo source checkout, or "docker-only" */
  readonly source?: string;
};

export type OdooDatabaseConfig = {
  readonly initialModules?: ReadonlyArray<string>;
  /** Odoo --without-demo value; false disables the flag entirely */
  readonly withoutDemo?: string | false;
  readonly postInit?: ReadonlyArray<PostInitHook>;
};

export type OdooAgenticDevConfigInput = {
  readonly project: OdooProjectConfig;
  readonly ports?: {
    readonly odooBase?: number;
    readonly companionBase?: number;
    readonly range?: number;
  };
  readonly odoo: OdooRuntimeConfig;
  readonly database?: OdooDatabaseConfig;
  readonly setup?: {
    readonly submodules?: boolean;
    readonly packageManagers?: ReadonlyArray<PackageManagerStep>;
  };
  readonly compose?: {
    /** escape hatch: project-supplied compose file instead of the generated one */
    readonly file?: string;
  };
  readonly test?: {
    /** profile name → extra odoo CLI args, e.g. { payment: ["--test-tags", "payment"] } */
    readonly profiles?: Readonly<Record<string, ReadonlyArray<string>>>;
  };
  /** compatibility aliases: alias env var name → canonical variable */
  readonly envAliases?: Readonly<Record<string, CanonicalEnvVar>>;
  readonly companionApps?: ReadonlyArray<CompanionAppConfig>;
};

/** Normalized config: every default applied, optionals resolved. */
export type OdooAgenticDevConfig = {
  readonly project: {
    readonly id: string;
    readonly dbPrefix: string;
    readonly sharedDatabase: string | null;
    readonly sharedBranches: ReadonlyArray<string>;
  };
  readonly ports: {
    readonly odooBase: number;
    readonly companionBase: number;
    readonly range: number;
  };
  readonly odoo: {
    readonly version: string;
    readonly serviceName: string;
    readonly databaseServiceName: string;
    readonly postgresImage: string;
    readonly configFile: string | null;
    readonly dockerfile: string | null;
    readonly imageName: string | null;
    readonly addons: ReadonlyArray<OdooAddonMount>;
    readonly source: string | null;
  };
  readonly database: {
    readonly initialModules: ReadonlyArray<string>;
    readonly withoutDemo: string | false;
    readonly postInit: ReadonlyArray<PostInitHook>;
  };
  readonly setup: {
    readonly submodules: boolean;
    readonly packageManagers: ReadonlyArray<PackageManagerStep>;
  };
  readonly compose: { readonly file: string | null };
  readonly test: { readonly profiles: Readonly<Record<string, ReadonlyArray<string>>> };
  readonly envAliases: Readonly<Record<string, CanonicalEnvVar>>;
  readonly companionApps: ReadonlyArray<CompanionAppConfig>;
};

/**
 * Identity helper preserving literal types. Runtime validation happens when the
 * CLI loads the file (config/schema.ts), so plain JS configs are covered too.
 */
export const defineOdooAgenticDevConfig = (
  config: OdooAgenticDevConfigInput,
): OdooAgenticDevConfigInput => config;
