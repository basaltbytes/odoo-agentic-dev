import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const CLI = resolve(import.meta.dirname, "../../dist/cli.js");
const tmp: Array<string> = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!existsSync(CLI))("built CLI e2e (run `pnpm build` first)", () => {
  const dir = mkdtempSync(join(tmpdir(), "oad-e2e-"));
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
  const run = (args: Array<string>, env: Record<string, string> = {}) =>
    execFileSync("node", [CLI, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });

  it("info --json works without git or docker", () => {
    const parsed = JSON.parse(run(["info", "--json"], { ODOO_WORKTREE_NAME: "feature/demo" }));
    expect(parsed.databaseName).toBe("fx_demo");
    expect(parsed.composeProjectName).toBe("fixture_fx_demo");
    expect(parsed.env.ODOO_DATABASE).toBe("fx_demo");
  });

  it("info --env prints KEY=value lines", () => {
    const out = run(["info", "--env"], { ODOO_WORKTREE_NAME: "feature/demo" });
    expect(out).toContain("ODOO_DATABASE=fx_demo");
  });

  it("info is deterministic", () => {
    const a = run(["info", "--json"], { ODOO_WORKTREE_NAME: "feature/demo" });
    expect(run(["info", "--json"], { ODOO_WORKTREE_NAME: "feature/demo" })).toBe(a);
  });

  it("never leaks the sqlite ExperimentalWarning (builtins evaluate before user modules)", () => {
    // `list --all-projects` builds StateStoreLive (loads node:sqlite) and
    // degrades gracefully without docker, so it runs anywhere
    const result = spawnSync("node", [CLI, "list", "--all-projects"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, ODOO_AGENTIC_DEV_STATE_DB: join(dir, "e2e-state.db") },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("ExperimentalWarning");
    expect(result.stdout).toContain("No environments recorded.");
  });

  it("bare invocation prints help without the ShowHelp noise line and exits nonzero", () => {
    let status = 0;
    let stdout = "";
    let stderr = "";
    try {
      stdout = execFileSync("node", [CLI], { cwd: dir, encoding: "utf8" });
    } catch (error) {
      const e = error as { status: number; stdout: string; stderr: string };
      status = e.status;
      stdout = e.stdout;
      stderr = e.stderr;
    }
    expect(status).toBe(1);
    expect(stdout).toContain("SUBCOMMANDS");
    expect(stdout).not.toContain("Help requested");
    expect(stderr).not.toContain("Help requested");
    expect(stderr).not.toContain("ShowHelp");
  });
});
