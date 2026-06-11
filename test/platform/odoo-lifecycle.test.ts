import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { OdooLifecycle, OdooLifecycleLive } from "../../src/platform/odoo-lifecycle.js";
import { DockerComposeLive } from "../../src/platform/docker-compose.js";
import { makeRecordingRunner } from "../../src/testing/fake-adapters.js";
import { makeCtx, makeRecipe, runWith } from "../helpers.js";

const tmp: Array<string> = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const makeEnv = (extraConfig: Record<string, unknown> = {}) => {
  const rootDir = mkdtempSync(join(tmpdir(), "oad-lc-"));
  tmp.push(rootDir);
  const recipe = makeRecipe({
    project: { id: "kl", dbPrefix: "kl" },
    odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
    database: { initialModules: ["KL_setup"], withoutDemo: "all" },
    ...extraConfig,
  });
  const ctx = makeCtx(recipe, "feature/z", rootDir);
  const recording = makeRecordingRunner();
  const run = runWith(
    Layer.provide(
      OdooLifecycleLive,
      Layer.merge(Layer.provide(DockerComposeLive, recording.layer), recording.layer),
    ),
  );
  return { ctx, recipe, recording, rootDir, run };
};

const joinedCalls = (recording: {
  calls: Array<{ command: string; args: ReadonlyArray<string> }>;
}) => recording.calls.map((c) => [c.command, ...c.args].join(" "));

describe("OdooLifecycle.resetDatabase", () => {
  it("runs the documented sequence: db up, wait, terminate, drop, create, filestore, init", async () => {
    const { ctx, recipe, recording, run } = makeEnv();
    await run(
      Effect.gen(function* () {
        const lifecycle = yield* OdooLifecycle;
        yield* lifecycle.resetDatabase(recipe, ctx, {});
      }),
    );
    const calls = joinedCalls(recording);
    const indexOf = (needle: string) => calls.findIndex((c) => c.includes(needle));
    expect(indexOf("up -d db")).toBeGreaterThanOrEqual(0);
    expect(indexOf("pg_isready")).toBeGreaterThan(indexOf("up -d db"));
    expect(indexOf("pg_terminate_backend")).toBeGreaterThan(indexOf("pg_isready"));
    expect(indexOf("DROP DATABASE")).toBeGreaterThan(indexOf("pg_terminate_backend"));
    expect(indexOf("CREATE DATABASE")).toBeGreaterThan(indexOf("DROP DATABASE"));
    expect(indexOf("filestore")).toBeGreaterThan(indexOf("CREATE DATABASE"));
    expect(indexOf("-i KL_setup")).toBeGreaterThan(indexOf("filestore"));
    expect(calls[indexOf("-i KL_setup")]).toContain("--without-demo=all");
  });
});

describe("OdooLifecycle.runPostInitHooks", () => {
  it("runs hooks in declared order: shell file via stdin, ir param, host command", async () => {
    const { ctx, recipe, recording, rootDir, run } = makeEnv({
      database: {
        initialModules: ["KL_setup"],
        postInit: [
          { type: "odoo-shell-file", file: "scripts/post-init.py" },
          { type: "set-ir-config-parameter", key: "web.base.url", value: "http://x" },
          { type: "command", command: "pnpm", args: ["seed"], cwd: "." },
        ],
      },
    });
    mkdirSync(join(rootDir, "scripts"), { recursive: true });
    writeFileSync(join(rootDir, "scripts", "post-init.py"), "print('post init')");
    await run(
      Effect.gen(function* () {
        const lifecycle = yield* OdooLifecycle;
        yield* lifecycle.runPostInitHooks(recipe, ctx);
      }),
    );
    const shellCalls = recording.calls.filter((c) => c.args.includes("shell"));
    expect(shellCalls).toHaveLength(2);
    expect(shellCalls[0]?.stdin).toContain("post init");
    expect(shellCalls[1]?.stdin).toContain("set_param");
    const host = recording.calls.at(-1)!;
    expect(host.command).toBe("pnpm");
    expect(host.args).toEqual(["seed"]);
    expect(host.env?.ODOO_DATABASE).toBe(ctx.databaseName);
  });
});

