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

  // 120s budget: cold Windows CI runners have been observed taking 45s+ to
  // first-spawn node + sqlite WAL on a temp path (global timeout is 20s)
  it(
    "never leaks the sqlite ExperimentalWarning (builtins evaluate before user modules)",
    { timeout: 120_000 },
    () => {
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
    },
  );

  // every state-touching e2e pins ODOO_AGENTIC_DEV_STATE_DB to a temp path —
  // the real user registry must never be touched by the test suite
  const spawn = (args: Array<string>, env: Record<string, string> = {}) =>
    spawnSync("node", [CLI, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        ODOO_WORKTREE_NAME: "feature/demo",
        ODOO_AGENTIC_DEV_STATE_DB: join(dir, `state-${args[0]}.db`),
        ...env,
      },
    });

  it("list --json prints a pure-JSON empty array on a fresh state db", () => {
    const result = spawn(["list", "--json"]);
    expect(result.status).toBe(0);
    // full stdout purity: the whole stream parses as JSON
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it("doctor --json prints pure JSON with the checks array, exit code per hard-check semantics", () => {
    const result = spawn(["doctor", "--json"]);
    const parsed = JSON.parse(result.stdout) as {
      checks: Array<{ name: string; ok: boolean; hard: boolean; detail: string }>;
    };
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks.length).toBeGreaterThan(0);
    for (const check of parsed.checks) {
      expect(typeof check.name).toBe("string");
      expect(typeof check.ok).toBe("boolean");
      expect(typeof check.hard).toBe("boolean");
      expect(typeof check.detail).toBe("string");
    }
    // docker may or may not exist on the runner; either way the exit code
    // must reflect the hard-check verdict, not crash
    const hardFailed = parsed.checks.some((check) => check.hard && !check.ok);
    expect(result.status).toBe(hardFailed ? 1 : 0);
  });

  it("bare prune exits 0 when there are no candidates (works without docker)", () => {
    const result = spawn(["prune"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Nothing to prune.");
  });

  it("prune --json prints a pure-JSON dry-run report", () => {
    const result = spawn(["prune", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      applied: false,
      candidates: [],
      removed: [],
    });
  });

  it("lifecycle --json: the last stdout line is one parseable JSON report (down)", () => {
    const result = spawn(["down", "--json"]);
    const lines = result.stdout.trim().split("\n");
    const parsed = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    expect(parsed.command).toBe("down");
    expect(parsed.database).toBe("fx_demo");
    expect(parsed.composeProject).toBe("fixture_fx_demo");
    expect(Array.isArray(parsed.actions)).toBe(true);
    expect(typeof parsed.durationMs).toBe("number");
    // ok mirrors the process exit code whether or not docker is available here
    expect(typeof parsed.ok).toBe("boolean");
    expect(parsed.ok).toBe(result.status === 0);
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
