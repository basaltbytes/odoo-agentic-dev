import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Layer } from "effect";
import { buildLogsArgs, runLogs } from "../../src/commands/logs.js";
import { buildShellArgs, runInteractivePassthrough } from "../../src/commands/shell.js";
import { buildPsqlArgs } from "../../src/commands/psql.js";
import { DockerComposeLive } from "../../src/platform/docker-compose.js";
import { GENERATED_COMPOSE_RELATIVE_PATH } from "../../src/core/compose-model.js";
import type { ExecSpec, ExecResult } from "../../src/platform/command-runner.js";
import { makeFakeStateStore, makeRecordingRunner } from "../../src/testing/fake-adapters.js";
import { makeCtx, makeRecipe, runWith } from "../helpers.js";

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

const makeEnv = (script?: (spec: ExecSpec) => ExecResult | undefined) => {
  const rootDir = mkdtempSync(join(tmpdir(), "oad-pass-"));
  tmp.push(rootDir);
  const ctx = makeCtx(recipe, "feature/z", rootDir);
  const recording = makeRecordingRunner(script);
  const store = makeFakeStateStore();
  const layer = Layer.mergeAll(
    Layer.provide(DockerComposeLive, recording.layer),
    recording.layer,
    store.layer,
  );
  return { ctx, recording, rootDir, run: runWith(layer), store };
};

const composePreamble = (ctx: ReturnType<typeof makeCtx>, rootDir: string): Array<string> => [
  "compose",
  "-p",
  ctx.composeProjectName,
  "-f",
  join(rootDir, GENERATED_COMPOSE_RELATIVE_PATH),
  "--project-directory",
  rootDir,
];

describe("argv builders", () => {
  it("buildLogsArgs defaults to the odoo service and maps --follow", () => {
    expect(buildLogsArgs("odoo", false)).toEqual(["logs", "odoo"]);
    expect(buildLogsArgs("db", true)).toEqual(["logs", "-f", "db"]);
  });

  it("buildShellArgs runs an interactive odoo shell against the worktree database", () => {
    const ctx = makeCtx(recipe, "feature/z");
    expect(buildShellArgs(recipe, ctx)).toEqual([
      "run",
      "--rm",
      "odoo",
      "odoo",
      "shell",
      "-d",
      ctx.databaseName,
    ]);
  });

  it("buildPsqlArgs execs psql in the db service with passthrough args", () => {
    const ctx = makeCtx(recipe, "feature/z");
    expect(buildPsqlArgs(recipe, ctx, [])).toEqual([
      "exec",
      "db",
      "psql",
      "-U",
      "odoo",
      "-d",
      ctx.databaseName,
    ]);
    expect(buildPsqlArgs(recipe, ctx, ["-c", "select 1"])).toEqual([
      "exec",
      "db",
      "psql",
      "-U",
      "odoo",
      "-d",
      ctx.databaseName,
      "-c",
      "select 1",
    ]);
  });
});

describe("runLogs", () => {
  it("streams compose logs for the requested service", async () => {
    const { ctx, recording, rootDir, run } = makeEnv();
    await run(runLogs(recipe, ctx, { service: undefined, follow: true }));
    expect(recording.calls.at(-1)).toMatchObject({
      command: "docker",
      args: [...composePreamble(ctx, rootDir), "logs", "-f", "odoo"],
      cwd: rootDir,
    });
  });

  it("honors an explicit service argument", async () => {
    const { ctx, recording, run } = makeEnv();
    await run(runLogs(recipe, ctx, { service: "db", follow: false }));
    expect(recording.calls.at(-1)!.args.slice(-2)).toEqual(["logs", "db"]);
  });
});

describe("runInteractivePassthrough", () => {
  it("records the environment, runs interactively, and propagates a non-zero exit code", async () => {
    const { ctx, recording, rootDir, run, store } = makeEnv((spec) =>
      spec.args.includes("shell") ? { exitCode: 7, stdout: "", stderr: "" } : undefined,
    );
    const exitCode = await run(runInteractivePassthrough(recipe, ctx, buildShellArgs(recipe, ctx)));
    expect(exitCode).toBe(7);
    expect(process.exitCode).toBe(7);
    expect(store.rows.has(ctx.composeProjectName)).toBe(true);
    expect(recording.calls.at(-1)).toMatchObject({
      command: "docker",
      args: [
        ...composePreamble(ctx, rootDir),
        "run",
        "--rm",
        "odoo",
        "odoo",
        "shell",
        "-d",
        ctx.databaseName,
      ],
      cwd: rootDir,
    });
  });

  it("leaves the exit code alone on success", async () => {
    const { ctx, run, store } = makeEnv();
    const exitCode = await run(
      runInteractivePassthrough(recipe, ctx, buildPsqlArgs(recipe, ctx, [])),
    );
    expect(exitCode).toBe(0);
    expect(process.exitCode).toBe(savedExitCode);
    expect(store.rows.has(ctx.composeProjectName)).toBe(true);
  });
});
