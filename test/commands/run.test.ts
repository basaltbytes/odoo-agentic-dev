import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Layer } from "effect";
import { loadEnvFiles, parseEnvFile, runHostCommand } from "../../src/commands/run.js";
import type { ExecResult, ExecSpec } from "../../src/platform/command-runner.js";
import { makeFakeStateStore, makeRecordingRunner } from "../../src/testing/fake-adapters.js";
import { makeCtx, makeRecipe, runSyncFailure, runSyncSuccess, runWith } from "../helpers.js";

const tmp: Array<string> = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

let savedExitCode: typeof process.exitCode;
beforeEach(() => {
  savedExitCode = process.exitCode;
});
afterEach(() => {
  process.exitCode = savedExitCode;
});

const recipe = makeRecipe({
  project: { id: "kl", dbPrefix: "kl" },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
});

describe("parseEnvFile", () => {
  it("parses KEY=value lines and skips blank and comment lines", () => {
    expect(parseEnvFile("A=1\n\n# comment\n  # indented comment\nB=two\n")).toEqual({
      A: "1",
      B: "two",
    });
  });

  it("strips one layer of surrounding single or double quotes only", () => {
    expect(parseEnvFile(`A="hello world"\nB='single'\nC="nested 'quotes'"\nD=""\n`)).toEqual({
      A: "hello world",
      B: "single",
      C: "nested 'quotes'",
      D: "",
    });
  });

  it("keeps mismatched or inner quotes and later = signs intact", () => {
    expect(parseEnvFile(`A="unterminated\nB=with"middle"quotes\nC=key=value\n`)).toEqual({
      A: `"unterminated`,
      B: `with"middle"quotes`,
      C: "key=value",
    });
  });

  it("trims whitespace around keys and values and ignores lines without =", () => {
    expect(parseEnvFile("  A = spaced \nnot a pair\n=novalue\n")).toEqual({ A: "spaced" });
  });

  it("later assignments of the same key win", () => {
    expect(parseEnvFile("A=first\nA=second\n")).toEqual({ A: "second" });
  });
});

describe("loadEnvFiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "oad-run-env-"));
  tmp.push(dir);

  it("merges files in order: later files win", () => {
    const first = join(dir, "first.env");
    const second = join(dir, "second.env");
    writeFileSync(first, "SHARED=from-first\nONLY_FIRST=1\n");
    writeFileSync(second, "SHARED=from-second\nONLY_SECOND=2\n");
    expect(runSyncSuccess(loadEnvFiles([first, second]))).toEqual({
      SHARED: "from-second",
      ONLY_FIRST: "1",
      ONLY_SECOND: "2",
    });
  });

  it("fails with ConfigLoadError for a missing file", () => {
    const missing = join(dir, "does-not-exist.env");
    const error = runSyncFailure(loadEnvFiles([missing]));
    expect(error._tag).toBe("ConfigLoadError");
    expect(error).toMatchObject({ path: missing });
  });

  it("returns an empty record for no files", () => {
    expect(runSyncSuccess(loadEnvFiles([]))).toEqual({});
  });
});

describe("runHostCommand", () => {
  const dir = mkdtempSync(join(tmpdir(), "oad-run-cmd-"));
  tmp.push(dir);

  const makeEnv = (script?: (spec: ExecSpec) => ExecResult | undefined) => {
    const ctx = makeCtx(recipe, "feature/z");
    const recording = makeRecordingRunner(script);
    const store = makeFakeStateStore();
    const layer = Layer.mergeAll(recording.layer, store.layer);
    return { ctx, recording, run: runWith(layer), store };
  };

  it("passes the full argv through and injects ctx.env over the parent env", async () => {
    const { ctx, recording, run, store } = makeEnv();
    const exitCode = await run(
      runHostCommand(recipe, ctx, { envFiles: [], argv: ["pnpm", "test:e2e", "--ui"] }),
    );
    expect(exitCode).toBe(0);
    expect(store.rows.has(ctx.composeProjectName)).toBe(true);
    const spec = recording.calls.at(-1)!;
    expect(spec.command).toBe("pnpm");
    expect(spec.args).toEqual(["test:e2e", "--ui"]);
    // the runner merges spec.env over the parent env (extendEnv) — the spec
    // env must be exactly the assembled worktree env here
    expect(spec.env).toEqual(ctx.env);
  });

  it("layers env files over ctx.env (env-files are explicit overrides)", async () => {
    const { ctx, recording, run } = makeEnv();
    const envFile = join(dir, "override.env");
    writeFileSync(envFile, `ODOO_DATABASE=custom_db\nEXTRA_FLAG="on"\n`);
    await run(runHostCommand(recipe, ctx, { envFiles: [envFile], argv: ["env"] }));
    const spec = recording.calls.at(-1)!;
    expect(spec.env?.ODOO_DATABASE).toBe("custom_db");
    expect(spec.env?.EXTRA_FLAG).toBe("on");
    // untouched ctx.env keys still flow through
    expect(spec.env?.ODOO_COMPOSE_PROJECT_NAME).toBe(ctx.composeProjectName);
  });

  it("propagates a non-zero child exit code to process.exitCode", async () => {
    const { ctx, run } = makeEnv(() => ({ exitCode: 3, stdout: "", stderr: "" }));
    const exitCode = await run(runHostCommand(recipe, ctx, { envFiles: [], argv: ["false"] }));
    expect(exitCode).toBe(3);
    expect(process.exitCode).toBe(3);
  });

  it("leaves process.exitCode alone on success", async () => {
    const { ctx, run } = makeEnv();
    await run(runHostCommand(recipe, ctx, { envFiles: [], argv: ["true"] }));
    expect(process.exitCode).toBe(savedExitCode);
  });

  it("fails with ConfigLoadError before spawning when an env file is missing", async () => {
    const { ctx, recording, run } = makeEnv();
    await expect(
      run(
        runHostCommand(recipe, ctx, {
          envFiles: [join(dir, "missing.env")],
          argv: ["echo", "hi"],
        }),
      ),
    ).rejects.toThrow(/missing\.env/);
    expect(recording.calls).toHaveLength(0);
  });
});
