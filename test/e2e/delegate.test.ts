import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const CLI = resolve(import.meta.dirname, "../../dist/cli.js");
const tmp: Array<string> = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

/** A project fixture with a config plus a stub local install that prints a marker and exits 7. */
const makeFixtureWithLocalInstall = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "oad-delegate-"));
  tmp.push(dir);
  writeFileSync(
    join(dir, "odoo-agentic-dev.config.mjs"),
    `
export default {
  project: { id: "fixture", dbPrefix: "fx" },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/extra-addons/custom" }] }
}
`,
  );
  const pkgDir = join(dir, "node_modules", "@basaltbytes", "odoo-agentic-dev");
  const distDir = join(pkgDir, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({
      name: "@basaltbytes/odoo-agentic-dev",
      version: "0.0.0-stub",
      main: "dist/cli.js",
    }),
  );
  writeFileSync(join(distDir, "cli.js"), `console.log("DELEGATED-STUB"); process.exit(7);\n`);
  return dir;
};

const run = (cwd: string, env: Record<string, string> = {}) =>
  spawnSync("node", [CLI, "info"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

describe.skipIf(!existsSync(CLI))("local-install delegation e2e (run `pnpm build` first)", () => {
  it("delegates to the project-local install (prints the marker, mirrors exit code 7)", () => {
    const dir = makeFixtureWithLocalInstall();
    const result = run(dir);
    expect(result.stdout).toContain("DELEGATED-STUB");
    expect(result.status).toBe(7);
  });

  it("ODOO_AGENTIC_DEV_NO_DELEGATE=1 bypasses delegation (runs the real binary)", () => {
    const dir = makeFixtureWithLocalInstall();
    const result = run(dir, { ODOO_AGENTIC_DEV_NO_DELEGATE: "1" });
    expect(result.stdout).not.toContain("DELEGATED-STUB");
    // the real binary ran: `info` succeeded against the fixture config
    expect(result.status).toBe(0);
  });

  it("does not delegate outside any project (configless temp dir)", () => {
    const dir = mkdtempSync(join(tmpdir(), "oad-delegate-none-"));
    tmp.push(dir);
    const result = run(dir);
    expect(result.stdout).not.toContain("DELEGATED-STUB");
  });
});
