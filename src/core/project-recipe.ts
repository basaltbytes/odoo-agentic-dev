import type { PortHashAlgorithm } from "./port-allocator.js";

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
  /** env var name that receives the app's http://localhost:<port> URL */
  readonly urlEnv?: string;
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
  /** leading branch type segments stripped (at most one) before deriving the database name */
  readonly stripBranchPrefixes?: ReadonlyArray<string>;
};

/**
 * Declarative image customization: the CLI generates a Dockerfile from these
 * (FROM odoo:<version>, apt install, pip install, COPY) so projects don't
 * have to maintain one. All host paths are relative to the project root
 * (the docker build context). Mutually exclusive with `odoo.dockerfile`.
 */
export type OdooImageBuildConfig = {
  readonly aptPackages?: ReadonlyArray<string>;
  readonly pipPackages?: ReadonlyArray<string>;
  /** requirements files copied into the image and `pip install -r`-ed */
  readonly pipRequirements?: ReadonlyArray<string>;
  readonly copy?: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  /** raw RUN lines appended after the apt/pip layers (escape hatch, runs as root) */
  readonly run?: ReadonlyArray<string>;
};

/** Default in-image Odoo addons path (the official odoo image layout). */
export const DEFAULT_BASE_ADDONS_PATH = "/usr/lib/python3/dist-packages/odoo/addons";

export type OdooRuntimeConfig = {
  readonly version: string;
  readonly serviceName?: string;
  readonly databaseServiceName?: string;
  readonly postgresImage?: string;
  readonly configFile?: string;
  /** hand-written Dockerfile; prefer `build` and let the CLI generate one */
  readonly dockerfile?: string;
  readonly imageName?: string;
  readonly build?: OdooImageBuildConfig;
  /** `--dev=` value for the dev server (default "xml,reload"); false disables it */
  readonly dev?: string | false;
  /** in-image addons path prepended to the mounts in every --addons-path */
  readonly baseAddonsPath?: string;
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
    /** offset hash over the database name; "posix-cksum" reproduces bash `cksum` tooling */
    readonly hashAlgorithm?: PortHashAlgorithm;
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
  readonly worktree?: {
    /** project-root files copied into a fresh worktree when they exist (e.g. ".env.e2e") */
    readonly copyFiles?: ReadonlyArray<string>;
    /** prefix for the branch `worktree create` makes (default "worktree-") */
    readonly branchPrefix?: string;
  };
  readonly test?: {
    /** profile name → extra odoo CLI args, e.g. { payment: ["--test-tags", "payment"] } */
    readonly profiles?: Readonly<Record<string, ReadonlyArray<string>>>;
  };
  /** compatibility aliases: alias env var name → any assembled env key (canonical or companion portEnv/urlEnv) */
  readonly envAliases?: Readonly<Record<string, string>>;
  readonly companionApps?: ReadonlyArray<CompanionAppConfig>;
  /** stale-environment cleanup: warn by default, prune automatically when auto */
  readonly cleanup?: {
    readonly maxAgeDays?: number;
    readonly auto?: boolean;
  };
};

/** Normalized image build: every list present (possibly empty). */
export type OdooImageBuild = {
  readonly aptPackages: ReadonlyArray<string>;
  readonly pipPackages: ReadonlyArray<string>;
  readonly pipRequirements: ReadonlyArray<string>;
  readonly copy: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly run: ReadonlyArray<string>;
};

/** Normalized config: every default applied, optionals resolved. */
export type OdooAgenticDevConfig = {
  readonly project: {
    readonly id: string;
    readonly dbPrefix: string;
    readonly sharedDatabase: string | null;
    readonly sharedBranches: ReadonlyArray<string>;
    readonly stripBranchPrefixes: ReadonlyArray<string>;
  };
  readonly ports: {
    readonly odooBase: number;
    readonly companionBase: number;
    readonly range: number;
    readonly hashAlgorithm: PortHashAlgorithm;
  };
  readonly odoo: {
    readonly version: string;
    readonly serviceName: string;
    readonly databaseServiceName: string;
    readonly postgresImage: string;
    readonly configFile: string | null;
    readonly dockerfile: string | null;
    readonly imageName: string | null;
    readonly build: OdooImageBuild | null;
    readonly dev: string | false;
    readonly baseAddonsPath: string;
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
  readonly worktree: {
    readonly copyFiles: ReadonlyArray<string>;
    readonly branchPrefix: string;
  };
  readonly test: { readonly profiles: Readonly<Record<string, ReadonlyArray<string>>> };
  readonly envAliases: Readonly<Record<string, string>>;
  readonly companionApps: ReadonlyArray<CompanionAppConfig>;
  readonly cleanup: { readonly maxAgeDays: number; readonly auto: boolean };
};

/**
 * Identity helper preserving literal types. Runtime validation happens when the
 * CLI loads the file (config/schema.ts), so plain JS configs are covered too.
 */
export const defineConfig = (config: OdooAgenticDevConfigInput): OdooAgenticDevConfigInput =>
  config;
