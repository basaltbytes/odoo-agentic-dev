import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { parse } from "yaml";
import {
  applyEjectToInput,
  buildConfigPatch,
  ejectedDockerfileHeader,
  hasComments,
  performEject,
  renderEjectedDockerfile,
  renderEjectErrorJson,
  renderEjectJson,
  serializeConfigFile,
} from "../../src/commands/eject.js";
import type { PerformEjectOptions } from "../../src/commands/eject.js";
import { EjectError } from "../../src/errors/errors.js";
import { loadRecipe } from "../../src/config/load-recipe.js";
import type { OdooImageBuild } from "../../src/core/project-recipe.js";
import { makeCtx, makeRecipe, runSyncFailure, runSyncSuccess } from "../helpers.js";

const tmp: Array<string> = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const mkRoot = (prefix = "oad-eject-"): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmp.push(dir);
  return dir;
};

const buildRecipe = makeRecipe({
  project: { id: "kriss-laure", dbPrefix: "kl" },
  odoo: {
    version: "18.0",
    imageName: "krisslaure-odoo",
    build: { aptPackages: ["wkhtmltopdf"], pipPackages: ["requests"] },
    addons: [{ host: "addons/custom", container: "/mnt/extra-addons/custom" }],
  },
});
const buildCtx = makeCtx(buildRecipe, "feature/x", "/work/kl");

const stockRecipe = makeRecipe({
  project: { id: "stock", dbPrefix: "st" },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
});
const stockCtx = makeCtx(stockRecipe, "feature/y", "/work/st");

const handwrittenRecipe = makeRecipe({
  project: { id: "hand", dbPrefix: "hd" },
  odoo: {
    version: "18.0",
    dockerfile: "Dockerfile.custom",
    addons: [{ host: "addons", container: "/mnt/c" }],
  },
});
const handwrittenCtx = makeCtx(handwrittenRecipe, "feature/z", "/work/hd");

const baseOptions = (
  overrides: Partial<PerformEjectOptions> & Pick<PerformEjectOptions, "rootDir">,
): PerformEjectOptions => ({
  recipe: buildRecipe,
  ctx: { ...buildCtx, rootDir: overrides.rootDir },
  target: "all",
  dockerfileOut: "Dockerfile.odoo",
  composeOut: "docker-compose.worktree.yml",
  force: false,
  writeConfig: false,
  configFlag: undefined,
  ...overrides,
});

describe("ejectedDockerfileHeader / renderEjectedDockerfile", () => {
  it("stamps the CLI version and the ownership notice in the header", () => {
    expect(ejectedDockerfileHeader("0.1.0-beta.3")).toBe(
      "# Ejected from odoo-agentic-dev v0.1.0-beta.3 — this file is yours now.",
    );
  });

  it("swaps the generated header but keeps the rest of the Dockerfile body", () => {
    const build: OdooImageBuild = {
      aptPackages: ["wkhtmltopdf"],
      pipPackages: ["requests"],
      pipRequirements: [],
      copy: [],
      run: [],
    };
    const rendered = renderEjectedDockerfile("18.0", "9.9.9", build);
    expect(rendered.split("\n")[0]).toBe(
      "# Ejected from odoo-agentic-dev v9.9.9 — this file is yours now.",
    );
    expect(rendered).not.toContain("do not edit");
    expect(rendered).toContain("FROM odoo:18.0");
    expect(rendered).toContain("wkhtmltopdf");
    expect(rendered).toContain("requests");
  });
});

describe("hasComments", () => {
  it("detects line and block comments outside strings", () => {
    expect(hasComments("export default {} // hi")).toBe(true);
    expect(hasComments("/* hi */ export default {}")).toBe(true);
  });

  it("ignores // inside string and template literals (URLs)", () => {
    expect(hasComments(`const a = "http://x"; export default a;`)).toBe(false);
    expect(hasComments("const a = `http://x`; export default a;")).toBe(false);
    expect(hasComments(`const a = 'a//b'; export default a;`)).toBe(false);
  });
});

describe("serializeConfigFile", () => {
  it("emits a defineConfig file with unquoted identifier keys and data only", () => {
    const out = serializeConfigFile({
      project: { id: "x", dbPrefix: "x" },
      odoo: { version: "18.0", addons: [{ host: "a", container: "/mnt/c" }] },
    });
    expect(out.startsWith('import { defineConfig } from "@basaltbytes/odoo-agentic-dev";')).toBe(
      true,
    );
    expect(out).toContain("export default defineConfig(");
    expect(out).toContain("version: ");
    expect(out).not.toContain('"version"');
  });
});

