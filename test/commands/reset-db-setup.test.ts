import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { guardReset, parseModulesFlag } from "../../src/commands/reset-db.js";
import { buildSetupSteps } from "../../src/commands/setup.js";
import { SharedDatabaseProtectionError } from "../../src/errors/errors.js";
import { makeCtx, makeRecipe, runSyncFailure, runSyncSuccess } from "../helpers.js";

const recipe = makeRecipe({
  project: { id: "kl", dbPrefix: "kl", sharedDatabase: "kl_e2e_demo", sharedBranches: ["main"] },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
  setup: {
    submodules: true,
    packageManagers: [
      { cwd: ".", command: "pnpm", args: ["install"] },
      { cwd: "frontend", command: "pnpm", args: ["install"] },
    ],
  },
});
const onMain = makeCtx(recipe, "main");
const onFeature = makeCtx(recipe, "feature/q");

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
    // install cwd is resolved against rootDir with platform path semantics
    expect(install.cwd).toBe(resolve("/w", "."));
  });

  it("honors skip flags", () => {
    const steps = buildSetupSteps(recipe, onFeature, { skipInstall: true, skipDb: true });
    expect(steps.map((s) => s.kind)).toEqual(["submodules", "build"]);
  });
});
