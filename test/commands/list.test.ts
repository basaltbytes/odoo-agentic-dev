import { describe, expect, it } from "vitest";
import { Layer } from "effect";
import { buildListTable, collectListEntries, relativeAge } from "../../src/commands/list.js";
import { DockerComposeLive } from "../../src/platform/docker-compose.js";
import type { EnvironmentRow } from "../../src/core/environment.js";
import type { ExecSpec, ExecResult } from "../../src/platform/command-runner.js";
import { makeFakeStateStore, makeRecordingRunner } from "../../src/testing/fake-adapters.js";
import { runWith } from "../helpers.js";

const NOW = "2026-06-11T12:00:00.000Z";

const makeRow = (overrides: Partial<EnvironmentRow>): EnvironmentRow => ({
  composeProject: "kl_a",
  projectId: "kl",
  databaseName: "kl_a",
  rootDir: "/w/a",
  worktreeName: "a",
  branch: "a",
  odooHttpPort: 18200,
  shared: false,
  createdAt: "2026-06-01T00:00:00.000Z",
  lastUsedAt: "2026-06-11T10:00:00.000Z",
  templateDb: null,
  templateKey: null,
  ...overrides,
});

const makeEnv = (options: {
  readonly rows?: ReadonlyArray<EnvironmentRow>;
  readonly composeLs?: ReadonlyArray<{ Name: string; Status: string }>;
  readonly labeledPs?: ReadonlyArray<{ Labels: string }>;
  readonly script?: (spec: ExecSpec) => ExecResult | undefined;
}) => {
  const recording = makeRecordingRunner((spec) => {
    const custom = options.script?.(spec);
    if (custom !== undefined) return custom;
    if (spec.args[0] === "compose" && spec.args[1] === "ls") {
      return { exitCode: 0, stdout: JSON.stringify(options.composeLs ?? []), stderr: "" };
    }
    if (spec.args[0] === "ps") {
      return {
        exitCode: 0,
        stdout: (options.labeledPs ?? []).map((entry) => JSON.stringify(entry)).join("\n"),
        stderr: "",
      };
    }
    return undefined;
  });
  const store = makeFakeStateStore(options.rows ?? []);
  const layer = Layer.mergeAll(Layer.provide(DockerComposeLive, recording.layer), store.layer);
  return { run: runWith(layer), store, recording };
};

describe("relativeAge", () => {
  it("buckets into just now / minutes / hours / days", () => {
    expect(relativeAge("2026-06-11T11:59:30.000Z", NOW)).toBe("just now");
    expect(relativeAge("2026-06-11T11:15:00.000Z", NOW)).toBe("45m ago");
    expect(relativeAge("2026-06-11T05:00:00.000Z", NOW)).toBe("7h ago");
    expect(relativeAge("2026-06-01T12:00:00.000Z", NOW)).toBe("10d ago");
    expect(relativeAge("garbage", NOW)).toBe("just now");
  });
});

describe("buildListTable", () => {
  it("renders aligned columns with shared/template flags", () => {
    const table = buildListTable(
      [
        { row: makeRow({}), status: "running" },
        {
          row: makeRow({
            composeProject: "kl_main",
            databaseName: "kl_e2e_demo",
            worktreeName: "main",
            shared: true,
            templateDb: "kl_e2e_demo__tpl",
            odooHttpPort: 18300,
            lastUsedAt: "2026-06-08T12:00:00.000Z",
          }),
          status: "stopped",
        },
        {
          row: makeRow({ composeProject: "kl_old", worktreeName: "old", odooHttpPort: 0 }),
          status: "vanished",
        },
      ],
      NOW,
    );
    const lines = table.split("\n");
    expect(lines[0]).toMatch(/^WORKTREE\s+DATABASE\s+PORT\s+STATUS\s+LAST USED\s+FLAGS$/);
    expect(lines[1]).toMatch(/^a\s+kl_a\s+18200\s+running\s+2h ago\s+-$/);
    expect(lines[2]).toMatch(/^main\s+kl_e2e_demo\s+18300\s+stopped\s+3d ago\s+shared template$/);
    // adopted rows have an unknown port
    expect(lines[3]).toMatch(/^old\s+kl_a\s+\?\s+vanished\s+2h ago\s+-$/);
  });
});

describe("collectListEntries", () => {
  it("reconciles statuses against docker compose ls", async () => {
    const { run } = makeEnv({
      rows: [
        makeRow({ composeProject: "kl_run" }),
        makeRow({ composeProject: "kl_stop" }),
        makeRow({ composeProject: "kl_gone" }),
      ],
      composeLs: [
        { Name: "kl_run", Status: "running(2)" },
        { Name: "kl_stop", Status: "exited(2)" },
      ],
    });
    const { dockerAvailable, entries } = await run(collectListEntries("kl"));
    expect(dockerAvailable).toBe(true);
    expect(entries.map((e) => [e.row.composeProject, e.status])).toEqual([
      ["kl_gone", "vanished"],
      ["kl_run", "running"],
      ["kl_stop", "stopped"],
    ]);
  });

  it("adopts labeled stacks missing from state, mapping the empty branch label to null", async () => {
    const { run, store } = makeEnv({
      rows: [],
      composeLs: [{ Name: "kl_adopted", Status: "running(2)" }],
      labeledPs: [
        {
          Labels:
            "com.docker.compose.project=kl_adopted,dev.basaltbytes.oad=1,dev.basaltbytes.oad.project-id=kl,dev.basaltbytes.oad.database=kl_adopted,dev.basaltbytes.oad.root-dir=/w/adopted,dev.basaltbytes.oad.branch=",
        },
        // incomplete labels: skipped rather than half-adopted
        { Labels: "com.docker.compose.project=kl_mystery,dev.basaltbytes.oad=1" },
      ],
    });
    const { entries } = await run(collectListEntries("kl"));
    expect(entries.map((e) => [e.row.composeProject, e.status])).toEqual([
      ["kl_adopted", "running"],
    ]);
    expect(store.rows.get("kl_adopted")).toMatchObject({
      projectId: "kl",
      databaseName: "kl_adopted",
      rootDir: "/w/adopted",
      worktreeName: "adopted",
      branch: null,
      odooHttpPort: 0,
      shared: false,
    });
    expect(store.rows.has("kl_mystery")).toBe(false);
  });

  it("filters by project id; undefined lists everything", async () => {
    const { run } = makeEnv({
      rows: [
        makeRow({ composeProject: "kl_a", projectId: "kl" }),
        makeRow({ composeProject: "ot_b", projectId: "other" }),
      ],
      composeLs: [],
    });
    const scoped = await run(collectListEntries("kl"));
    expect(scoped.entries.map((e) => e.row.composeProject)).toEqual(["kl_a"]);
    const all = await run(collectListEntries(undefined));
    expect(all.entries.map((e) => e.row.composeProject)).toEqual(["kl_a", "ot_b"]);
  });

  it("degrades gracefully when docker is unavailable", async () => {
    const { run } = makeEnv({
      rows: [makeRow({})],
      script: (spec) =>
        spec.command === "docker"
          ? { exitCode: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }
          : undefined,
    });
    const { dockerAvailable, entries } = await run(collectListEntries("kl"));
    expect(dockerAvailable).toBe(false);
    expect(entries.map((e) => [e.row.composeProject, e.status])).toEqual([["kl_a", "vanished"]]);
  });
});
