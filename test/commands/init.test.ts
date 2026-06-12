import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { performInit, renderInitErrorJson, renderInitJson } from "../../src/commands/init.js";
import type { InitResult } from "../../src/commands/init.js";
import { InitError } from "../../src/errors/errors.js";
import { loadRecipe } from "../../src/config/load-recipe.js";

const tmp: Array<string> = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const mkRoot = (name = "kriss-laure"): string => {
  const base = mkdtempSync(join(tmpdir(), "oad-init-"));
  tmp.push(base);
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);
const runExit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);

describe("performInit scaffolding", () => {
  it("writes the config + .gitignore, derives id/prefix, detects no addons dir", async () => {
    const root = mkRoot("kriss-laure");
    const result = await run(performInit({ cwd: root, force: false }));

    expect(result.projectId).toBe("kriss-laure");
    expect(result.dbPrefix).toBe("kl");
    expect(result.written).toContain("odoo-agentic-dev.config.ts");
    expect(result.written).toContain(".gitignore");

    const config = readFileSync(join(root, "odoo-agentic-dev.config.ts"), "utf8");
    expect(config).toContain('id: "kriss-laure"');
    expect(config).toContain('dbPrefix: "kl"');
    expect(config).toContain('version: "18.0"');
    expect(config).toContain("// adjust to your Odoo version");
    // no ./addons dir → placeholder host WITH the adjust comment
    expect(config).toContain("// adjust to your addons directory");

    const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain(".odoo-agentic-dev/");
  });

  it("the generated config loads via the real loadRecipe", async () => {
    const root = mkRoot("kriss-laure");
    await run(performInit({ cwd: root, force: false }));
    const reloaded = await run(loadRecipe({ cwd: root, env: process.env }));
    expect(reloaded.recipe.project.id).toBe("kriss-laure");
    expect(reloaded.recipe.project.dbPrefix).toBe("kl");
    expect(reloaded.recipe.odoo.version).toBe("18.0");
  });

  it("honors explicit --id / --db-prefix / --odoo-version overrides", async () => {
    const root = mkRoot("whatever");
    const result = await run(
      performInit({
        cwd: root,
        force: false,
        id: "custom-id",
        dbPrefix: "ci",
        odooVersion: "17.0",
      }),
    );
    expect(result.projectId).toBe("custom-id");
    expect(result.dbPrefix).toBe("ci");
    const config = readFileSync(join(root, "odoo-agentic-dev.config.ts"), "utf8");
    expect(config).toContain('id: "custom-id"');
    expect(config).toContain('dbPrefix: "ci"');
    expect(config).toContain('version: "17.0"');
  });

  it("detects an existing ./addons dir and omits the addons adjust comment", async () => {
    const root = mkRoot("hasaddons");
    mkdirSync(join(root, "addons"));
    await run(performInit({ cwd: root, force: false }));
    const config = readFileSync(join(root, "odoo-agentic-dev.config.ts"), "utf8");
    expect(config).toContain('host: "addons"');
    expect(config).not.toContain("// adjust to your addons directory");
  });
});

describe("performInit .gitignore handling", () => {
  it("creates .gitignore when absent", async () => {
    const root = mkRoot("freshgit");
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
    await run(performInit({ cwd: root, force: false }));
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".odoo-agentic-dev/");
  });

  it("appends to an existing .gitignore without clobbering it", async () => {
    const root = mkRoot("withgit");
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    await run(performInit({ cwd: root, force: false }));
    const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain(".odoo-agentic-dev/");
  });

  it("is idempotent: does not duplicate the line if already present", async () => {
    const root = mkRoot("alreadyignored");
    writeFileSync(join(root, ".gitignore"), "node_modules/\n.odoo-agentic-dev/\n");
    const result = await run(performInit({ cwd: root, force: false }));
    const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
    const occurrences = gitignore.split(".odoo-agentic-dev/").length - 1;
    expect(occurrences).toBe(1);
    // .gitignore was not modified → not reported as written
    expect(result.written).not.toContain(".gitignore");
  });
});

describe("performInit refusal rules", () => {
  it("refuses when a config exists in cwd (no --force) with a typed error", async () => {
    const root = mkRoot("hasconfig");
    writeFileSync(join(root, "odoo-agentic-dev.config.ts"), "export default {};\n");
    const exit = await runExit(performInit({ cwd: root, force: false }));
    expect(exit._tag).toBe("Failure");
    const text = JSON.stringify(exit);
    expect(text).toContain("InitError");
    expect(text).toContain("odoo-agentic-dev.config.ts");
    expect(text).toContain("--force");
  });

  it("overwrites a cwd config with --force", async () => {
    const root = mkRoot("forced");
    writeFileSync(join(root, "odoo-agentic-dev.config.ts"), "export default {};\n");
    const result = await run(performInit({ cwd: root, force: true }));
    expect(result.written).toContain("odoo-agentic-dev.config.ts");
    const config = readFileSync(join(root, "odoo-agentic-dev.config.ts"), "utf8");
    expect(config).toContain("defineConfig");
  });

  it("refuses ALWAYS when a config exists in an ANCESTOR dir (even with --force)", async () => {
    const parent = mkRoot("parentproj");
    writeFileSync(join(parent, "odoo-agentic-dev.config.ts"), "export default {};\n");
    const child = join(parent, "nested", "deep");
    mkdirSync(child, { recursive: true });

    const exitNoForce = await runExit(performInit({ cwd: child, force: false }));
    expect(exitNoForce._tag).toBe("Failure");
    const exitForced = await runExit(performInit({ cwd: child, force: true }));
    expect(exitForced._tag).toBe("Failure");
    const text = JSON.stringify(exitForced);
    expect(text).toContain("InitError");
    expect(text).toContain(parent);
    // child has no config written
    expect(existsSync(join(child, "odoo-agentic-dev.config.ts"))).toBe(false);
  });
});

describe("init --json payloads", () => {
  it("renders the documented success object as a single line", async () => {
    const root = mkRoot("jsonproj");
    const result = await run(performInit({ cwd: root, force: false }));
    const line = renderInitJson(result);
    expect(line).not.toContain("\n");
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toEqual({
      ok: true,
      command: "init",
      written: result.written,
      projectId: "jsonproj",
      dbPrefix: deriveExpectedPrefix("jsonproj"),
    });
  });

  it("renders the documented failure object with tag and message", () => {
    const parsed = JSON.parse(renderInitErrorJson(new InitError({ reason: "boom" }))) as Record<
      string,
      unknown
    >;
    expect(parsed).toEqual({
      ok: false,
      command: "init",
      error: { tag: "InitError", message: "boom" },
    });
  });
});

// local expectation helper: "jsonproj" is a single word truncated to 8 chars
const deriveExpectedPrefix = (id: string): string => id.replace(/[^a-z0-9]/g, "").slice(0, 8);

// keep InitResult import used (type-only assertion)
const _typeCheck: (r: InitResult) => ReadonlyArray<string> = (r) => r.written;
void _typeCheck;
