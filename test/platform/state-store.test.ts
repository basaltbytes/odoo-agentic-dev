import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { StateStore, StateStoreLive } from "../../src/platform/state-store.js";
import type { EnvironmentUpsert, StateStoreApi } from "../../src/platform/state-store.js";
import { StateError } from "../../src/errors/errors.js";
import { makeFakeStateStore } from "../../src/testing/fake-adapters.js";

type Runner = <A>(program: Effect.Effect<A, StateError, StateStoreApi>) => Promise<A>;

const T1 = "2026-06-01T00:00:00.000Z";
const T2 = "2026-06-02T00:00:00.000Z";

const env = (overrides: Partial<EnvironmentUpsert> = {}): EnvironmentUpsert => ({
  composeProject: "kl_kl_feature_x",
  projectId: "kl",
  databaseName: "kl_feature_x",
  rootDir: "/work/kl",
  worktreeName: "feature-x",
  branch: "feature/x",
  odooHttpPort: 10018,
  shared: false,
  now: T1,
  ...overrides,
});

/** Behavior shared by the live store and the fake — they must agree. */
const sharedContract = (run: () => Runner): void => {
  it("upsert/get round-trips a full row (insert uses now for both timestamps)", async () => {
    const row = await run()(
      Effect.gen(function* () {
        const store = yield* StateStore;
        yield* store.upsert(env({ branch: null, shared: true }));
        return yield* store.get("kl_kl_feature_x");
      }),
    );
    expect(row).toEqual({
      composeProject: "kl_kl_feature_x",
      projectId: "kl",
      databaseName: "kl_feature_x",
      rootDir: "/work/kl",
      worktreeName: "feature-x",
      branch: null,
      odooHttpPort: 10018,
      shared: true,
      createdAt: T1,
      lastUsedAt: T1,
      templateDb: null,
      templateKey: null,
    });
  });

  it("get returns undefined for unknown projects", async () => {
    const row = await run()(
      Effect.gen(function* () {
        return yield* (yield* StateStore).get("nope");
      }),
    );
    expect(row).toBeUndefined();
  });

  it("upsert on conflict refreshes mutables but preserves createdAt and template", async () => {
    const row = await run()(
      Effect.gen(function* () {
        const store = yield* StateStore;
        yield* store.upsert(env());
        yield* store.setTemplate("kl_kl_feature_x", {
          databaseName: "kl_feature_x__tpl",
          key: "abcd1234",
        });
        yield* store.upsert(
          env({
            rootDir: "/work/kl-moved",
            branch: "feature/y",
            worktreeName: "feature-y",
            odooHttpPort: 10042,
            shared: true,
            now: T2,
          }),
        );
        return yield* store.get("kl_kl_feature_x");
      }),
    );
    expect(row).toEqual({
      composeProject: "kl_kl_feature_x",
      projectId: "kl",
      databaseName: "kl_feature_x",
      rootDir: "/work/kl-moved",
      worktreeName: "feature-y",
      branch: "feature/y",
      odooHttpPort: 10042,
      shared: true,
      createdAt: T1,
      lastUsedAt: T2,
      templateDb: "kl_feature_x__tpl",
      templateKey: "abcd1234",
    });
  });

  it("touch bumps lastUsedAt and nothing else", async () => {
    const [before, after] = await run()(
      Effect.gen(function* () {
        const store = yield* StateStore;
        yield* store.upsert(env());
        const pre = yield* store.get("kl_kl_feature_x");
        yield* store.touch("kl_kl_feature_x");
        const post = yield* store.get("kl_kl_feature_x");
        return [pre, post] as const;
      }),
    );
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after!.lastUsedAt > before!.lastUsedAt).toBe(true);
    expect({ ...after!, lastUsedAt: before!.lastUsedAt }).toEqual(before!);
  });

  it("list filters by projectId; no filter lists everything", async () => {
    const [mine, all] = await run()(
      Effect.gen(function* () {
        const store = yield* StateStore;
        yield* store.upsert(env({ composeProject: "kl_a", databaseName: "kl_a" }));
        yield* store.upsert(env({ composeProject: "kl_b", databaseName: "kl_b" }));
        yield* store.upsert(env({ composeProject: "ot_c", databaseName: "ot_c", projectId: "ot" }));
        return [yield* store.list({ projectId: "kl" }), yield* store.list({})] as const;
      }),
    );
    expect(mine.map((r) => r.composeProject)).toEqual(["kl_a", "kl_b"]);
    expect(all.map((r) => r.composeProject)).toEqual(["kl_a", "kl_b", "ot_c"]);
  });

  it("remove deletes the row (and tolerates unknown projects)", async () => {
    const row = await run()(
      Effect.gen(function* () {
        const store = yield* StateStore;
        yield* store.upsert(env());
        yield* store.remove("kl_kl_feature_x");
        yield* store.remove("never-existed");
        return yield* store.get("kl_kl_feature_x");
      }),
    );
    expect(row).toBeUndefined();
  });

  it("setTemplate(null) clears both template fields", async () => {
    const row = await run()(
      Effect.gen(function* () {
        const store = yield* StateStore;
        yield* store.upsert(env());
        yield* store.setTemplate("kl_kl_feature_x", {
          databaseName: "kl_feature_x__tpl",
          key: "abcd1234",
        });
        yield* store.setTemplate("kl_kl_feature_x", null);
        return yield* store.get("kl_kl_feature_x");
      }),
    );
    expect(row?.templateDb).toBeNull();
    expect(row?.templateKey).toBeNull();
  });
};