describe("applyEjectToInput", () => {
  it("adds compose.file and replaces odoo.build with odoo.dockerfile", () => {
    const next = applyEjectToInput(
      {
        project: { id: "x", dbPrefix: "x" },
        odoo: {
          version: "18.0",
          build: { pipPackages: ["requests"] },
          addons: [{ host: "a", container: "/mnt/c" }],
        },
      },
      { composeFile: "docker-compose.worktree.yml", dockerfileFile: "Dockerfile.odoo" },
    );
    expect(next.compose?.file).toBe("docker-compose.worktree.yml");
    expect(next.odoo.dockerfile).toBe("Dockerfile.odoo");
    expect(next.odoo.build).toBeUndefined();
  });
});

describe("buildConfigPatch", () => {
  it("describes the exact keys to add/replace", () => {
    const patch = buildConfigPatch({
      composeFile: "docker-compose.worktree.yml",
      dockerfileFile: "Dockerfile.odoo",
    });
    expect(patch).toContain('compose: { file: "docker-compose.worktree.yml" }');
    expect(patch).toContain('dockerfile: "Dockerfile.odoo"');
    expect(patch).toContain("REPLACE");
  });
});

describe("performEject", () => {
  it("writes both files with portable content (interpolations, no baked db/port)", () => {
    const root = mkRoot();
    const result = runSyncSuccess(performEject(baseOptions({ rootDir: root })));
    expect(result.written).toEqual(["Dockerfile.odoo", "docker-compose.worktree.yml"]);

    const compose = readFileSync(join(root, "docker-compose.worktree.yml"), "utf8");
    expect(compose).toContain("${ODOO_DATABASE:?}");
    expect(compose).not.toContain(buildCtx.databaseName);
    expect(compose).not.toContain(String(buildCtx.odooHttpPort));
    // the ejected compose points its build at the ejected Dockerfile
    const model = parse(compose) as {
      services: { odoo: { build: { dockerfile: string } } };
    };
    expect(model.services.odoo.build.dockerfile).toBe("Dockerfile.odoo");

    const dockerfile = readFileSync(join(root, "Dockerfile.odoo"), "utf8");
    expect(dockerfile.split("\n")[0]).toContain("Ejected from odoo-agentic-dev");
  });

  it("refuses existing targets without --force, succeeds with --force", () => {
    const root = mkRoot();
    writeFileSync(join(root, "docker-compose.worktree.yml"), "existing: true\n");
    const error = runSyncFailure(performEject(baseOptions({ rootDir: root })));
    expect(error).toBeInstanceOf(EjectError);
    expect((error as EjectError).reason).toContain("--force");
    expect((error as EjectError).reason).toContain("docker-compose.worktree.yml");

    const ok = runSyncSuccess(performEject(baseOptions({ rootDir: root, force: true })));
    expect(ok.written).toContain("docker-compose.worktree.yml");
  });

  it("prints the config patch (default mode), writes nothing to the config", () => {
    const root = mkRoot();
    const result = runSyncSuccess(performEject(baseOptions({ rootDir: root })));
    expect(result.configWritten).toBe(false);
    expect(result.configPatch).toContain('compose: { file: "docker-compose.worktree.yml" }');
    expect(result.configPatch).toContain('dockerfile: "Dockerfile.odoo"');
  });

  it("dockerfile target with a stock image fails typed (nothing to eject)", () => {
    const root = mkRoot();
    const error = runSyncFailure(
      performEject(
        baseOptions({
          rootDir: root,
          recipe: stockRecipe,
          ctx: { ...stockCtx, rootDir: root },
          target: "dockerfile",
        }),
      ),
    );
    expect(error).toBeInstanceOf(EjectError);
    expect((error as EjectError).reason).toContain("stock odoo image");
    expect((error as EjectError).reason).toContain("odoo.build");
  });

  it("dockerfile target with a hand-written dockerfile fails typed (already ejected)", () => {
    const root = mkRoot();
    const error = runSyncFailure(
      performEject(
        baseOptions({
          rootDir: root,
          recipe: handwrittenRecipe,
          ctx: { ...handwrittenCtx, rootDir: root },
          target: "dockerfile",
        }),
      ),
    );
    expect(error).toBeInstanceOf(EjectError);
    expect((error as EjectError).reason).toContain("already ejected");
    expect((error as EjectError).reason).toContain("Dockerfile.custom");
  });

  it("target=all on a stock image ejects ONLY the compose file and says so", () => {
    const root = mkRoot();
    const result = runSyncSuccess(
      performEject(
        baseOptions({
          rootDir: root,
          recipe: stockRecipe,
          ctx: { ...stockCtx, rootDir: root },
          target: "all",
        }),
      ),
    );
    expect(result.written).toEqual(["docker-compose.worktree.yml"]);
    expect(result.notes.join("\n")).toContain("stock image");
    // patch references only the compose file
    expect(result.configPatch).not.toContain("dockerfile:");
  });

  it("compose target alone keeps the existing dockerfile config value in build", () => {
    const root = mkRoot();
    const result = runSyncSuccess(
      performEject(
        baseOptions({
          rootDir: root,
          recipe: handwrittenRecipe,
          ctx: { ...handwrittenCtx, rootDir: root },
          target: "compose",
        }),
      ),
    );
    expect(result.written).toEqual(["docker-compose.worktree.yml"]);
    const model = parse(readFileSync(join(root, "docker-compose.worktree.yml"), "utf8")) as {
      services: { odoo: { build: { dockerfile: string } } };
    };
    expect(model.services.odoo.build.dockerfile).toBe("Dockerfile.custom");
  });
});

