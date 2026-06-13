import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import { reportPrune, runPrune } from "../../src/commands/prune.js";
import { DockerComposeLive } from "../../src/platform/docker-compose.js";
import { Git } from "../../src/platform/git.js";
import { GitError } from "../../src/errors/errors.js";
import type { EnvironmentRow } from "../../src/core/environment.js";
import type { GitApi } from "../../src/platform/git.js";
import {
  makeFakeGit,
  makeFakeStateStore,
  makeRecordingRunner,
} from "../../src/testing/fake-adapters.js";
import { runWith } from "../helpers.js";

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
  vi.restoreAllMocks();
});

const existingDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "oad-prune-"));
  tmp.push(dir);
  return dir;
};

const makeRow = (overrides: Partial<EnvironmentRow>): EnvironmentRow => ({
  composeProject: "kl_x",
  projectId: "kl",
  databaseName: "kl_x",
  rootDir: "/nonexistent/oad-prune-test",
  worktreeName: "x",
  branch: "x",
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
  readonly composeLs?: ReadonlyArray<{ Name: string; Status: string }>;
  readonly branches?: ReadonlySet<string>;
  readonly containers?: Record<string, ReadonlyArray<string>>;
  readonly volumes?: Record<string, ReadonlyArray<string>>;
  readonly gitLayer?: Layer.Layer<GitApi>;
}) => {
  const projectOf = (args: ReadonlyArray<string>): string =>
    String(
      args.find(
        (arg) => typeof arg === "string" && arg.startsWith("label=com.docker.compose.project="),
      ) ?? "",
    )
      .split("=")
      .at(-1) ?? "";
  const recording = makeRecordingRunner((spec) => {
    if (spec.args[0] === "compose" && spec.args[1] === "ls") {
      return { exitCode: 0, stdout: JSON.stringify(options.composeLs ?? []), stderr: "" };
    }
    if (spec.args[0] === "ps") {
      const ids = options.containers?.[projectOf(spec.args)] ?? [];
      return { exitCode: 0, stdout: ids.join("\n") + "\n", stderr: "" };
    }
    if (spec.args[0] === "volume" && spec.args[1] === "ls") {
      const names = options.volumes?.[projectOf(spec.args)] ?? [];
      return { exitCode: 0, stdout: names.join("\n") + "\n", stderr: "" };
    }
    return undefined;
  });
  const store = makeFakeStateStore(options.rows ?? []);
  const layer = Layer.mergeAll(
    Layer.provide(DockerComposeLive, recording.layer),
    store.layer,
    options.gitLayer ??
      makeFakeGit(
        { _tag: "Branch", branch: "main" },
        options.branches !== undefined ? { branches: options.branches } : undefined,
      ),
  );
  return { recording, run: runWith(layer), store };
};

const baseOptions = {
  olderThanDays: null,
  yes: false,
  allowShared: false,
  projectId: "kl" as string | undefined,
};

