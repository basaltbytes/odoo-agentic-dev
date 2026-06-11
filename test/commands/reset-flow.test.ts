import { describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import { runResetFlow } from "../../src/commands/reset-db.js";
import type { ResetFlowOptions } from "../../src/commands/reset-db.js";
import { rowFromContext } from "../../src/commands/state-hooks.js";
import { OdooLifecycle } from "../../src/platform/odoo-lifecycle.js";
import type { OdooLifecycleApi } from "../../src/platform/odoo-lifecycle.js";
import { computeTemplateKey, templateDbName } from "../../src/core/environment.js";
import { makeFakeStateStore } from "../../src/testing/fake-adapters.js";
import { makeCtx, makeRecipe, runWith } from "../helpers.js";

vi.spyOn(console, "log").mockImplementation(() => {});

const recipe = makeRecipe({
  project: { id: "kl", dbPrefix: "kl" },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
  database: { initialModules: ["KL_setup"], postInit: [{ type: "odoo-shell-inline", code: "x" }] },
});
const ctx = makeCtx(recipe, "feature/z");
const expectedKey = computeTemplateKey(recipe);
const tplName = templateDbName(ctx.databaseName);

const makeFakeLifecycle = (): {
  readonly calls: Array<string>;
  readonly layer: Layer.Layer<OdooLifecycleApi>;
} => {
  const calls: Array<string> = [];
  const record = (name: string) =>
    Effect.sync(() => {
      calls.push(name);
    });
  return {
    calls,
    layer: Layer.succeed(OdooLifecycle, {
      resetDatabase: () => record("resetDatabase"),
      runPostInitHooks: () => record("runPostInitHooks"),
      updateModules: () => record("updateModules"),
      runTests: () =>
        record("runTests").pipe(Effect.as({ exitCode: 0, stdoutTail: "", stderrTail: "" })),
      snapshotTemplate: () => record("snapshotTemplate"),
      restoreFromTemplate: () => record("restoreFromTemplate"),
    }),
  };
};

const seedRow = (template: { databaseName: string; key: string } | null) => {
  const store = makeFakeStateStore();
  store.rows.set(ctx.composeProjectName, {
    ...rowFromContext(recipe, ctx),
    createdAt: "2026-06-01T00:00:00.000Z",
    lastUsedAt: "2026-06-01T00:00:00.000Z",
    templateDb: template?.databaseName ?? null,
    templateKey: template?.key ?? null,
  });
  return store;
};

const baseOptions: ResetFlowOptions = {
  noTemplate: false,
  refreshTemplate: false,
  modules: undefined,
  withoutDemo: undefined,
};

const runFlow = (
  store: ReturnType<typeof makeFakeStateStore>,
  lifecycle: ReturnType<typeof makeFakeLifecycle>,
  options: Partial<ResetFlowOptions> = {},
) =>
  runWith(Layer.merge(store.layer, lifecycle.layer))(
    runResetFlow(recipe, ctx, { ...baseOptions, ...options }),
  );

describe("runResetFlow", () => {
  it("restores from the template (no hooks, no snapshot) when the key matches", async () => {
    const store = seedRow({ databaseName: tplName, key: expectedKey });
    const lifecycle = makeFakeLifecycle();
    await expect(runFlow(store, lifecycle)).resolves.toBe("restore");
    expect(lifecycle.calls).toEqual(["restoreFromTemplate"]);
  });

  it("runs full init + snapshot + setTemplate when no template exists", async () => {
    const store = seedRow(null);
    const lifecycle = makeFakeLifecycle();
    await expect(runFlow(store, lifecycle)).resolves.toBe("full-then-snapshot");
    expect(lifecycle.calls).toEqual(["resetDatabase", "runPostInitHooks", "snapshotTemplate"]);
    expect(store.rows.get(ctx.composeProjectName)).toMatchObject({
      templateDb: tplName,
      templateKey: expectedKey,
    });
  });

  it("a key mismatch forces full init + re-snapshot", async () => {
    const store = seedRow({ databaseName: tplName, key: "stale123" });
    const lifecycle = makeFakeLifecycle();
    await expect(runFlow(store, lifecycle)).resolves.toBe("full-then-snapshot");
    expect(lifecycle.calls).toEqual(["resetDatabase", "runPostInitHooks", "snapshotTemplate"]);
    expect(store.rows.get(ctx.composeProjectName)?.templateKey).toBe(expectedKey);
  });

  it("--no-template runs the full path without snapshotting, keeping the template row", async () => {
    const store = seedRow({ databaseName: tplName, key: expectedKey });
    const lifecycle = makeFakeLifecycle();
    await expect(runFlow(store, lifecycle, { noTemplate: true })).resolves.toBe("full");
    expect(lifecycle.calls).toEqual(["resetDatabase", "runPostInitHooks"]);
    expect(store.rows.get(ctx.composeProjectName)).toMatchObject({
      templateDb: tplName,
      templateKey: expectedKey,
    });
  });

  it("--refresh-template snapshots again even when the key matches", async () => {
    const store = seedRow({ databaseName: tplName, key: expectedKey });
    const lifecycle = makeFakeLifecycle();
    await expect(runFlow(store, lifecycle, { refreshTemplate: true })).resolves.toBe(
      "full-then-snapshot",
    );
    expect(lifecycle.calls).toEqual(["resetDatabase", "runPostInitHooks", "snapshotTemplate"]);
  });

  it("module/demo overrides force the full path with no snapshot, template row preserved", async () => {
    const store = seedRow({ databaseName: tplName, key: expectedKey });
    const lifecycle = makeFakeLifecycle();
    await expect(runFlow(store, lifecycle, { modules: ["KL_other"] })).resolves.toBe("full");
    expect(lifecycle.calls).toEqual(["resetDatabase", "runPostInitHooks"]);
    expect(store.rows.get(ctx.composeProjectName)).toMatchObject({
      templateDb: tplName,
      templateKey: expectedKey,
    });
  });
});
