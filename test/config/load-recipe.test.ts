// test/config/load-recipe.test.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { discoverConfigPath, loadRecipe } from "../../src/config/load-recipe.js";
import { runSyncSuccess } from "../helpers.js";

const SRC_INDEX = resolve(import.meta.dirname, "../../src/index.ts");
const tmp: Array<string> = [];
const makeProject = (config: string, filename = "odoo-agentic-dev.config.ts"): string => {
  const dir = mkdtempSync(join(tmpdir(), "oad-test-"));
  tmp.push(dir);
  writeFileSync(join(dir, filename), config);
  return dir;
};
afterAll(() => {
  for (const dir of tmp) rmSync(dir, { recursive: true, force: true });
});

const VALID = `
import { defineConfig } from ${JSON.stringify(SRC_INDEX)}
export default defineConfig({
  project: { id: "billing-odoo", dbPrefix: "billing" },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/extra-addons/custom" }] }
})
`;

describe("discoverConfigPath", () => {
  it("finds the config in the start dir and walks parents", () => {
    const dir = makeProject(VALID);
    const nested = join(dir, "a/b");
    mkdirSync(nested, { recursive: true });
    expect(runSyncSuccess(discoverConfigPath(dir))).toBe(join(dir, "odoo-agentic-dev.config.ts"));
    expect(runSyncSuccess(discoverConfigPath(nested))).toBe(
      join(dir, "odoo-agentic-dev.config.ts"),
    );
  });

  it("returns undefined when nothing is found", () => {
    const dir = mkdtempSync(join(tmpdir(), "oad-empty-"));
    tmp.push(dir);
    expect(runSyncSuccess(discoverConfigPath(dir))).toBeUndefined();
  });
});

describe("loadRecipe", () => {
  it("loads, validates, and normalizes a .ts config; rootDir is the config's dir", async () => {
    const dir = makeProject(VALID);
    const { recipe, rootDir } = await Effect.runPromise(loadRecipe({ cwd: dir, env: {} }));
    expect(rootDir).toBe(dir);
    expect(recipe.project.dbPrefix).toBe("billing");
    expect(recipe.odoo.serviceName).toBe("odoo"); // defaults applied
  });

  it("honors an explicit --config path", async () => {
    const dir = makeProject(VALID, "custom.config.ts");
    const { recipe } = await Effect.runPromise(
      loadRecipe({ cwd: tmpdir(), explicitPath: join(dir, "custom.config.ts"), env: {} }),
    );
    expect(recipe.project.id).toBe("billing-odoo");
  });

  it("honors ODOO_WORKTREE_CONFIG env override", async () => {
    const dir = makeProject(VALID, "from-env.config.ts");
    const { recipe } = await Effect.runPromise(
      loadRecipe({ cwd: tmpdir(), env: { ODOO_WORKTREE_CONFIG: join(dir, "from-env.config.ts") } }),
    );
    expect(recipe.project.id).toBe("billing-odoo");
  });

  it("fails with ConfigLoadError when nothing is discoverable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oad-none-"));
    tmp.push(dir);
    await expect(Effect.runPromise(loadRecipe({ cwd: dir, env: {} }))).rejects.toThrow(
      /No odoo-agentic-dev config/,
    );
  });

  it("fails with ConfigValidationError for an invalid shape", async () => {
    const dir = makeProject(`export default { project: { id: "x" } }`);
    await expect(Effect.runPromise(loadRecipe({ cwd: dir, env: {} }))).rejects.toThrow();
  });
});