describe("runPrune", () => {
  it("an empty registry short-circuits without touching docker", async () => {
    const { recording, run } = makeEnv({ rows: [] });
    const report = await run(runPrune(baseOptions));
    expect(report).toEqual({ candidates: [], removed: [] });
    expect(recording.calls).toEqual([]);
  });

  it("dry run lists candidates and removes nothing", async () => {
    const { recording, run, store } = makeEnv({
      rows: [
        makeRow({ composeProject: "kl_vanished" }),
        makeRow({ composeProject: "kl_keep", rootDir: existingDir(), branch: "alive" }),
      ],
      composeLs: [{ Name: "kl_keep", Status: "running(2)" }],
      branches: new Set(["alive"]),
    });
    const report = await run(runPrune(baseOptions));
    expect(report.candidates.map((c) => [c.row.composeProject, c.reason])).toEqual([
      ["kl_vanished", "vanished"],
    ]);
    expect(report.removed).toEqual([]);
    expect(store.rows.size).toBe(2);
    expect(recording.calls.filter((c) => c.args[0] === "rm")).toEqual([]);
  });

  it("--yes tears down docker resources by label, then forgets the row", async () => {
    const { recording, run, store } = makeEnv({
      rows: [makeRow({ composeProject: "kl_gone", rootDir: existingDir(), branch: "dead" })],
      composeLs: [{ Name: "kl_gone", Status: "exited(2)" }],
      branches: new Set([]),
      containers: { kl_gone: ["c1", "c2"] },
      volumes: { kl_gone: ["v1"] },
    });
    const report = await run(runPrune({ ...baseOptions, yes: true }));
    expect(report.removed).toEqual([{ composeProject: "kl_gone", reason: "gone-branch" }]);
    expect(store.rows.has("kl_gone")).toBe(false);
    expect(recording.calls.map((c) => c.args).filter((args) => args[0] !== "compose")).toEqual([
      [
        "ps",
        "-aq",
        "--filter",
        "label=com.docker.compose.project=kl_gone",
        "--filter",
        "label=dev.basaltbytes.oad=1",
      ],
      ["rm", "-f", "c1", "c2"],
      [
        "volume",
        "ls",
        "-q",
        "--filter",
        "label=com.docker.compose.project=kl_gone",
        "--filter",
        "label=dev.basaltbytes.oad=1",
      ],
      ["volume", "rm", "v1"],
    ]);
  });

  it("vanished rows still get the label sweep (no-op here) before the row is forgotten", async () => {
    const { recording, run, store } = makeEnv({
      rows: [makeRow({ composeProject: "kl_vanished" })],
      composeLs: [],
    });
    const report = await run(runPrune({ ...baseOptions, yes: true }));
    expect(report.removed).toEqual([{ composeProject: "kl_vanished", reason: "vanished" }]);
    expect(store.rows.size).toBe(0);
    // a manual `docker compose down` removes the containers (row turns
    // vanished) but can leave labeled volumes behind — the sweep finds none
    // here, so nothing is rm'ed
    expect(recording.calls.map((c) => c.args)).toEqual([
      ["compose", "ls", "-a", "--format", "json"],
      [
        "ps",
        "-aq",
        "--filter",
        "label=com.docker.compose.project=kl_vanished",
        "--filter",
        "label=dev.basaltbytes.oad=1",
      ],
      [
        "volume",
        "ls",
        "-q",
        "--filter",
        "label=com.docker.compose.project=kl_vanished",
        "--filter",
        "label=dev.basaltbytes.oad=1",
      ],
    ]);
  });

  it("vanished rows with leftover labeled volumes get them removed", async () => {
    const { recording, run } = makeEnv({
      rows: [makeRow({ composeProject: "kl_vanished" })],
      composeLs: [],
      volumes: { kl_vanished: ["kl_vanished_db-data"] },
    });
    await run(runPrune({ ...baseOptions, yes: true }));
    expect(recording.calls.map((c) => c.args)).toContainEqual([
      "volume",
      "rm",
      "kl_vanished_db-data",
    ]);
  });

  it("shared rows are shielded unless allowShared", async () => {
    const rows = [makeRow({ composeProject: "kl_shared", shared: true })];
    const shielded = makeEnv({ rows, composeLs: [] });
    expect((await shielded.run(runPrune(baseOptions))).candidates).toEqual([]);
    const allowed = makeEnv({ rows, composeLs: [] });
    const report = await allowed.run(runPrune({ ...baseOptions, allowShared: true }));
    expect(report.candidates.map((c) => c.reason)).toEqual(["vanished"]);
  });

  it("stale rows only become candidates with olderThanDays", async () => {
    const rows = [
      makeRow({
        composeProject: "kl_old",
        rootDir: existingDir(),
        branch: "alive",
        lastUsedAt: "2020-01-01T00:00:00.000Z",
      }),
    ];
    const composeLs = [{ Name: "kl_old", Status: "exited(2)" }];
    const branches = new Set(["alive"]);
    const fresh = makeEnv({ rows, composeLs, branches });
    expect((await fresh.run(runPrune(baseOptions))).candidates).toEqual([]);
    const aged = makeEnv({ rows, composeLs, branches });
    const report = await aged.run(runPrune({ ...baseOptions, olderThanDays: 30 }));
    expect(report.candidates.map((c) => c.reason)).toEqual(["stale"]);
  });

  it("excludeComposeProject shields the calling environment", async () => {
    const rows = [makeRow({ composeProject: "kl_self" })];
    const excluded = makeEnv({ rows, composeLs: [] });
    const report = await excluded.run(
      runPrune({ ...baseOptions, yes: true, excludeComposeProject: "kl_self" }),
    );
    expect(report.candidates).toEqual([]);
    expect(excluded.store.rows.has("kl_self")).toBe(true);
  });

  it("a failing branch probe keeps the row (conservative null)", async () => {
    const failingGit = Layer.succeed(Git, {
      state: () => Effect.succeed({ _tag: "NotARepo" as const }),
      branchExists: () => Effect.fail(new GitError({ reason: "boom" })),
    });
    const { run } = makeEnv({
      rows: [makeRow({ composeProject: "kl_odd", rootDir: existingDir(), branch: "x" })],
      composeLs: [{ Name: "kl_odd", Status: "running(2)" }],
      gitLayer: failingGit,
    });
    const report = await run(runPrune(baseOptions));
    expect(report.candidates).toEqual([]);
  });
});

describe("reportPrune", () => {
  const candidate = {
    row: makeRow({ composeProject: "kl_gone", databaseName: "kl_gone" }),
    status: "stopped" as const,
    reason: "gone-branch" as const,
  };

  it("dry run with candidates prints the kill list and exits 1", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await Effect.runPromise(
      reportPrune({ candidates: [candidate], removed: [] }, { yes: false, json: false }),
    );
    const output = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toMatch(/kl_gone\s+kl_gone\s+just now\s+gone-branch/);
    expect(output).toMatch(/--yes/);
    expect(process.exitCode).toBe(1);
  });

  it("no candidates prints a quiet line and leaves the exit code alone", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await Effect.runPromise(
      reportPrune({ candidates: [], removed: [] }, { yes: false, json: false }),
    );
    expect(String(log.mock.calls[0])).toMatch(/Nothing to prune/);
    expect(process.exitCode).toBe(savedExitCode);
  });

  it("--yes prints a removal summary", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await Effect.runPromise(
      reportPrune(
        {
          candidates: [candidate],
          removed: [{ composeProject: "kl_gone", reason: "gone-branch" }],
        },
        { yes: true, json: false },
      ),
    );
    const output = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toMatch(/Removed 1 environment/);
    expect(process.exitCode).toBe(savedExitCode);
  });

  it("--json emits the report on stdout and keeps the exit-code contract", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await Effect.runPromise(
      reportPrune({ candidates: [candidate], removed: [] }, { yes: false, json: true }),
    );
    const parsed = JSON.parse(String(log.mock.calls[0]));
    expect(parsed.applied).toBe(false);
    expect(parsed.candidates[0]).toMatchObject({
      composeProject: "kl_gone",
      status: "stopped",
      reason: "gone-branch",
    });
    expect(parsed.removed).toEqual([]);
    expect(process.exitCode).toBe(1);
  });
});