describe("StateStoreLive (real temp sqlite files)", () => {
  const tempDirs: Array<string> = [];
  const originalPath = process.env["ODOO_AGENTIC_DEV_STATE_DB"];

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "oad-state-"));
    tempDirs.push(dir);
    process.env["ODOO_AGENTIC_DEV_STATE_DB"] = join(dir, "state.db");
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env["ODOO_AGENTIC_DEV_STATE_DB"];
    else process.env["ODOO_AGENTIC_DEV_STATE_DB"] = originalPath;
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { force: true, recursive: true });
      } catch {
        // Windows may hold the file open until process exit; tmpdir cleanup handles it
      }
    }
  });

  const live: Runner = (program) => Effect.runPromise(program.pipe(Effect.provide(StateStoreLive)));

  sharedContract(() => live);

  it("schema creation is idempotent: sequential layers over one file share data", async () => {
    await live(
      Effect.gen(function* () {
        yield* (yield* StateStore).upsert(env());
      }),
    );
    // a second, fresh layer construction over the same file (WAL persistence)
    const row = await live(
      Effect.gen(function* () {
        return yield* (yield* StateStore).get("kl_kl_feature_x");
      }),
    );
    expect(row?.databaseName).toBe("kl_feature_x");
    expect(row?.createdAt).toBe(T1);
  });

  it("a corrupt state file surfaces a StateError", async () => {
    writeFileSync(
      process.env["ODOO_AGENTIC_DEV_STATE_DB"]!,
      "definitely not a sqlite database ".repeat(8),
    );
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        return yield* (yield* StateStore).list({});
      }).pipe(Effect.provide(StateStoreLive)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(error)).toBe(true);
      if (Option.isSome(error)) expect(error.value).toBeInstanceOf(StateError);
    }
  });
});

describe("makeFakeStateStore (in-memory parity)", () => {
  let fake = makeFakeStateStore();

  beforeEach(() => {
    fake = makeFakeStateStore();
  });

  const run: Runner = (program) => Effect.runPromise(program.pipe(Effect.provide(fake.layer)));

  sharedContract(() => run);

  it("exposes seeded rows and mutations through .rows for assertions", async () => {
    await run(
      Effect.gen(function* () {
        yield* (yield* StateStore).upsert(env());
      }),
    );
    expect(fake.rows.get("kl_kl_feature_x")?.databaseName).toBe("kl_feature_x");
  });
});
