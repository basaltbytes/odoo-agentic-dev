import { Effect, Schema } from "effect";
import { ConfigValidationError } from "../errors/errors.js";
import type { OdooAgenticDevConfig, OdooAgenticDevConfigInput } from "../core/project-recipe.js";
import { CANONICAL_ENV_VARS } from "../core/project-recipe.js";
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
    addons: Schema.Array(AddonMountSchema),
    source: Schema.optional(Schema.String),
  }),
  database: Schema.optional(
    Schema.Struct({
      initialModules: Schema.optional(Schema.Array(Schema.String)),
      withoutDemo: Schema.optional(Schema.Union([Schema.String, Schema.Literal(false)])),
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
  test: Schema.optional(
    Schema.Struct({
      profiles: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
    }),
  ),
  envAliases: Schema.optional(
    Schema.Record(Schema.String, Schema.Literals([...CANONICAL_ENV_VARS])),
  ),
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

  if (
    (input.project.sharedBranches?.length ?? 0) > 0 &&
    input.project.sharedDatabase === undefined
  ) {
    issues.push("project.sharedBranches is set but project.sharedDatabase is missing");
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
      addons: input.odoo.addons,
      source: input.odoo.source ?? null,
    },
    database: {
      initialModules: input.database?.initialModules ?? [],
      withoutDemo: input.database?.withoutDemo ?? "all",
      postInit: input.database?.postInit ?? [],
    },
    setup: {
      submodules: input.setup?.submodules ?? false,
      packageManagers: input.setup?.packageManagers ?? [],
    },
    compose: { file: input.compose?.file ?? null },
    test: { profiles: input.test?.profiles ?? {} },
    envAliases: input.envAliases ?? {},
    companionApps: input.companionApps ?? [],
    cleanup: {
      maxAgeDays: input.cleanup?.maxAgeDays ?? 30,
      auto: input.cleanup?.auto ?? false,
    },
  });
};
