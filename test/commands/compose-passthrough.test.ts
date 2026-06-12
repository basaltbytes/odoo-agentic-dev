import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Layer } from "effect";
import { runCompose } from "../../src/commands/compose.js";
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
  const rootDir = mkdtempSync(join(tmpdir(), "oad-compose-"));
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

describe("runCompose", () => {
  it("prefixes the canonical compose preamble and appends the trailing args verbatim", async () => {
    const { ctx, recording, rootDir, run, store } = makeEnv();
    await run(runCompose(recipe, ctx, ["logs", "-f", "--tail", "100", "odoo"]));
    expect(store.rows.has(ctx.composeProjectName)).toBe(true);
    expect(recording.calls.at(-1)).toMatchObject({
      command: "docker",
      args: [
        "compose",
        "-p",
        ctx.composeProjectName,
        "-f",
        join(rootDir, GENERATED_COMPOSE_RELATIVE_PATH),
        "--project-directory",
        rootDir,
        "logs",
        "-f",
        "--tail",
        "100",
        "odoo",
      ],
      cwd: rootDir,
    });
    // interactive compose children get the context env (project-supplied
    // compose files interpolate ${ODOO_DATABASE:?} and friends)
    expect(recording.calls.at(-1)!.env?.ODOO_DATABASE).toBe(ctx.databaseName);
  });

  it("propagates a non-zero compose exit code to process.exitCode", async () => {
    const { ctx, run } = makeEnv((spec) =>
      spec.args.includes("exec") ? { exitCode: 5, stdout: "", stderr: "" } : undefined,
    );
    const exitCode = await run(runCompose(recipe, ctx, ["exec", "odoo", "bash"]));
    expect(exitCode).toBe(5);
    expect(process.exitCode).toBe(5);
  });

  it("fails fast with DockerUnavailableError when docker is missing", async () => {
    const { ctx, recording, run } = makeEnv((spec) =>
      spec.args[0] === "version" ? { exitCode: 1, stdout: "", stderr: "no docker" } : undefined,
    );
    await expect(run(runCompose(recipe, ctx, ["up", "-d"]))).rejects.toThrow(/no docker/);
    // nothing beyond the availability probe was executed
    expect(recording.calls).toHaveLength(1);
  });
});
