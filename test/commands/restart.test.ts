import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { buildRestartPlan, guardRestartJson, runRestart } from "../../src/commands/restart.js";
import { withJsonReport } from "../../src/commands/json-report.js";
import { DockerComposeLive } from "../../src/platform/docker-compose.js";
import { UsageError } from "../../src/errors/errors.js";
import {
  makeFakePortProbe,
  makeFakeStateStore,
  makeRecordingRunner,
} from "../../src/testing/fake-adapters.js";
import { makeCtx, makeRecipe, runSyncFailure, runWith } from "../helpers.js";

const tmp: Array<string> = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const rootDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "oad-restart-"));
  tmp.push(dir);
  return dir;
};

const recipe = makeRecipe({
  project: { id: "kl", dbPrefix: "kl" },
  odoo: {
    version: "18.0",
    build: { pipPackages: ["websocket-client"] },
    addons: [{ host: "addons", container: "/mnt/c" }],
  },
});

const joinedCalls = (calls: Array<{ command: string; args: ReadonlyArray<string> }>) =>
  calls.map((c) => [c.command, ...c.args].join(" "));

describe("buildRestartPlan", () => {
  it("restarts Odoo without rebuilding by default", () => {
    expect(buildRestartPlan(recipe, { rebuild: false, logs: false })).toEqual({
      ensureDbArgs: ["up", "-d", "db"],
      buildArgs: null,
      removeOdooArgs: null,
      restartOdooArgs: ["restart", "odoo"],
      logsArgs: null,
    });
  });

  it("--rebuild adds build/remove/recreate steps, --logs follows logs", () => {
    expect(buildRestartPlan(recipe, { rebuild: true, logs: true })).toEqual({
      ensureDbArgs: ["up", "-d", "db"],
      buildArgs: ["build", "odoo"],
      removeOdooArgs: ["rm", "-sf", "odoo"],
      restartOdooArgs: ["up", "-d", "odoo"],
      logsArgs: ["logs", "-f", "odoo"],
    });
  });
});

describe("guardRestartJson", () => {
  it("rejects --json --logs", () => {
    const error = runSyncFailure(guardRestartJson({ json: true, logs: true }));
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain("--logs");
  });

  it("the rejection surfaces as ok:false JSON when wrapped", async () => {
    const log: Array<string> = [];
    const original = console.log;
    console.log = ((line: unknown) => {
      log.push(String(line));
    }) as typeof console.log;
    try {
      await Effect.runPromise(
        withJsonReport("restart", true, () => guardRestartJson({ json: true, logs: true })),
      ).then(
        () => {
          throw new Error("expected rejection");
        },
        () => {},
      );
    } finally {
      console.log = original;
    }
    const parsed = JSON.parse(log.at(-1)!);
    expect(parsed.ok).toBe(false);
    expect(parsed.command).toBe("restart");
    expect(parsed.error.tag).toBe("UsageError");
  });
});

describe("runRestart", () => {
  const makeEnv = (script?: Parameters<typeof makeRecordingRunner>[0]) => {
    const ctx = makeCtx(recipe, "feature/z", rootDir());
    const recording = makeRecordingRunner(script);
    const store = makeFakeStateStore([
      {
        composeProject: ctx.composeProjectName,
        projectId: "kl",
        databaseName: ctx.databaseName,
        rootDir: ctx.rootDir,
        worktreeName: ctx.worktreeName,
        branch: ctx.branch,
        odooHttpPort: ctx.odooHttpPort,
        shared: false,
        createdAt: "2026-06-01T00:00:00.000Z",
        lastUsedAt: "2026-06-01T00:00:00.000Z",
        templateDb: `${ctx.databaseName}__tpl`,
        templateKey: "tpl123",
        imageKey: null,
        imageBuiltAt: null,
      },
    ]);
    const layer = Layer.mergeAll(
      Layer.provide(DockerComposeLive, recording.layer),
      recording.layer,
      store.layer,
      makeFakePortProbe(new Set()),
    );
    const report = {
      json: false,
      say: () => Effect.void,
      action: () => Effect.void,
      setContext: () => Effect.void,
      setExitCode: () => Effect.void,
      setExtra: () => Effect.void,
    };
    return { ctx, recording, report, run: runWith(layer), store };
  };

  it("ensures db readiness, then restarts Odoo without rebuilding", async () => {
    const { ctx, recording, report, run } = makeEnv();
    await run(runRestart(recipe, ctx, { rebuild: false, logs: false }, report));
    const calls = joinedCalls(recording.calls);
    const indexOf = (needle: string) => calls.findIndex((c) => c.includes(needle));
    expect(indexOf("up -d db")).toBeGreaterThanOrEqual(0);
    expect(indexOf("pg_isready")).toBeGreaterThan(indexOf("up -d db"));
    expect(indexOf("restart odoo")).toBeGreaterThan(indexOf("pg_isready"));
    expect(calls.some((c) => c.includes("build odoo"))).toBe(false);
  });

  it("explains how to recover when fast restart has no Odoo container", async () => {
    const { ctx, report, run } = makeEnv((spec) =>
      spec.args.includes("restart") && spec.args.includes("odoo")
        ? {
            exitCode: 1,
            stdout: "",
            stderr: 'service "odoo" has no container to restart',
          }
        : undefined,
    );
    const error = await run(
      Effect.flip(runRestart(recipe, ctx, { rebuild: false, logs: false }, report)),
    );
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain("oad up --detach");
    expect(error.message).toContain("oad restart --rebuild");
  });

  it("--rebuild builds, removes only Odoo, recreates it, and records image metadata", async () => {
    const { ctx, recording, report, run, store } = makeEnv();
    await run(runRestart(recipe, ctx, { rebuild: true, logs: false }, report));
    const calls = joinedCalls(recording.calls);
    const indexOf = (needle: string) => calls.findIndex((c) => c.includes(needle));
    expect(indexOf("build odoo")).toBeGreaterThan(indexOf("pg_isready"));
    expect(indexOf("rm -sf odoo")).toBeGreaterThan(indexOf("build odoo"));
    expect(indexOf("up -d odoo")).toBeGreaterThan(indexOf("rm -sf odoo"));
    const row = store.rows.get(ctx.composeProjectName);
    expect(row?.templateDb).toBe(`${ctx.databaseName}__tpl`);
    expect(row?.templateKey).toBe("tpl123");
    expect(row?.imageKey).toMatch(/^[a-f0-9]{64}$/);
    expect(row?.imageBuiltAt).toBeTruthy();
  });
});
