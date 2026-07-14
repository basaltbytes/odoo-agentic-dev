import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { buildUpPlan, guardUpBuildFlags, guardUpJson } from "../../src/commands/up.js";
import {
  buildDownArgs,
  finalizeDownState,
  guardDown,
  runDownDocker,
} from "../../src/commands/down.js";
import { rowFromContext } from "../../src/commands/state-hooks.js";
import { SharedDatabaseProtectionError, UsageError } from "../../src/errors/errors.js";
import { makeFakeStateStore } from "../../src/testing/fake-adapters.js";
import type { DockerComposeApi, ComposeRef } from "../../src/platform/docker-compose.js";
import { ComposeCommandError } from "../../src/errors/errors.js";
import { makeCtx, makeRecipe, runSyncFailure, runSyncSuccess, runWith } from "../helpers.js";

const recipe = makeRecipe({
  project: { id: "kl", dbPrefix: "kl", sharedDatabase: "kl_e2e_demo", sharedBranches: ["main"] },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
  companionApps: [
    {
      name: "pwa",
      cwd: "frontend",
      command: "pnpm",
      args: ["dev"],
      portEnv: "PWA_PORT",
      env: { VITE_DB: "$ODOO_DATABASE" },
    },
  ],
});
const onMain = makeCtx(recipe, "main");
const onFeature = makeCtx(recipe, "feature/z");

describe("buildUpPlan", () => {
  it("builds compose args and companion specs with injected env", () => {
    const plan = buildUpPlan(recipe, onFeature, {
      odooOnly: false,
      detach: false,
      logs: false,
    });
    // never `--build`: the image gate decides before compose up runs
    expect(plan.upArgs).toEqual(["up", "-d", "odoo"]);
    expect(plan.companions).toHaveLength(1);
    const pwa = plan.companions[0]!;
    expect(pwa.name).toBe("pwa");
    // companion cwd is resolved against rootDir with platform path semantics
    expect(pwa.cwd).toBe(resolve("/w", "frontend"));
    expect(pwa.env.PWA_PORT).toBe(String(onFeature.companionPorts.get("pwa")));
    expect(pwa.env.VITE_DB).toBe(onFeature.databaseName);
    expect(pwa.env.ODOO_DATABASE).toBe(onFeature.databaseName);
  });

  it("--odoo-only drops companions", () => {
    const plan = buildUpPlan(recipe, onFeature, {
      odooOnly: true,
      detach: false,
      logs: false,
    });
    expect(plan.upArgs).toEqual(["up", "-d", "odoo"]);
    expect(plan.companions).toEqual([]);
  });
});

describe("guardUpBuildFlags", () => {
  it("rejects --build combined with --no-build", () => {
    const error = runSyncFailure(guardUpBuildFlags({ build: true, noBuild: true }));
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain("mutually exclusive");
  });

  it("allows each flag alone and neither", () => {
    for (const flags of [
      { build: true, noBuild: false },
      { build: false, noBuild: true },
      { build: false, noBuild: false },
    ]) {
      expect(() => runSyncSuccess(guardUpBuildFlags(flags))).not.toThrow();
    }
  });
});

