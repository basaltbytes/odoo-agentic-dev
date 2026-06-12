import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { normalizeConfig, validateConfigInput } from "../../src/config/schema.js";
import { ConfigValidationError } from "../../src/errors/errors.js";
import { runSyncFailure, runSyncSuccess } from "../helpers.js";

const minimal = {
  project: { id: "billing-odoo", dbPrefix: "billing" },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/extra-addons/custom" }] },
};

const normalized = (input: unknown) =>
  validateConfigInput(input).pipe(Effect.flatMap(normalizeConfig));

describe("validateConfigInput", () => {
  it("accepts a minimal config", () => {
    expect(runSyncSuccess(validateConfigInput(minimal))).toEqual(minimal);
  });

  it("rejects a non-object and missing required fields", () => {
    expect(runSyncFailure(validateConfigInput("nope"))).toBeInstanceOf(ConfigValidationError);
    expect(runSyncFailure(validateConfigInput({ project: { id: "x" } }))).toBeInstanceOf(
      ConfigValidationError,
    );
  });

  it("rejects an unknown hook type", () => {
    const bad = {
      ...minimal,
      database: { postInit: [{ type: "winrm-exec", cmd: "x" }] },
    };
    expect(runSyncFailure(validateConfigInput(bad))).toBeInstanceOf(ConfigValidationError);
  });
});