describe("OdooLifecycle.updateModules", () => {
  it("stops odoo, updates, restarts (unless restart=false)", async () => {
    const { ctx, recipe, recording, run } = makeEnv();
    await run(
      Effect.gen(function* () {
        const lifecycle = yield* OdooLifecycle;
        yield* lifecycle.updateModules(recipe, ctx, ["KL_base"], { restart: true });
      }),
    );
    const calls = joinedCalls(recording);
    const indexOf = (needle: string) => calls.findIndex((c) => c.includes(needle));
    expect(indexOf("stop odoo")).toBeGreaterThanOrEqual(0);
    expect(indexOf("-u KL_base")).toBeGreaterThan(indexOf("stop odoo"));
    expect(indexOf("up -d odoo")).toBeGreaterThan(indexOf("-u KL_base"));
  });

  it("skips the restart with restart=false", async () => {
    const { ctx, recipe, recording, run } = makeEnv();
    await run(
      Effect.gen(function* () {
        const lifecycle = yield* OdooLifecycle;
        yield* lifecycle.updateModules(recipe, ctx, ["KL_base"], { restart: false });
      }),
    );
    expect(joinedCalls(recording).some((c) => c.includes("up -d odoo"))).toBe(false);
  });
});

describe("OdooLifecycle.snapshotTemplate", () => {
  it("terminates sessions, drops the template, creates it from the db, copies the filestore", async () => {
    const { ctx, recipe, recording, run } = makeEnv();
    await run(
      Effect.gen(function* () {
        const lifecycle = yield* OdooLifecycle;
        yield* lifecycle.snapshotTemplate(recipe, ctx);
      }),
    );
    const db = ctx.databaseName;
    const tpl = `${db}__tpl`;
    const sql = recording.calls.filter((c) => c.args.includes("psql")).map((c) => c.args.at(-1));
    expect(sql).toEqual([
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid()`,
      `DROP DATABASE IF EXISTS "${tpl}"`,
      `CREATE DATABASE "${tpl}" TEMPLATE "${db}"`,
    ]);
    const calls = joinedCalls(recording);
    const indexOf = (needle: string) => calls.findIndex((c) => c.includes(needle));
    expect(indexOf("pg_isready")).toBeGreaterThan(indexOf("up -d db"));
    expect(indexOf("pg_terminate_backend")).toBeGreaterThan(indexOf("pg_isready"));
    expect(recording.calls.at(-1)?.args.slice(-8)).toEqual([
      "run",
      "--rm",
      "--no-deps",
      "--entrypoint",
      "/bin/sh",
      "odoo",
      "-c",
      `rm -rf /var/lib/odoo/filestore/${tpl} && if [ -d /var/lib/odoo/filestore/${db} ]; then cp -a /var/lib/odoo/filestore/${db} /var/lib/odoo/filestore/${tpl}; fi`,
    ]);
  });
});

describe("OdooLifecycle.restoreFromTemplate", () => {
  it("terminates sessions, drops the db, recreates it from the template, copies the filestore back", async () => {
    const { ctx, recipe, recording, run } = makeEnv();
    await run(
      Effect.gen(function* () {
        const lifecycle = yield* OdooLifecycle;
        yield* lifecycle.restoreFromTemplate(recipe, ctx);
      }),
    );
    const db = ctx.databaseName;
    const tpl = `${db}__tpl`;
    const sql = recording.calls.filter((c) => c.args.includes("psql")).map((c) => c.args.at(-1));
    expect(sql).toEqual([
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid()`,
      `DROP DATABASE IF EXISTS "${db}"`,
      `CREATE DATABASE "${db}" TEMPLATE "${tpl}"`,
    ]);
    expect(recording.calls.at(-1)?.args.at(-1)).toBe(
      `rm -rf /var/lib/odoo/filestore/${db} && if [ -d /var/lib/odoo/filestore/${tpl} ]; then cp -a /var/lib/odoo/filestore/${tpl} /var/lib/odoo/filestore/${db}; fi`,
    );
  });
});

describe("OdooLifecycle.runTests", () => {
  it("returns the odoo exit code and output tails without printing", async () => {
    const { ctx, recipe, run } = makeEnv();
    const result = await run(
      Effect.gen(function* () {
        const lifecycle = yield* OdooLifecycle;
        return yield* lifecycle.runTests(recipe, ctx, { tags: "payment" });
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdoutTail).toBe("");
    expect(result.stderrTail).toBe("");
  });
});
