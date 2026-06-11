import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { guardReset, parseModulesFlag } from "../../src/commands/reset-db.js";
import { buildSetupSteps } from "../../src/commands/setup.js";
import { SharedDatabaseProtectionError } from "../../src/errors/errors.js";
import { normalizeConfig, validateConfigInput } from "../../src/config/schema.js";
import { buildWorktreeContext } from "../../src/core/worktree-context.js";
import { runSyncFailure, runSyncSuccess } from "../helpers.js";

const recipe = runSyncSuccess(
  validateConfigInput({
    project: { id: "kl", dbPrefix: "kl", sharedDatabase: "kl_e2e_demo", sharedBranches: ["main"] },
    odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
    setup: {
      submodules: true,
      packageManagers: [
        { cwd: ".", command: "pnpm", args: ["install"] },
        { cwd: "frontend", command: "pnpm", args: ["install"] },
      ],
    },
  }).pipe(Effect.flatMap(normalizeConfig)),
);
const onMain = runSyncSuccess(
  buildWorktreeContext({
    rootDir: "/w",
    recipe,
    env: {},
    git: { _tag: "Branch", branch: "main" },
  }),
);
const onFeature = runSyncSuccess(
  buildWorktreeContext({
    rootDir: "/w",
    recipe,
    env: {},
    git: { _tag: "Branch", branch: "feature/q" },
  }),
);

describe("guardReset", () => {
  it("protects the shared database", () => {
    expect(runSyncFailure(guardReset(recipe, onMain, false))).toBeInstanceOf(
      SharedDatabaseProtectionError,
    );
    expect(() => runSyncSuccess(guardReset(recipe, onMain, true))).not.toThrow();
    expect(() => runSyncSuccess(guardReset(recipe, onFeature, false))).not.toThrow();
  });
});

describe("parseModulesFlag", () => {
  it("splits, trims, drops empties; undefined passes through", () => {
    expect(parseModulesFlag("KL_base, KL_sale ,")).toEqual(["KL_base", "KL_sale"]);
    expect(parseModulesFlag(undefined)).toBeUndefined();
  });
});

describe("buildSetupSteps", () => {
  it("orders submodules, installs, build, db reset", () => {
    const steps = buildSetupSteps(recipe, onFeature, { skipInstall: false, skipDb: false });
    expect(steps.map((s) => s.kind)).toEqual([
      "submodules",
      "install",
      "install",
      "build",
      "reset-db",
    ]);
    const install = steps[1] as { kind: "install"; cwd: string };
    expect(install.cwd).toBe("/w");
  });

  it("honors skip flags", () => {
    const steps = buildSetupSteps(recipe, onFeature, { skipInstall: true, skipDb: true });
    expect(steps.map((s) => s.kind)).toEqual(["submodules", "build"]);
  });
});