describe("normalizeConfig", () => {
  it("applies every documented default", () => {
    const cfg = runSyncSuccess(normalized(minimal));
    expect(cfg.ports).toEqual({
      odooBase: 18069,
      companionBase: 28000,
      range: 1000,
      hashAlgorithm: "fnv1a32",
    });
    expect(cfg.odoo.serviceName).toBe("odoo");
    expect(cfg.odoo.databaseServiceName).toBe("db");
    expect(cfg.odoo.postgresImage).toBe("postgres:16");
    expect(cfg.odoo.configFile).toBeNull();
    expect(cfg.odoo.build).toBeNull();
    expect(cfg.odoo.dev).toBe("xml,reload");
    expect(cfg.odoo.baseAddonsPath).toBe("/usr/lib/python3/dist-packages/odoo/addons");
    expect(cfg.database.withoutDemo).toBe("all");
    expect(cfg.database.initialModules).toEqual([]);
    expect(cfg.project.sharedDatabase).toBeNull();
    expect(cfg.project.sharedBranches).toEqual([]);
    expect(cfg.compose.file).toBeNull();
    expect(cfg.companionApps).toEqual([]);
    expect(cfg.cleanup).toEqual({ maxAgeDays: 30, auto: false });
  });

  it("defaults project.stripBranchPrefixes to the built-in type segments", () => {
    expect(runSyncSuccess(normalized(minimal)).project.stripBranchPrefixes).toEqual([
      "feature",
      "feat",
      "bugfix",
      "bug",
      "hotfix",
      "fix",
      "chore",
      "task",
    ]);
    expect(
      runSyncSuccess(
        normalized({
          ...minimal,
          project: { ...minimal.project, stripBranchPrefixes: ["release"] },
        }),
      ).project.stripBranchPrefixes,
    ).toEqual(["release"]);
  });

  it("defaults ports.hashAlgorithm to fnv1a32 and honors posix-cksum", () => {
    expect(runSyncSuccess(normalized(minimal)).ports.hashAlgorithm).toBe("fnv1a32");
    expect(
      runSyncSuccess(normalized({ ...minimal, ports: { hashAlgorithm: "posix-cksum" } })).ports
        .hashAlgorithm,
    ).toBe("posix-cksum");
    expect(
      runSyncFailure(normalized({ ...minimal, ports: { hashAlgorithm: "md5" } })),
    ).toBeInstanceOf(ConfigValidationError);
  });

  it("defaults the worktree section to no copied files and the worktree- branch prefix", () => {
    expect(runSyncSuccess(normalized(minimal)).worktree).toEqual({
      copyFiles: [],
      branchPrefix: "worktree-",
    });
  });

  it("honors explicit worktree settings", () => {
    const cfg = runSyncSuccess(
      normalized({
        ...minimal,
        worktree: { copyFiles: [".env.e2e", "conf/local.env"], branchPrefix: "wt/" },
      }),
    );
    expect(cfg.worktree).toEqual({
      copyFiles: [".env.e2e", "conf/local.env"],
      branchPrefix: "wt/",
    });
  });

  it("rejects a malformed worktree section", () => {
    expect(
      runSyncFailure(validateConfigInput({ ...minimal, worktree: { copyFiles: ".env.e2e" } })),
    ).toBeInstanceOf(ConfigValidationError);
  });

  it("honors explicit cleanup settings", () => {
    const cfg = runSyncSuccess(normalized({ ...minimal, cleanup: { maxAgeDays: 7, auto: true } }));
    expect(cfg.cleanup).toEqual({ maxAgeDays: 7, auto: true });
  });

  it("defaults sharedBranches to main/master when sharedDatabase is set", () => {
    const cfg = runSyncSuccess(
      normalized({
        ...minimal,
        project: { ...minimal.project, sharedDatabase: "billing_dev" },
      }),
    );
    expect(cfg.project.sharedBranches).toEqual(["main", "master"]);
  });

  it.each([
    ["bad dbPrefix", { ...minimal, project: { id: "x", dbPrefix: "9bad" } }, /dbPrefix/],
    [
      "duplicate container mounts",
      {
        ...minimal,
        odoo: {
          version: "18.0",
          addons: [
            { host: "a", container: "/mnt/x" },
            { host: "b", container: "/mnt/x" },
          ],
        },
      },
      /duplicate/i,
    ],
    ["port range too small", { ...minimal, ports: { range: 1 } }, /range/],
    [
      "unsafe companion name",
      {
        ...minimal,
        companionApps: [{ name: "P W A!", cwd: ".", command: "pnpm", args: ["dev"] }],
      },
      /companion/i,
    ],
    [
      "addon escaping repo",
      {
        ...minimal,
        odoo: { version: "18.0", addons: [{ host: "../outside", container: "/mnt/x" }] },
      },
      /outside/i,
    ],
  ])("rejects %s", (_label, input, pattern) => {
    const error = runSyncFailure(normalized(input));
    expect(error).toBeInstanceOf(ConfigValidationError);
    expect(error.message).toMatch(pattern);
  });

  it("normalizes odoo.build lists and honors dev: false", () => {
    const cfg = runSyncSuccess(
      normalized({
        ...minimal,
        odoo: {
          ...minimal.odoo,
          dev: false,
          build: { aptPackages: ["tesseract-ocr"] },
        },
      }),
    );
    expect(cfg.odoo.dev).toBe(false);
    expect(cfg.odoo.build).toEqual({
      aptPackages: ["tesseract-ocr"],
      pipPackages: [],
      pipRequirements: [],
      copy: [],
    });
  });

  it.each([
    [
      "build alongside a dockerfile",
      {
        ...minimal,
        odoo: {
          ...minimal.odoo,
          dockerfile: "Dockerfile.odoo",
          build: { pipPackages: ["requests"] },
        },
      },
      /mutually exclusive/,
    ],
    [
      "an empty build section",
      { ...minimal, odoo: { ...minimal.odoo, build: {} } },
      /at least one/,
    ],
    [
      "build paths escaping the repo",
      {
        ...minimal,
        odoo: { ...minimal.odoo, build: { pipRequirements: ["../secrets.txt"] } },
      },
      /build context/,
    ],
  ])("rejects %s", (_label, input, pattern) => {
    const error = runSyncFailure(normalized(input));
    expect(error).toBeInstanceOf(ConfigValidationError);
    expect(error.message).toMatch(pattern);
  });

  it("allows addon outside repo when explicitly flagged", () => {
    const cfg = runSyncSuccess(
      normalized({
        ...minimal,
        odoo: {
          version: "18.0",
          addons: [{ host: "../outside", container: "/mnt/x", allowOutsideRepo: true }],
        },
      }),
    );
    expect(cfg.odoo.addons[0]?.host).toBe("../outside");
  });
});
