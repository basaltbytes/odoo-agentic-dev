import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import {
  decideImageBuild,
  ensureImageBuilt,
  ensurePortAvailable,
  imageStaleMessage,
  recordEnvironment,
  recordImageBuild,
  reportImageFreshness,
  rowFromContext,
  warnIfImageStale,
  warnOrAutoClean,
} from "../../src/commands/state-hooks.js";
import { DockerComposeLive } from "../../src/platform/docker-compose.js";
import { PortConflictError, UsageError } from "../../src/errors/errors.js";
import { OdooLifecycle } from "../../src/platform/odoo-lifecycle.js";
import type { EnvironmentRow } from "../../src/core/environment.js";
import {
  computeImageKeyForContext,
  imageReference,
  imageRepository,
} from "../../src/core/image-fingerprint.js";
import {
  makeFakeGit,
  makeFakePortProbe,
  makeFakeStateStore,
  makeRecordingRunner,
} from "../../src/testing/fake-adapters.js";
import { makeCtx, makeRecipe, runSyncSuccess, runWith } from "../helpers.js";

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
  imageKey: null,
  imageBuiltAt: null,
  ...overrides,
});

const makeEnv = (options: {
  readonly rows?: ReadonlyArray<EnvironmentRow>;
  readonly busy?: ReadonlySet<number>;
  readonly composeLs?: ReadonlyArray<{ Name: string; Status: string }>;
  readonly branches?: ReadonlySet<string>;
  /** local `repo:tag` references `docker image inspect` reports as existing */
  readonly images?: ReadonlySet<string>;
}) => {
  const recording = makeRecordingRunner((spec) => {
    if (spec.args[0] === "compose" && spec.args[1] === "ls") {
      return { exitCode: 0, stdout: JSON.stringify(options.composeLs ?? []), stderr: "" };
    }
    if (spec.args[0] === "ps" || (spec.args[0] === "volume" && spec.args[1] === "ls")) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (spec.args[0] === "image" && spec.args[1] === "inspect") {
      const exists = options.images?.has(String(spec.args[2])) === true;
      return { exitCode: exists ? 0 : 1, stdout: "", stderr: exists ? "" : "No such image" };
    }
    if (spec.args[0] === "image" && spec.args[1] === "ls") {
      const repo = String(spec.args[2]);
      const tags = [...(options.images ?? [])].filter((ref) => ref.startsWith(`${repo}:`));
      return { exitCode: 0, stdout: tags.join("\n") + "\n", stderr: "" };
    }
    return undefined;
  });
  const store = makeFakeStateStore(options.rows ?? []);
  const layer = Layer.mergeAll(
    Layer.provide(DockerComposeLive, recording.layer),
    store.layer,
    makeFakePortProbe(options.busy ?? new Set()),
    makeFakeGit(
      { _tag: "Branch", branch: "feature/z" },
      options.branches !== undefined ? { branches: options.branches } : undefined,
    ),
  );
  return { recording, run: runWith(layer), store };
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

describe("image freshness helpers", () => {
  const imageRecipe = makeRecipe({
    project: { id: "kl", dbPrefix: "kl" },
    odoo: {
      version: "18.0",
      build: { pipPackages: ["websocket-client"] },
      addons: [{ host: "addons", container: "/mnt/c" }],
    },
  });
  const imageCtx = makeCtx(imageRecipe, "feature/z");

  it("records a successful managed image build and reports it fresh", async () => {
    const { run, store } = makeEnv({});
    await run(recordEnvironment(imageRecipe, imageCtx));
    const freshness = await run(recordImageBuild(imageRecipe, imageCtx));
    const row = store.rows.get(imageCtx.composeProjectName);
    expect(freshness).toMatchObject({ managed: true, fresh: true });
    expect(row?.imageKey).toBe(freshness.expectedImageKey);
    expect(row?.imageBuiltAt).toBe(freshness.imageBuiltAt);
  });

  it("warns when a managed image has no matching recorded build", async () => {
    const lines: Array<string> = [];
    const { run } = makeEnv({});
    await run(recordEnvironment(imageRecipe, imageCtx));
    const freshness = await run(
      warnIfImageStale(imageRecipe, imageCtx, (line) =>
        Effect.sync(() => {
          lines.push(line);
        }),
      ),
    );
    expect(freshness.fresh).toBe(false);
    expect(imageStaleMessage(freshness)).toContain("restart --rebuild");
    expect(lines.join("\n")).toContain("Odoo image may be stale");
  });

  it("treats fingerprint failures as an advisory warning for non-build commands", async () => {
    const rootDir = existingDir();
    const missingInputRecipe = makeRecipe({
      project: { id: "kl", dbPrefix: "kl" },
      odoo: {
        version: "18.0",
        build: { pipRequirements: ["missing-requirements.txt"] },
        addons: [{ host: "addons", container: "/mnt/c" }],
      },
    });
    const missingInputCtx = makeCtx(missingInputRecipe, "feature/z", rootDir);
    const lines: Array<string> = [];
    const { run } = makeEnv({});
    await run(recordEnvironment(missingInputRecipe, missingInputCtx));
    const freshness = await run(
      warnIfImageStale(missingInputRecipe, missingInputCtx, (line) =>
        Effect.sync(() => {
          lines.push(line);
        }),
      ),
    );
    expect(freshness).toMatchObject({
      managed: true,
      fresh: null,
      expectedImageKey: null,
      recordedImageKey: null,
      imageBuiltAt: null,
    });
    expect(freshness.error).toContain("could not fingerprint Odoo image inputs");
    expect(lines.join("\n")).toContain("Continuing without freshness check");
  });

  it("treats an existing keyed tag as fresh even without a recorded build", async () => {
    const key = runSyncSuccess(computeImageKeyForContext(imageRecipe, imageCtx));
    const lines: Array<string> = [];
    const { run } = makeEnv({ images: new Set([imageReference(imageRecipe, key!)]) });
    await run(recordEnvironment(imageRecipe, imageCtx));
    const freshness = await run(
      warnIfImageStale(imageRecipe, imageCtx, (line) =>
        Effect.sync(() => {
          lines.push(line);
        }),
      ),
    );
    expect(freshness.fresh).toBe(true);
    expect(lines).toEqual([]);
  });

  describe("ensureImageBuilt", () => {
    const makeBuildEnv = (options: { readonly images?: ReadonlySet<string> }) => {
      const calls: Array<string> = [];
      const lifecycle = Layer.succeed(OdooLifecycle, {
        buildImage: () =>
          Effect.sync(() => {
            calls.push("buildImage");
          }),
        databaseExists: () => Effect.succeed(true),
        resetDatabase: () => Effect.void,
        runPostInitHooks: () => Effect.void,
        updateModules: () => Effect.void,
        runTests: () =>
          Effect.succeed({ exitCode: 0, stdout: "", stderr: "", stdoutTail: "", stderrTail: "" }),
        snapshotTemplate: () => Effect.void,
        restoreFromTemplate: () => Effect.void,
      });
      const recording = makeRecordingRunner((spec) => {
        if (spec.args[0] === "image" && spec.args[1] === "inspect") {
          const exists = options.images?.has(String(spec.args[2])) === true;
          return { exitCode: exists ? 0 : 1, stdout: "", stderr: exists ? "" : "No such image" };
        }
        if (spec.args[0] === "image" && spec.args[1] === "ls") {
          const repo = String(spec.args[2]);
          const tags = [...(options.images ?? [])].filter((ref) => ref.startsWith(`${repo}:`));
          return { exitCode: 0, stdout: tags.join("\n") + "\n", stderr: "" };
        }
        if (spec.args[0] === "image" && spec.args[1] === "rm") {
          calls.push(`imageRm:${spec.args.slice(3).join(",")}`);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return undefined;
      });
      const store = makeFakeStateStore();
      const run = runWith(
        Layer.mergeAll(Layer.provide(DockerComposeLive, recording.layer), store.layer, lifecycle),
      );
      const extras: Record<string, unknown> = {};
      const report = {
        json: true,
        say: () => Effect.void,
        action: (name: string) =>
          Effect.sync(() => {
            calls.push(`action:${name}`);
          }),
        setContext: () => Effect.void,
        setExitCode: () => Effect.void,
        setExtra: (key: string, value: unknown) =>
          Effect.sync(() => {
            extras[key] = value;
          }),
      };
      return { calls, extras, report, run, store };
    };

    it("builds and records when the keyed tag is missing, even if the command later fails", async () => {
      const { calls, extras, report, run, store } = makeBuildEnv({});
      const laterFailure = new UsageError({ issues: ["later lifecycle failure"] });
      const failure = await run(
        Effect.flip(
          Effect.gen(function* () {
            yield* recordEnvironment(imageRecipe, imageCtx);
            yield* ensureImageBuilt(imageRecipe, imageCtx, { force: false }, report);
            yield* Effect.fail(laterFailure);
          }),
        ),
      );
      expect(failure).toBe(laterFailure);
      expect(calls).toEqual(["buildImage", "action:build-image"]);
      expect(store.rows.get(imageCtx.composeProjectName)?.imageKey).toMatch(/^[a-f0-9]{64}$/);
      expect(extras).toMatchObject({ imageManaged: true, imageFresh: true, imageBuild: "build" });
    });

    it("skips the build when the keyed tag exists and adopts it into the row", async () => {
      const key = runSyncSuccess(computeImageKeyForContext(imageRecipe, imageCtx));
      const { calls, extras, report, run, store } = makeBuildEnv({
        images: new Set([imageReference(imageRecipe, key!)]),
      });
      const decision = await run(
        Effect.gen(function* () {
          yield* recordEnvironment(imageRecipe, imageCtx);
          return yield* ensureImageBuilt(imageRecipe, imageCtx, { force: false }, report);
        }),
      );
      expect(decision).toBe("skip-fresh");
      expect(calls).toEqual([]);
      expect(store.rows.get(imageCtx.composeProjectName)?.imageKey).toBe(key);
      expect(extras).toMatchObject({ imageBuild: "skip-fresh", imageFresh: true });
    });

    it("--build forces and sweeps superseded keyed tags nothing references", async () => {
      const staleRef = `${imageRepository(imageRecipe)}:0123456789ab`;
      const { calls, report, run } = makeBuildEnv({ images: new Set([staleRef]) });
      await run(
        Effect.gen(function* () {
          yield* recordEnvironment(imageRecipe, imageCtx);
          yield* ensureImageBuilt(imageRecipe, imageCtx, { force: true }, report);
        }),
      );
      expect(calls).toEqual(["buildImage", "action:build-image", `imageRm:${staleRef}`]);
    });

    it("skip warns instead of building", async () => {
      const { calls, extras, report, run } = makeBuildEnv({});
      const decision = await run(
        Effect.gen(function* () {
          yield* recordEnvironment(imageRecipe, imageCtx);
          return yield* ensureImageBuilt(
            imageRecipe,
            imageCtx,
            { force: false, skip: true },
            report,
          );
        }),
      );
      expect(decision).toBe("skip-flag");
      expect(calls).toEqual([]);
      expect(extras).toMatchObject({ imageBuild: "skip-flag", imageFresh: false });
    });
  });

  describe("decideImageBuild", () => {
    const base = {
      applicable: true,
      keyed: true,
      exists: false,
      rowFresh: false,
      force: false,
      skip: false,
    };
    it.each([
      ["stock images never build", { ...base, applicable: false }, "none"],
      ["skip wins over everything", { ...base, skip: true, force: true }, "skip-flag"],
      ["force always builds", { ...base, force: true, exists: true, rowFresh: true }, "build"],
      ["missing image builds", { ...base, exists: false }, "build"],
      ["keyed + existing tag skips", { ...base, exists: true }, "skip-fresh"],
      [
        "fixed-name + existing + fresh row skips",
        { ...base, keyed: false, exists: true, rowFresh: true },
        "skip-fresh",
      ],
      [
        "fixed-name + existing + stale row rebuilds",
        { ...base, keyed: false, exists: true, rowFresh: false },
        "build",
      ],
    ] as const)("%s", (_label, input, expected) => {
      expect(decideImageBuild(input)).toBe(expected);
    });
  });

  it("adds image freshness fields to json reports", async () => {
    const calls: Record<string, unknown> = {};
    const report = {
      json: true,
      say: () => Effect.void,
      action: () => Effect.void,
      setContext: () => Effect.void,
      setExitCode: () => Effect.void,
      setExtra: (key: string, value: unknown) =>
        Effect.sync(() => {
          calls[key] = value;
        }),
    };
    await Effect.runPromise(
      reportImageFreshness(report, {
        managed: true,
        fresh: false,
        expectedImageKey: "new",
        recordedImageKey: "old",
        imageBuiltAt: null,
        error: null,
      }),
    );
    expect(calls).toMatchObject({
      imageManaged: true,
      imageFresh: false,
      expectedImageKey: "new",
      recordedImageKey: "old",
      imageBuiltAt: null,
      imageFreshnessError: null,
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
  // auto-clean now defaults on; these tests pin the warn-only opt-out
  const warnRecipe = makeRecipe({
    project: { id: "kl", dbPrefix: "kl", sharedDatabase: "kl_e2e_demo", sharedBranches: ["main"] },
    odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
    cleanup: { auto: false },
  });

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
    const candidates = await run(warnOrAutoClean(warnRecipe, onFeature));
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
    const candidates = await run(warnOrAutoClean(warnRecipe, onFeature));
    expect(candidates.map((c) => c.reason)).toEqual(["stale"]);
  });

  it("detects deleted branches through the git probe", async () => {
    const { run } = makeEnv({
      rows: [
        makeRow({ composeProject: "kl_dead", rootDir: existingDir(), branch: "dead" }),
        makeRow({ composeProject: "kl_alive", rootDir: existingDir(), branch: "alive" }),
      ],
      composeLs: [
        { Name: "kl_dead", Status: "exited(2)" },
        { Name: "kl_alive", Status: "running(2)" },
      ],
      branches: new Set(["alive"]),
    });
    const candidates = await run(warnOrAutoClean(warnRecipe, onFeature));
    expect(candidates.map((c) => [c.row.composeProject, c.reason])).toEqual([
      ["kl_dead", "gone-branch"],
    ]);
  });

  it("skips shared rows and stays silent without candidates", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { run } = makeEnv({
      rows: [makeRow({ composeProject: "kl_shared", shared: true })],
      composeLs: [],
    });
    await expect(run(warnOrAutoClean(warnRecipe, onFeature))).resolves.toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("warnOrAutoClean with cleanup.auto", () => {
  const autoRecipe = makeRecipe({
    project: { id: "kl", dbPrefix: "kl", sharedDatabase: "kl_e2e_demo", sharedBranches: ["main"] },
    odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
    cleanup: { auto: true },
  });

  it("prunes candidates (vanished and stale) and reports each removal", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { run, store } = makeEnv({
      rows: [
        makeRow({ composeProject: "kl_vanished" }),
        makeRow({
          composeProject: "kl_stale",
          rootDir: existingDir(),
          branch: "alive",
          lastUsedAt: "2020-01-01T00:00:00.000Z",
        }),
        makeRow({ composeProject: "kl_keep", rootDir: existingDir(), branch: "alive" }),
      ],
      composeLs: [
        { Name: "kl_stale", Status: "exited(2)" },
        { Name: "kl_keep", Status: "running(2)" },
      ],
      branches: new Set(["alive"]),
    });
    const candidates = await run(warnOrAutoClean(autoRecipe, onFeature));
    expect(candidates.map((c) => c.row.composeProject).sort()).toEqual(["kl_stale", "kl_vanished"]);
    expect(store.rows.has("kl_vanished")).toBe(false);
    expect(store.rows.has("kl_stale")).toBe(false);
    expect(store.rows.has("kl_keep")).toBe(true);
    const output = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toMatch(/auto-clean: removed kl_vanished \(vanished\)/);
    expect(output).toMatch(/auto-clean: removed kl_stale \(stale\)/);
  });

  it("never touches shared rows or the current environment", async () => {
    const { run, store } = makeEnv({
      rows: [
        makeRow({ composeProject: "kl_shared", shared: true }),
        makeRow({
          composeProject: onFeature.composeProjectName,
          databaseName: onFeature.databaseName,
        }),
      ],
      composeLs: [],
    });
    await expect(run(warnOrAutoClean(autoRecipe, onFeature))).resolves.toEqual([]);
    expect(store.rows.has("kl_shared")).toBe(true);
    expect(store.rows.has(onFeature.composeProjectName)).toBe(true);
  });
});
