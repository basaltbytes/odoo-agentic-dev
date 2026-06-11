import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import { guardReset, parseModulesFlag } from "../../src/commands/reset-db.js";
import { buildSetupSteps, runSetup } from "../../src/commands/setup.js";
import { withJsonReport } from "../../src/commands/json-report.js";
import { computeTemplateKey, templateDbName } from "../../src/core/environment.js";
import { SharedDatabaseProtectionError } from "../../src/errors/errors.js";
import { DockerComposeLive } from "../../src/platform/docker-compose.js";
import { OdooLifecycle } from "../../src/platform/odoo-lifecycle.js";
import {
  makeFakeGit,
  makeFakeStateStore,
  makeRecordingRunner,
} from "../../src/testing/fake-adapters.js";
import { makeCtx, makeRecipe, runSyncFailure, runSyncSuccess, runWith } from "../helpers.js";

const recipe = makeRecipe({
  project: { id: "kl", dbPrefix: "kl", sharedDatabase: "kl_e2e_demo", sharedBranches: ["main"] },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
  setup: {
    submodules: true,
    packageManagers: [
      { cwd: ".", command: "pnpm", args: ["install"] },
      { cwd: "frontend", command: "pnpm", args: ["install"] },
    ],
  },
});
const onMain = makeCtx(recipe, "main");
const onFeature = makeCtx(recipe, "feature/q");

describe("guardReset", () => {
  it("protects the shared database", () => {
    expect(runSyncFailure(guardReset(recipe, onMain, false))).toBeInstanceOf(
      SharedDatabaseProtectionError,
    );
    expect(() => runSyncSuccess(guardReset(recipe, onMain, true))).not.toThrow();
    expect(() => runSyncSuccess(guardReset(recipe, onFeature, false))).not.toThrow();
  });
});

describe("parseModulesFlag", () => {
  it("splits, trims, drops empties; undefined passes through", () => {
    expect(parseModulesFlag("KL_base, KL_sale ,")).toEqual(["KL_base", "KL_sale"]);
    expect(parseModulesFlag(undefined)).toBeUndefined();
  });
});

describe("buildSetupSteps", () => {
  it("orders submodules, installs, build, db reset", () => {
    const steps = buildSetupSteps(recipe, onFeature, { skipInstall: false, skipDb: false });
    expect(steps.map((s) => s.kind)).toEqual([
      "submodules",
      "install",
      "install",
      "build",
      "reset-db",
    ]);
    const install = steps[1] as { kind: "install"; cwd: string };
    // install cwd is resolved against rootDir with platform path semantics
    expect(install.cwd).toBe(resolve("/w", "."));
  });

  it("honors skip flags", () => {
    const steps = buildSetupSteps(recipe, onFeature, { skipInstall: true, skipDb: true });
    expect(steps.map((s) => s.kind)).toEqual(["submodules", "build"]);
  });
});

describe("runSetup", () => {
  const tmp: Array<string> = [];
  afterAll(() => {
    for (const dir of tmp) rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // regression (caught by the real-odoo rehearsal): template metadata is
  // written with an UPDATE keyed on the compose project, so the row must be
  // recorded BEFORE the reset step — a fresh `setup` used to record it last
  // and silently dropped its own snapshot
  it("records the environment before the reset step so a fresh setup keeps its snapshot", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "oad-setup-"));
    tmp.push(rootDir);
    const simple = makeRecipe({
      project: { id: "kl", dbPrefix: "kl" },
      odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
    });
    const ctx = makeCtx(simple, "feature/q", rootDir);
    const store = makeFakeStateStore();
    const lifecycleCalls: Array<string> = [];
    const record = (name: string) =>
      Effect.sync(() => {
        lifecycleCalls.push(name);
      });
    const lifecycle = Layer.succeed(OdooLifecycle, {
      resetDatabase: () => record("resetDatabase"),
      runPostInitHooks: () => record("runPostInitHooks"),
      updateModules: () => record("updateModules"),
      runTests: () =>
        record("runTests").pipe(Effect.as({ exitCode: 0, stdoutTail: "", stderrTail: "" })),
      snapshotTemplate: () => record("snapshotTemplate"),
      restoreFromTemplate: () => record("restoreFromTemplate"),
    });
    const recording = makeRecordingRunner((spec) =>
      spec.args[0] === "compose" && spec.args[1] === "ls"
        ? { exitCode: 0, stdout: "[]", stderr: "" }
        : undefined,
    );
    const layer = Layer.mergeAll(
      Layer.provide(DockerComposeLive, recording.layer),
      recording.layer,
      store.layer,
      lifecycle,
      makeFakeGit({ _tag: "Branch", branch: "feature/q" }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runWith(layer)(
      withJsonReport("setup", true, (report) =>
        runSetup(
          simple,
          ctx,
          {
            skipInstall: true,
            skipDb: false,
            allowShared: false,
            noTemplate: false,
            refreshTemplate: false,
          },
          report,
        ),
      ),
    );

    expect(lifecycleCalls).toEqual(["resetDatabase", "runPostInitHooks", "snapshotTemplate"]);
    expect(store.rows.get(ctx.composeProjectName)).toMatchObject({
      templateDb: templateDbName(ctx.databaseName),
      templateKey: computeTemplateKey(simple),
    });
    const parsed = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(parsed.actions).toContain("full-init");
    expect(parsed.actions).toContain("snapshot-template");
  });
});
