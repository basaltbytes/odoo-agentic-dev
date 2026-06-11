import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import {
  composeArgs,
  DockerCompose,
  DockerComposeLive,
  parseLabeledPs,
} from "../../src/platform/docker-compose.js";
import { makeRecordingRunner } from "../../src/testing/fake-adapters.js";
import { GENERATED_COMPOSE_RELATIVE_PATH } from "../../src/core/compose-model.js";
import { ComposeCommandError, DockerUnavailableError } from "../../src/errors/errors.js";
import type { ExecSpec, ExecResult } from "../../src/platform/command-runner.js";
import { makeCtx, makeRecipe, runWith } from "../helpers.js";

const tmp: Array<string> = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const makeEnv = (script?: (spec: ExecSpec) => ExecResult | undefined) => {
  const rootDir = mkdtempSync(join(tmpdir(), "oad-dc-"));
  tmp.push(rootDir);
  const recipe = makeRecipe({
    project: { id: "fixture", dbPrefix: "fx" },
    odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
  });
  const ctx = makeCtx(recipe, "feature/y", rootDir);
  const recording = makeRecordingRunner(script);
  const run = runWith(Layer.provide(DockerComposeLive, recording.layer));
  return { ctx, recipe, recording, rootDir, run };
};

describe("parseLabeledPs", () => {
  it("parses NDJSON lines, keeps the empty branch label verbatim, skips garbage", () => {
    const line = JSON.stringify({
      Labels:
        "com.docker.compose.project=fixture_fx_a,dev.basaltbytes.oad=1,dev.basaltbytes.oad.project-id=fixture,dev.basaltbytes.oad.database=fx_a,dev.basaltbytes.oad.root-dir=/w,dev.basaltbytes.oad.branch=",
    });
    const parsed = parseLabeledPs(`${line}\nnot json\n${JSON.stringify({ Labels: 42 })}\n`);
    expect(parsed).toEqual([
      {
        composeProject: "fixture_fx_a",
        projectId: "fixture",
        database: "fx_a",
        rootDir: "/w",
        branch: "",
      },
    ]);
  });

  it("skips containers without a compose project label and tolerates empty output", () => {
    expect(parseLabeledPs("")).toEqual([]);
    expect(parseLabeledPs(`${JSON.stringify({ Labels: "dev.basaltbytes.oad=1" })}\n`)).toEqual([]);
  });
});

describe("composeArgs", () => {
  it("builds the canonical docker compose argv", () => {
    expect(
      composeArgs({ projectName: "p", composeFile: "/f.yml", projectDir: "/root" }, ["up", "-d"]),
    ).toEqual(["compose", "-p", "p", "-f", "/f.yml", "--project-directory", "/root", "up", "-d"]);
  });
});