describe("--json payloads", () => {
  it("emits the documented success object as a single line", () => {
    const root = mkRoot();
    const result = runSyncSuccess(performEject(baseOptions({ rootDir: root })));
    const line = renderEjectJson(result);
    expect(line).not.toContain("\n");
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      ok: true,
      command: "eject",
      written: ["Dockerfile.odoo", "docker-compose.worktree.yml"],
      configPatch: result.configPatch,
      configWritten: false,
    });
  });

  it("emits the documented failure object with tag and message", () => {
    const parsed = JSON.parse(renderEjectErrorJson(new EjectError({ reason: "boom" })));
    expect(parsed).toEqual({
      ok: false,
      command: "eject",
      error: { tag: "EjectError", message: "boom" },
    });
  });
});

describe("performEject --write-config", () => {
  const writeConfigFile = (root: string, body: string): void =>
    writeFileSync(join(root, "odoo-agentic-dev.config.ts"), body);

  const cleanConfig = `import { defineConfig } from "@basaltbytes/odoo-agentic-dev";

export default defineConfig({
  project: { id: "kriss-laure", dbPrefix: "kl" },
  odoo: {
    version: "18.0",
    imageName: "krisslaure-odoo",
    build: { aptPackages: ["wkhtmltopdf"], pipPackages: ["requests"] },
    addons: [{ host: "addons/custom", container: "/mnt/extra-addons/custom" }],
  },
});
`;

  it("regenerates a config that re-loads, re-validates, and points at the ejected files", async () => {
    const root = mkRoot();
    writeConfigFile(root, cleanConfig);
    const result = await Effect.runPromise(
      performEject(baseOptions({ rootDir: root, writeConfig: true })),
    );
    expect(result.configWritten).toBe(true);

    const reloaded = await Effect.runPromise(loadRecipe({ cwd: root, env: process.env }));
    expect(reloaded.recipe.compose.file).toBe("docker-compose.worktree.yml");
    expect(reloaded.recipe.odoo.dockerfile).toBe("Dockerfile.odoo");
    expect(reloaded.recipe.odoo.build).toBeNull();

    const rewritten = readFileSync(join(root, "odoo-agentic-dev.config.ts"), "utf8");
    expect(rewritten).toContain("defineConfig");
    expect(rewritten).not.toContain("build:");
  });

  it("refuses a commented config without --force", async () => {
    const root = mkRoot();
    writeConfigFile(root, `// a comment\n${cleanConfig}`);
    const exit = await Effect.runPromiseExit(
      performEject(baseOptions({ rootDir: root, writeConfig: true })),
    );
    expect(exit._tag).toBe("Failure");
    const reason = JSON.stringify(exit);
    expect(reason).toContain("discard comments");
  });

  it("overwrites a commented config with --force", async () => {
    const root = mkRoot();
    writeConfigFile(root, `// a comment\n${cleanConfig}`);
    const result = await Effect.runPromise(
      performEject(baseOptions({ rootDir: root, writeConfig: true, force: true })),
    );
    expect(result.configWritten).toBe(true);
    const rewritten = readFileSync(join(root, "odoo-agentic-dev.config.ts"), "utf8");
    expect(rewritten).not.toContain("// a comment");
  });
});
