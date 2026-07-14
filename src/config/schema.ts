import { Effect, Schema } from "effect";
import { ConfigValidationError } from "../errors/errors.js";
import type { OdooAgenticDevConfig, OdooAgenticDevConfigInput } from "../core/project-recipe.js";
import { DEFAULT_BASE_ADDONS_PATH } from "../core/project-recipe.js";
import { DEFAULT_STRIP_BRANCH_PREFIXES } from "../core/database-name.js";

const AddonMountSchema = Schema.Struct({
  host: Schema.String,
  container: Schema.String,
  allowOutsideRepo: Schema.optional(Schema.Boolean),
});

const HookSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("odoo-shell-file"), file: Schema.String }),
  Schema.Struct({ type: Schema.Literal("odoo-shell-inline"), code: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("set-ir-config-parameter"),
    key: Schema.String,
    value: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("command"),
    command: Schema.String,
    args: Schema.Array(Schema.String),
    cwd: Schema.optional(Schema.String),
  }),
]);

const CompanionAppSchema = Schema.Struct({
  name: Schema.String,
  cwd: Schema.String,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  portEnv: Schema.optional(Schema.String),
  urlEnv: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const ConfigInputSchema = Schema.Struct({
  project: Schema.Struct({
    id: Schema.String,
    dbPrefix: Schema.String,
    sharedDatabase: Schema.optional(Schema.String),
    sharedBranches: Schema.optional(Schema.Array(Schema.String)),
    stripBranchPrefixes: Schema.optional(Schema.Array(Schema.String)),
  }),
  ports: Schema.optional(
    Schema.Struct({
      odooBase: Schema.optional(Schema.Number),
      companionBase: Schema.optional(Schema.Number),
      range: Schema.optional(Schema.Number),
      hashAlgorithm: Schema.optional(Schema.Literals(["fnv1a32", "posix-cksum"])),
    }),
  ),
  odoo: Schema.Struct({
    version: Schema.String,
    serviceName: Schema.optional(Schema.String),
    databaseServiceName: Schema.optional(Schema.String),
    postgresImage: Schema.optional(Schema.String),
    configFile: Schema.optional(Schema.String),
    dockerfile: Schema.optional(Schema.String),
    imageName: Schema.optional(Schema.String),
    build: Schema.optional(
      Schema.Struct({
        aptPackages: Schema.optional(Schema.Array(Schema.String)),
        pipPackages: Schema.optional(Schema.Array(Schema.String)),
        pipRequirements: Schema.optional(Schema.Array(Schema.String)),
        copy: Schema.optional(
          Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })),
        ),
        run: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
    dev: Schema.optional(Schema.Union([Schema.String, Schema.Literal(false)])),
    baseAddonsPath: Schema.optional(Schema.String),
    addons: Schema.Array(AddonMountSchema),
    source: Schema.optional(Schema.String),
  }),
  database: Schema.optional(
    Schema.Struct({
      initialModules: Schema.optional(Schema.Array(Schema.String)),
      withoutDemo: Schema.optional(Schema.Union([Schema.String, Schema.Literal(false)])),
      template: Schema.optional(Schema.Boolean),
      postInit: Schema.optional(Schema.Array(HookSchema)),
    }),
  ),
  setup: Schema.optional(
    Schema.Struct({
      submodules: Schema.optional(Schema.Boolean),
      packageManagers: Schema.optional(
        Schema.Array(
          Schema.Struct({
            cwd: Schema.String,
            command: Schema.String,
            args: Schema.Array(Schema.String),
          }),
        ),
      ),
    }),
  ),
  compose: Schema.optional(Schema.Struct({ file: Schema.optional(Schema.String) })),
  worktree: Schema.optional(
    Schema.Struct({
      copyFiles: Schema.optional(Schema.Array(Schema.String)),
      branchPrefix: Schema.optional(Schema.String),
    }),
  ),
  test: Schema.optional(
    Schema.Struct({
      profiles: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
    }),
  ),
  // alias targets are validated against the assembled env at context-build
  // time (companion portEnv/urlEnv keys are legal targets, not just canonical)
  envAliases: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  companionApps: Schema.optional(Schema.Array(CompanionAppSchema)),
  cleanup: Schema.optional(
    Schema.Struct({
      maxAgeDays: Schema.optional(Schema.Number),
      auto: Schema.optional(Schema.Boolean),
    }),
  ),
});

/** Structural validation. Fails with ConfigValidationError carrying readable issues. */
export const validateConfigInput = (
  input: unknown,
): Effect.Effect<OdooAgenticDevConfigInput, ConfigValidationError> =>
  Schema.decodeUnknownEffect(ConfigInputSchema)(input).pipe(
    Effect.mapError((error) => new ConfigValidationError({ issues: [error.message] })),
    // exactOptionalPropertyTypes: the decoded optional props are `?: T | undefined`
    // while the public input type declares `?: T`, so the cast must stay.
    Effect.map((decoded) => decoded as OdooAgenticDevConfigInput),
  );

export const DB_PREFIX_PATTERN = /^[a-z][a-z0-9]*$/;
export const COMPANION_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Defaults + cross-field rules. Fails with one ConfigValidationError listing every issue. */
export const normalizeConfig = (
  input: OdooAgenticDevConfigInput,
): Effect.Effect<OdooAgenticDevConfig, ConfigValidationError> => {
  const issues: Array<string> = [];

  if (!DB_PREFIX_PATTERN.test(input.project.dbPrefix)) {
    issues.push(`project.dbPrefix "${input.project.dbPrefix}" must match ${DB_PREFIX_PATTERN}`);
  }

  const ports = {
    odooBase: input.ports?.odooBase ?? 18069,
    companionBase: input.ports?.companionBase ?? 28000,
    range: input.ports?.range ?? 1000,
    hashAlgorithm: input.ports?.hashAlgorithm ?? ("fnv1a32" as const),
  };
  if (!Number.isInteger(ports.range) || ports.range < 10) {
    issues.push(`ports.range must be an integer >= 10, got ${ports.range}`);
  }
  for (const [key, value] of [
    ["odooBase", ports.odooBase],
    ["companionBase", ports.companionBase],
  ] as const) {
    if (!Number.isInteger(value) || value < 1024 || value + ports.range > 65535) {
      issues.push(`ports.${key} must keep the whole range within 1024..65535, got ${value}`);
    }
  }

  const seenContainers = new Set<string>();
  for (const mount of input.odoo.addons) {
    if (seenContainers.has(mount.container)) {
      issues.push(`duplicate addon container mount path: ${mount.container}`);
    }
    seenContainers.add(mount.container);
    const escapesRepo =
      mount.host.startsWith("/") || mount.host === ".." || mount.host.startsWith("../");
    if (escapesRepo && mount.allowOutsideRepo !== true) {
      issues.push(
        `addon host path "${mount.host}" is outside the repo; set allowOutsideRepo: true to permit it`,
      );
    }
  }
  if (input.odoo.addons.length === 0) issues.push("odoo.addons must not be empty");

  const companionNames = new Set<string>();
  for (const app of input.companionApps ?? []) {
    if (!COMPANION_NAME_PATTERN.test(app.name)) {
      issues.push(`companion app name "${app.name}" must match ${COMPANION_NAME_PATTERN}`);
    }
    if (companionNames.has(app.name)) issues.push(`duplicate companion app name: ${app.name}`);
    companionNames.add(app.name);
  }

  const cleanupMaxAgeDays = input.cleanup?.maxAgeDays;
  if (
    cleanupMaxAgeDays !== undefined &&
    (!Number.isInteger(cleanupMaxAgeDays) || cleanupMaxAgeDays < 1)
  ) {
    issues.push(`cleanup.maxAgeDays must be an integer >= 1, got ${cleanupMaxAgeDays}`);
  }

  if (
    (input.project.sharedBranches?.length ?? 0) > 0 &&
    input.project.sharedDatabase === undefined
  ) {
    issues.push("project.sharedBranches is set but project.sharedDatabase is missing");
  }

  if (input.odoo.build !== undefined) {
    if (input.odoo.dockerfile !== undefined) {
      issues.push("odoo.build and odoo.dockerfile are mutually exclusive — pick one");
    }
    const build = input.odoo.build;
    const hasContent =
      (build.aptPackages?.length ?? 0) > 0 ||
      (build.pipPackages?.length ?? 0) > 0 ||
      (build.pipRequirements?.length ?? 0) > 0 ||
      (build.copy?.length ?? 0) > 0 ||
      (build.run?.length ?? 0) > 0;
    if (!hasContent) {
      issues.push(
        "odoo.build must declare at least one of aptPackages, pipPackages, pipRequirements, copy, run",
      );
    }
    // docker build context = project root, so sources can never escape it
    for (const source of [
      ...(build.pipRequirements ?? []),
      ...(build.copy ?? []).map((entry) => entry.from),
    ]) {
      if (source.startsWith("/") || source === ".." || source.startsWith("../")) {
        issues.push(
          `odoo.build path "${source}" must be inside the repo (it is copied into the docker build context)`,
        );
      }
    }
  }

  if (issues.length > 0) return Effect.fail(new ConfigValidationError({ issues }));

  return Effect.succeed({
    project: {
      id: input.project.id,
      dbPrefix: input.project.dbPrefix,
      sharedDatabase: input.project.sharedDatabase ?? null,
      sharedBranches:
        input.project.sharedBranches ??
        (input.project.sharedDatabase !== undefined ? ["main", "master"] : []),
      stripBranchPrefixes: input.project.stripBranchPrefixes ?? DEFAULT_STRIP_BRANCH_PREFIXES,
    },
    ports,
    odoo: {
      version: input.odoo.version,
      serviceName: input.odoo.serviceName ?? "odoo",
      databaseServiceName: input.odoo.databaseServiceName ?? "db",
      postgresImage: input.odoo.postgresImage ?? "postgres:16",
      configFile: input.odoo.configFile ?? null,
      dockerfile: input.odoo.dockerfile ?? null,
      imageName: input.odoo.imageName ?? null,
      build:
        input.odoo.build === undefined
          ? null
          : {
              aptPackages: input.odoo.build.aptPackages ?? [],
              pipPackages: input.odoo.build.pipPackages ?? [],
              pipRequirements: input.odoo.build.pipRequirements ?? [],
              copy: input.odoo.build.copy ?? [],
              run: input.odoo.build.run ?? [],
            },
      dev: input.odoo.dev ?? "xml,reload",
      baseAddonsPath: input.odoo.baseAddonsPath ?? DEFAULT_BASE_ADDONS_PATH,
      addons: input.odoo.addons,
      source: input.odoo.source ?? null,
    },
    database: {
      initialModules: input.database?.initialModules ?? [],
      withoutDemo: input.database?.withoutDemo ?? "all",
      template: input.database?.template ?? true,
      postInit: input.database?.postInit ?? [],
    },
    setup: {
      submodules: input.setup?.submodules ?? false,
      packageManagers: input.setup?.packageManagers ?? [],
    },
    compose: { file: input.compose?.file ?? null },
    worktree: {
      copyFiles: input.worktree?.copyFiles ?? [],
      branchPrefix: input.worktree?.branchPrefix ?? "worktree-",
    },
    test: { profiles: input.test?.profiles ?? {} },
    envAliases: input.envAliases ?? {},
    companionApps: input.companionApps ?? [],
    cleanup: {
      maxAgeDays: input.cleanup?.maxAgeDays ?? 30,
      // default on: agent workflows mint environments far faster than anyone
      // remembers to prune, and auto-clean never touches shared or current ones
      auto: input.cleanup?.auto ?? true,
    },
  });
};