describe("guardUpJson", () => {
  it("rejects attached --json with a --detach hint", () => {
    const error = runSyncFailure(guardUpJson({ json: true, detach: false }));
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain("--detach");
  });

  it("allows --detach --json, plain --json-less attached, and detached without json", () => {
    expect(() => runSyncSuccess(guardUpJson({ json: true, detach: true }))).not.toThrow();
    expect(() => runSyncSuccess(guardUpJson({ json: false, detach: false }))).not.toThrow();
    expect(() => runSyncSuccess(guardUpJson({ json: false, detach: true }))).not.toThrow();
  });

  it("the rejection surfaces as ok:false JSON when wrapped in withJsonReport", async () => {
    const { withJsonReport } = await import("../../src/commands/json-report.js");
    const log = [] as Array<string>;
    const spy = (line: unknown) => {
      log.push(String(line));
    };
    const original = console.log;
    console.log = spy as typeof console.log;
    try {
      await Effect.runPromise(
        withJsonReport("up", true, () => guardUpJson({ json: true, detach: false })),
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
    expect(parsed.command).toBe("up");
    expect(parsed.error.tag).toBe("UsageError");
    expect(parsed.error.message).toContain("--detach");
  });
});

describe("down guard", () => {
  it("refuses --volumes on the shared database without --allow-shared", () => {
    expect(
      runSyncFailure(guardDown(recipe, onMain, { volumes: true, allowShared: false })),
    ).toBeInstanceOf(SharedDatabaseProtectionError);
    expect(() =>
      runSyncSuccess(guardDown(recipe, onMain, { volumes: false, allowShared: false })),
    ).not.toThrow();
    expect(() =>
      runSyncSuccess(guardDown(recipe, onFeature, { volumes: true, allowShared: false })),
    ).not.toThrow();
    expect(() =>
      runSyncSuccess(guardDown(recipe, onMain, { volumes: true, allowShared: true })),
    ).not.toThrow();
  });

  it("buildDownArgs maps --volumes", () => {
    expect(buildDownArgs({ volumes: false })).toEqual(["down", "--remove-orphans"]);
    expect(buildDownArgs({ volumes: true })).toEqual(["down", "--remove-orphans", "--volumes"]);
  });

  it("falls back to label teardown when down --volumes cannot use the compose file", async () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const ref: ComposeRef = {
      projectName: onFeature.composeProjectName,
      composeFile: "/missing/docker-compose.yml",
      projectDir: "/w",
      env: {},
    };
    const compose: DockerComposeApi = {
      ensureAvailable: () => Effect.void,
      listProjects: () => Effect.succeed([]),
      listLabeledContainers: () => Effect.succeed([]),
      prepareComposeFile: () => Effect.succeed(ref),
      run: () => Effect.die("not used"),
      stream: (_ref, args) =>
        Effect.sync(() => {
          calls.push(args);
        }).pipe(
          Effect.andThen(
            Effect.fail(
              new ComposeCommandError({
                args,
                exitCode: 1,
                stderrTail: "missing compose file",
              }),
            ),
          ),
        ),
      tryRun: () => Effect.die("not used"),
      waitForDb: () => Effect.void,
      removeByLabel: (composeProject) =>
        Effect.sync(() => {
          calls.push(["removeByLabel", composeProject]);
        }),
      imageExists: () => Effect.succeed(false),
      listImageTags: () => Effect.succeed([]),
      removeImages: () => Effect.void,
      pruneBuildCache: () => Effect.succeed("Total reclaimed space: 0B"),
    };
    const mode = await Effect.runPromise(runDownDocker(compose, ref, onFeature, { volumes: true }));
    expect(mode).toBe("label-fallback");
    expect(calls).toEqual([
      ["down", "--remove-orphans", "--volumes"],
      ["removeByLabel", onFeature.composeProjectName],
    ]);
  });
});

describe("finalizeDownState", () => {
  const seed = () => {
    const store = makeFakeStateStore();
    store.rows.set(onFeature.composeProjectName, {
      ...rowFromContext(recipe, onFeature),
      createdAt: "2026-06-01T00:00:00.000Z",
      lastUsedAt: "2026-06-01T00:00:00.000Z",
      templateDb: null,
      templateKey: null,
      imageKey: null,
      imageBuiltAt: null,
    });
    return store;
  };

  it("plain down only touches the row", async () => {
    const store = seed();
    await runWith(store.layer)(finalizeDownState(onFeature, { volumes: false }));
    const row = store.rows.get(onFeature.composeProjectName);
    expect(row).toBeDefined();
    expect(row!.lastUsedAt).not.toBe("2026-06-01T00:00:00.000Z");
  });

  it("down --volumes removes the row", async () => {
    const store = seed();
    await runWith(store.layer)(finalizeDownState(onFeature, { volumes: true }));
    expect(store.rows.has(onFeature.composeProjectName)).toBe(false);
  });
});
