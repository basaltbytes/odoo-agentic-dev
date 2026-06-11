import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import {
  ensurePortAvailable,
  recordEnvironment,
  rowFromContext,
  warnOrAutoClean,
} from "../../src/commands/state-hooks.js";
import { DockerComposeLive } from "../../src/platform/docker-compose.js";
import { PortConflictError } from "../../src/errors/errors.js";
import type { EnvironmentRow } from "../../src/core/environment.js";
import {
  makeFakePortProbe,
  makeFakeStateStore,
  makeRecordingRunner,
} from "../../src/testing/fake-adapters.js";
import { makeCtx, makeRecipe, runWith } from "../helpers.js";

const tmp: Array<string> = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const existingDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "oad-sh-"));
  tmp.push(dir);
  return dir;
};

const recipe = makeRecipe({
  project: { id: "kl", dbPrefix: "kl", sharedDatabase: "kl_e2e_demo", sharedBranches: ["main"] },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
});
const onFeature = makeCtx(recipe, "feature/z");
const onMain = makeCtx(recipe, "main");

const makeRow = (overrides: Partial<EnvironmentRow>): EnvironmentRow => ({
  composeProject: "kl_other",
  projectId: "kl",
  databaseName: "kl_other",
  rootDir: "/nonexistent/oad-state-hooks-test",
  worktreeName: "other",
  branch: "other",
  odooHttpPort: 18200,
  shared: false,
  createdAt: "2026-06-01T00:00:00.000Z",
  lastUsedAt: new Date().toISOString(),
  templateDb: null,
  templateKey: null,
  ...overrides,
});

const makeEnv = (options: {
  readonly rows?: ReadonlyArray<EnvironmentRow>;
  readonly busy?: ReadonlySet<number>;
  readonly composeLs?: ReadonlyArray<{ Name: string; Status: string }>;
}) => {
  const recording = makeRecordingRunner((spec) =>
    spec.args.includes("ls")
      ? { exitCode: 0, stdout: JSON.stringify(options.composeLs ?? []), stderr: "" }
      : undefined,
  );
  const store = makeFakeStateStore(options.rows ?? []);
  const layer = Layer.mergeAll(
    Layer.provide(DockerComposeLive, recording.layer),
    store.layer,
    makeFakePortProbe(options.busy ?? new Set()),
  );
  return { run: runWith(layer), store };
};

describe("rowFromContext", () => {
  it("maps the context and derives the shared flag", () => {
    expect(rowFromContext(recipe, onFeature)).toEqual({
      composeProject: onFeature.composeProjectName,
      projectId: "kl",
      databaseName: onFeature.databaseName,
      rootDir: onFeature.rootDir,
      worktreeName: "feature/z",
      branch: "feature/z",
      odooHttpPort: onFeature.odooHttpPort,
      shared: false,
    });
    const sharedRow = rowFromContext(recipe, onMain);
    expect(sharedRow.databaseName).toBe("kl_e2e_demo");
    expect(sharedRow.shared).toBe(true);
  });
});

describe("recordEnvironment", () => {
  it("upserts the current environment keyed by compose project", async () => {
    const { run, store } = makeEnv({});
    await run(recordEnvironment(recipe, onFeature));
    const row = store.rows.get(onFeature.composeProjectName);
    expect(row).toMatchObject({
      projectId: "kl",
      databaseName: onFeature.databaseName,
      branch: "feature/z",
      odooHttpPort: onFeature.odooHttpPort,
      shared: false,
    });
  });
});

describe("ensurePortAvailable", () => {
  it("proceeds when the port is free", async () => {
    const { run } = makeEnv({});
    await expect(run(ensurePortAvailable(onFeature))).resolves.toBeUndefined();
  });

  it("proceeds when our own stack is already running on the port (idempotent up)", async () => {
    const { run } = makeEnv({
      busy: new Set([onFeature.odooHttpPort]),
      composeLs: [{ Name: onFeature.composeProjectName, Status: "running(2)" }],
    });
    await expect(run(ensurePortAvailable(onFeature))).resolves.toBeUndefined();
  });

  it("fails with the holder stack named when state knows it", async () => {
    const { run } = makeEnv({
      busy: new Set([onFeature.odooHttpPort]),
      rows: [makeRow({ composeProject: "kl_holder", odooHttpPort: onFeature.odooHttpPort })],
    });
    const error = await run(Effect.flip(ensurePortAvailable(onFeature)));
    expect(error).toBeInstanceOf(PortConflictError);
    expect(error).toMatchObject({ port: onFeature.odooHttpPort, holder: "kl_holder" });
  });

  it("fails with a null holder when no state row matches the port", async () => {
    const { run } = makeEnv({ busy: new Set([onFeature.odooHttpPort]) });
    const error = await run(Effect.flip(ensurePortAvailable(onFeature)));
    expect(error).toBeInstanceOf(PortConflictError);
    expect(error).toMatchObject({ port: onFeature.odooHttpPort, holder: null });
  });
});

describe("warnOrAutoClean", () => {
  it("warns about prune candidates, never counting the current environment", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { run } = makeEnv({
      rows: [
        // current environment: excluded even when docker does not list it yet
        makeRow({
          composeProject: onFeature.composeProjectName,
          databaseName: onFeature.databaseName,
          rootDir: onFeature.rootDir,
        }),
        // stack exists but its worktree directory is gone
        makeRow({ composeProject: "kl_gone" }),
        // healthy: stack exists, root dir exists, fresh
        makeRow({ composeProject: "kl_keep", rootDir: existingDir() }),
      ],
      composeLs: [
        { Name: "kl_gone", Status: "exited(2)" },
        { Name: "kl_keep", Status: "running(2)" },
      ],
    });
    const candidates = await run(warnOrAutoClean(recipe, onFeature));
    expect(candidates.map((c) => [c.row.composeProject, c.reason])).toEqual([
      ["kl_gone", "gone-rootdir"],
    ]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0])).toMatch(/1 stale environment.*odoo-agentic-dev prune/);
  });

  it("counts rows unused for longer than cleanup.maxAgeDays as stale", async () => {
    const { run } = makeEnv({
      rows: [
        makeRow({
          composeProject: "kl_old",
          rootDir: existingDir(),
          lastUsedAt: "2020-01-01T00:00:00.000Z",
        }),
      ],
      composeLs: [{ Name: "kl_old", Status: "exited(2)" }],
    });
    const candidates = await run(warnOrAutoClean(recipe, onFeature));
    expect(candidates.map((c) => c.reason)).toEqual(["stale"]);
  });

  it("skips shared rows and stays silent without candidates", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { run } = makeEnv({
      rows: [makeRow({ composeProject: "kl_shared", shared: true })],
      composeLs: [],
    });
    await expect(run(warnOrAutoClean(recipe, onFeature))).resolves.toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });
});