describe("DockerComposeLive", () => {
  it("ensureAvailable fails with DockerUnavailableError when docker is missing", async () => {
    const { run } = makeEnv(() => ({ exitCode: 1, stdout: "", stderr: "command not found" }));
    await expect(
      run(
        Effect.gen(function* () {
          const dc = yield* DockerCompose;
          yield* dc.ensureAvailable();
        }),
      ),
    ).rejects.toThrow(DockerUnavailableError);
  });

  it("prepareComposeFile writes the generated file under .odoo-agentic-dev", async () => {
    const { ctx, recipe, rootDir, run } = makeEnv();
    const ref = await run(
      Effect.gen(function* () {
        const dc = yield* DockerCompose;
        return yield* dc.prepareComposeFile(recipe, ctx);
      }),
    );
    expect(ref.projectName).toBe(ctx.composeProjectName);
    expect(ref.projectDir).toBe(rootDir);
    expect(ref.composeFile).toBe(join(rootDir, GENERATED_COMPOSE_RELATIVE_PATH));
    expect(readFileSync(ref.composeFile, "utf8")).toContain("pg_isready");
  });

  it("prepareComposeFile honors the project-supplied escape hatch", async () => {
    const { ctx, rootDir, run } = makeEnv();
    const recipe = makeRecipe({
      project: { id: "fixture", dbPrefix: "fx" },
      odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
      compose: { file: "docker-compose.worktree.yml" },
    });
    const ref = await run(
      Effect.gen(function* () {
        const dc = yield* DockerCompose;
        return yield* dc.prepareComposeFile(recipe, ctx);
      }),
    );
    expect(ref.composeFile).toBe(join(rootDir, "docker-compose.worktree.yml"));
  });

  it("run issues exact argv and fails on non-zero exit", async () => {
    const { ctx, recipe, recording, run } = makeEnv((spec) =>
      spec.args.includes("down") ? { exitCode: 9, stdout: "", stderr: "kaboom" } : undefined,
    );
    const ref = await run(
      Effect.gen(function* () {
        const dc = yield* DockerCompose;
        const ref = yield* dc.prepareComposeFile(recipe, ctx);
        yield* dc.run(ref, ["up", "-d", "--build", "odoo"]);
        return ref;
      }),
    );
    expect(recording.calls.at(-1)).toMatchObject({
      command: "docker",
      args: [
        "compose",
        "-p",
        ctx.composeProjectName,
        "-f",
        ref.composeFile,
        "--project-directory",
        ref.projectDir,
        "up",
        "-d",
        "--build",
        "odoo",
      ],
    });
    await expect(
      run(
        Effect.gen(function* () {
          const dc = yield* DockerCompose;
          yield* dc.run(ref, ["down"]);
        }),
      ),
    ).rejects.toThrow(/kaboom/);
    // full failure output is preserved under .odoo-agentic-dev/logs/
    const { existsSync, readdirSync } = await import("node:fs");
    const logsDir = join(ref.projectDir, ".odoo-agentic-dev", "logs");
    expect(existsSync(logsDir)).toBe(true);
    expect(readdirSync(logsDir).length).toBeGreaterThan(0);
  });

  it("non-zero exit fails with the single-expanded argv (no doubled compose preamble)", async () => {
    const { ctx, recipe, run } = makeEnv((spec) =>
      spec.args.includes("down") ? { exitCode: 9, stdout: "", stderr: "kaboom" } : undefined,
    );
    const { error, ref } = await run(
      Effect.gen(function* () {
        const dc = yield* DockerCompose;
        const ref = yield* dc.prepareComposeFile(recipe, ctx);
        const error = yield* Effect.flip(dc.run(ref, ["down"]));
        return { error, ref };
      }),
    );
    expect(error).toBeInstanceOf(ComposeCommandError);
    expect(error.exitCode).toBe(9);
    expect(error.args).toEqual([
      "compose",
      "-p",
      ctx.composeProjectName,
      "-f",
      ref.composeFile,
      "--project-directory",
      ref.projectDir,
      "down",
    ]);
  });

  it("listProjects parses `docker compose ls -a --format json` leniently", async () => {
    const { recording, run } = makeEnv((spec) =>
      spec.args.includes("ls")
        ? {
            exitCode: 0,
            stdout: JSON.stringify([
              { Name: "kl_a", Status: "running(2)", ConfigFiles: "/a/compose.yml" },
              { Name: "kl_b", Status: "exited(2)", ConfigFiles: "/b/compose.yml" },
              { Status: "running(1)" },
            ]),
            stderr: "",
          }
        : undefined,
    );
    const projects = await run(
      Effect.gen(function* () {
        const dc = yield* DockerCompose;
        return yield* dc.listProjects();
      }),
    );
    expect(projects).toEqual([
      { name: "kl_a", running: true },
      { name: "kl_b", running: false },
    ]);
    expect(recording.calls.at(-1)).toMatchObject({
      command: "docker",
      args: ["compose", "ls", "-a", "--format", "json"],
    });
  });

  it("listProjects tolerates empty output and fails typed on garbage", async () => {
    const { run } = makeEnv((spec) =>
      spec.args.includes("ls") ? { exitCode: 0, stdout: "  \n", stderr: "" } : undefined,
    );
    await expect(
      run(
        Effect.gen(function* () {
          const dc = yield* DockerCompose;
          return yield* dc.listProjects();
        }),
      ),
    ).resolves.toEqual([]);

    const garbage = makeEnv((spec) =>
      spec.args.includes("ls") ? { exitCode: 0, stdout: "not json", stderr: "" } : undefined,
    );
    const error = await garbage.run(
      Effect.gen(function* () {
        const dc = yield* DockerCompose;
        return yield* Effect.flip(dc.listProjects());
      }),
    );
    expect(error).toBeInstanceOf(ComposeCommandError);
  });

  it("removeByLabel removes containers then volumes by compose-project label", async () => {
    const { recording, run } = makeEnv((spec) => {
      if (spec.args[0] === "ps") return { exitCode: 0, stdout: "c1\nc2\n", stderr: "" };
      if (spec.args[0] === "volume" && spec.args[1] === "ls") {
        return { exitCode: 0, stdout: "v1\n", stderr: "" };
      }
      return undefined;
    });
    await run(
      Effect.gen(function* () {
        const dc = yield* DockerCompose;
        yield* dc.removeByLabel("kl_gone");
      }),
    );
    expect(recording.calls.map((c) => c.args)).toEqual([
      ["ps", "-aq", "--filter", "label=com.docker.compose.project=kl_gone"],
      ["rm", "-f", "c1", "c2"],
      ["volume", "ls", "-q", "--filter", "label=com.docker.compose.project=kl_gone"],
      ["volume", "rm", "v1"],
    ]);
  });

  it("removeByLabel skips rm calls when nothing matches", async () => {
    const { recording, run } = makeEnv(() => ({ exitCode: 0, stdout: "\n", stderr: "" }));
    await run(
      Effect.gen(function* () {
        const dc = yield* DockerCompose;
        yield* dc.removeByLabel("kl_gone");
      }),
    );
    expect(recording.calls.map((c) => c.args[0])).toEqual(["ps", "volume"]);
  });

  it("listLabeledContainers queries oad-labeled containers and dedupes per project", async () => {
    const labels = [
      "com.docker.compose.project=kl_x",
      "dev.basaltbytes.oad=1",
      "dev.basaltbytes.oad.project-id=kl",
      "dev.basaltbytes.oad.database=kl_x",
      "dev.basaltbytes.oad.root-dir=/work/x",
      "dev.basaltbytes.oad.branch=feature/x",
    ].join(",");
    const { recording, run } = makeEnv((spec) =>
      spec.args[0] === "ps"
        ? {
            exitCode: 0,
            stdout: `${JSON.stringify({ ID: "a", Labels: labels })}\n${JSON.stringify({ ID: "b", Labels: labels })}\n`,
            stderr: "",
          }
        : undefined,
    );
    const containers = await run(
      Effect.gen(function* () {
        const dc = yield* DockerCompose;
        return yield* dc.listLabeledContainers();
      }),
    );
    expect(containers).toEqual([
      {
        composeProject: "kl_x",
        projectId: "kl",
        database: "kl_x",
        rootDir: "/work/x",
        branch: "feature/x",
      },
    ]);
    expect(recording.calls.at(-1)).toMatchObject({
      command: "docker",
      args: ["ps", "-a", "--filter", "label=dev.basaltbytes.oad=1", "--format", "json"],
    });
  });

  it("waitForDb polls pg_isready until success", async () => {
    let attempts = 0;
    const { ctx, recipe, run } = makeEnv((spec) => {
      if (spec.args.includes("pg_isready")) {
        attempts += 1;
        return { exitCode: attempts < 3 ? 1 : 0, stdout: "", stderr: "" };
      }
      return undefined;
    });
    await run(
      Effect.gen(function* () {
        const dc = yield* DockerCompose;
        const ref = yield* dc.prepareComposeFile(recipe, ctx);
        yield* dc.waitForDb(ref, "db", { intervalMillis: 1, maxAttempts: 10 });
      }),
    );
    expect(attempts).toBe(3);
  });
});
