import { describe, expect, it } from "vitest";
import {
  TEMPLATE_SUFFIX,
  classifyEnvironments,
  computeTemplateKey,
  decideResetPath,
  templateDbName,
} from "../../src/core/environment.js";
import type { EnvironmentRow, PruneReason, ResetPath } from "../../src/core/environment.js";
import { makeRecipe } from "../helpers.js";

const row = (overrides: Partial<EnvironmentRow> = {}): EnvironmentRow => ({
  composeProject: "kl_kl_feature_x",
  projectId: "kl",
  databaseName: "kl_feature_x",
  rootDir: "/work/kl",
  worktreeName: "feature-x",
  branch: "feature/x",
  odooHttpPort: 10018,
  shared: false,
  createdAt: "2026-05-01T00:00:00.000Z",
  lastUsedAt: "2026-06-10T00:00:00.000Z",
  templateDb: null,
  templateKey: null,
  imageKey: null,
  imageBuiltAt: null,
  ...overrides,
});

const NOW = "2026-06-11T00:00:00.000Z";

describe("templateDbName", () => {
  it("appends the 5-char __tpl suffix", () => {
    expect(TEMPLATE_SUFFIX).toBe("__tpl");
    expect(TEMPLATE_SUFFIX).toHaveLength(5);
    expect(templateDbName("kl_feature_x")).toBe("kl_feature_x__tpl");
  });
});

describe("computeTemplateKey", () => {
  const base = {
    project: { id: "kl", dbPrefix: "kl" },
    odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/extra-addons" }] },
    database: { initialModules: ["base", "sale"], withoutDemo: "all" },
  };

  it("is an 8-char hex digest, stable across calls and recipe re-creation", () => {
    const key = computeTemplateKey(makeRecipe(base));
    expect(key).toMatch(/^[0-9a-f]{8}$/);
    expect(computeTemplateKey(makeRecipe(base))).toBe(key);
  });

  it.each([
    ["initialModules", { database: { ...base.database, initialModules: ["base"] } }],
    ["withoutDemo", { database: { ...base.database, withoutDemo: false as const } }],
    ["odoo.version", { odoo: { ...base.odoo, version: "19.0" } }],
    [
      "postInit",
      {
        database: {
          ...base.database,
          postInit: [{ type: "set-ir-config-parameter" as const, key: "k", value: "v" }],
        },
      },
    ],
  ])("changes when %s changes", (_label, patch) => {
    const key = computeTemplateKey(makeRecipe(base));
    expect(computeTemplateKey(makeRecipe({ ...base, ...patch }))).not.toBe(key);
  });

  it("ignores recipe parts not baked into the snapshot (ports, project id)", () => {
    const key = computeTemplateKey(makeRecipe(base));
    expect(
      computeTemplateKey(
        makeRecipe({
          ...base,
          project: { id: "other", dbPrefix: "ot" },
          ports: { odooBase: 23000 },
        }),
      ),
    ).toBe(key);
  });
});

describe("classifyEnvironments", () => {
  const classify = (input: {
    rows: ReadonlyArray<EnvironmentRow>;
    dockerProjects?: ReadonlyArray<{ name: string; running: boolean }>;
    probes?: ReadonlyMap<string, { rootDirExists: boolean; branchExists: boolean | null }>;
    olderThanDays?: number | null;
    allowShared?: boolean;
  }) =>
    classifyEnvironments({
      rows: input.rows,
      dockerProjects: input.dockerProjects ?? [],
      probes: input.probes ?? new Map(),
      olderThanDays: input.olderThanDays ?? null,
      allowShared: input.allowShared ?? false,
      now: NOW,
    });

  const okProbe = { rootDirExists: true, branchExists: true } as const;

  it("derives status from docker projects: running / stopped / vanished", () => {
    const rows = [
      row({ composeProject: "a" }),
      row({ composeProject: "b" }),
      row({ composeProject: "c" }),
    ];
    const [a, b, c] = classify({
      rows,
      dockerProjects: [
        { name: "a", running: true },
        { name: "b", running: false },
      ],
    });
    expect(a?.status).toBe("running");
    expect(b?.status).toBe("stopped");
    expect(c?.status).toBe("vanished");
  });

  type ReasonCase = {
    readonly label: string;
    readonly row: EnvironmentRow;
    readonly inDocker: boolean;
    readonly probe: { rootDirExists: boolean; branchExists: boolean | null } | undefined;
    readonly olderThanDays: number | null;
    readonly allowShared: boolean;
    readonly expected: PruneReason;
  };

  const cases: ReadonlyArray<ReasonCase> = [
    {
      label: "shared rows are skipped even when vanished (priority 1)",
      row: row({ shared: true }),
      inDocker: false,
      probe: { rootDirExists: false, branchExists: false },
      olderThanDays: 0,
      allowShared: false,
      expected: "shared-skipped",
    },
    {
      label: "allowShared disables the shared shield",
      row: row({ shared: true }),
      inDocker: false,
      probe: okProbe,
      olderThanDays: null,
      allowShared: true,
      expected: "vanished",
    },
    {
      label: "no docker project beats gone-rootdir (priority 2)",
      row: row(),
      inDocker: false,
      probe: { rootDirExists: false, branchExists: false },
      olderThanDays: null,
      allowShared: false,
      expected: "vanished",
    },
    {
      label: "missing root dir beats gone-branch (priority 3)",
      row: row(),
      inDocker: true,
      probe: { rootDirExists: false, branchExists: false },
      olderThanDays: null,
      allowShared: false,
      expected: "gone-rootdir",
    },
    {
      label: "deleted branch beats stale (priority 4)",
      row: row({ lastUsedAt: "2020-01-01T00:00:00.000Z" }),
      inDocker: true,
      probe: { rootDirExists: true, branchExists: false },
      olderThanDays: 1,
      allowShared: false,
      expected: "gone-branch",
    },
    {
      label: "stale when older than the threshold",
      row: row({ lastUsedAt: "2026-05-01T00:00:00.000Z" }),
      inDocker: true,
      probe: okProbe,
      olderThanDays: 30,
      allowShared: false,
      expected: "stale",
    },
    {
      label: "not stale at exactly the threshold",
      row: row({ lastUsedAt: "2026-05-12T00:00:00.000Z" }),
      inDocker: true,
      probe: okProbe,
      olderThanDays: 30,
      allowShared: false,
      expected: "keep",
    },
    {
      label: "age ignored when olderThanDays is null",
      row: row({ lastUsedAt: "2020-01-01T00:00:00.000Z" }),
      inDocker: true,
      probe: okProbe,
      olderThanDays: null,
      allowShared: false,
      expected: "keep",
    },
    {
      label: "branchExists null (not a repo / detached) never means gone-branch",
      row: row({ branch: null }),
      inDocker: true,
      probe: { rootDirExists: true, branchExists: null },
      olderThanDays: null,
      allowShared: false,
      expected: "keep",
    },
    {
      label: "missing probe defaults to keep (conservative)",
      row: row(),
      inDocker: true,
      probe: undefined,
      olderThanDays: null,
      allowShared: false,
      expected: "keep",
    },
    {
      label: "healthy row is kept",
      row: row(),
      inDocker: true,
      probe: okProbe,
      olderThanDays: 30,
      allowShared: false,
      expected: "keep",
    },
  ];

  it.each(cases)("$label", ({ allowShared, expected, inDocker, olderThanDays, probe, row: r }) => {
    const result = classify({
      rows: [r],
      dockerProjects: inDocker ? [{ name: r.composeProject, running: true }] : [],
      probes: probe === undefined ? new Map() : new Map([[r.composeProject, probe]]),
      olderThanDays,
      allowShared,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.row).toBe(r);
    expect(result[0]?.reason).toBe(expected);
  });
});

describe("decideResetPath", () => {
  const KEY = "abcd1234";
  const matching = row({ templateDb: "kl_feature_x__tpl", templateKey: KEY });
  type DecideInput = {
    row?: EnvironmentRow | undefined;
    expectedKey?: string;
    databaseName?: string;
    noTemplate?: boolean;
    refreshTemplate?: boolean;
    hasOverrides?: boolean;
    templateEnabled?: boolean;
  };
  const decide = (input: DecideInput) =>
    decideResetPath({
      row: input.row,
      expectedKey: input.expectedKey ?? KEY,
      databaseName: input.databaseName ?? "kl_feature_x",
      noTemplate: input.noTemplate ?? false,
      refreshTemplate: input.refreshTemplate ?? false,
      hasOverrides: input.hasOverrides ?? false,
      templateEnabled: input.templateEnabled ?? true,
    });

  const longName = "a".repeat(59);

  const cases: ReadonlyArray<readonly [string, DecideInput, ResetPath]> = [
    [
      "overrides force full even with a matching template",
      { row: matching, hasOverrides: true },
      "full",
    ],
    [
      "overrides beat refreshTemplate",
      { row: matching, hasOverrides: true, refreshTemplate: true },
      "full",
    ],
    [
      "refreshTemplate forces a new snapshot",
      { row: matching, refreshTemplate: true },
      "full-then-snapshot",
    ],
    [
      "refreshTemplate with an over-budget name degrades to full",
      { row: matching, refreshTemplate: true, databaseName: longName },
      "full",
    ],
    [
      "noTemplate forces full, keeping the template row",
      { row: matching, noTemplate: true },
      "full",
    ],
    [
      "disabled template caching forces full even with a matching template",
      { row: matching, templateEnabled: false },
      "full",
    ],
    ["no state row → full init then snapshot", { row: undefined }, "full-then-snapshot"],
    [
      "row without a template → full init then snapshot",
      { row: row({ templateDb: null, templateKey: null }) },
      "full-then-snapshot",
    ],
    [
      "template key mismatch → full init then re-snapshot",
      { row: row({ templateDb: "kl_feature_x__tpl", templateKey: "deadbeef" }) },
      "full-then-snapshot",
    ],
    ["matching template restores", { row: matching }, "restore"],
    [
      "matching template but name over budget → full (no restore, no snapshot)",
      {
        row: row({ templateDb: `${longName.slice(0, 53)}__tpl`, templateKey: KEY }),
        databaseName: longName,
      },
      "full",
    ],
    ["no row and over-budget name → full", { row: undefined, databaseName: longName }, "full"],
    [
      "name exactly at the 58-char budget still snapshots",
      { row: undefined, databaseName: "a".repeat(58) },
      "full-then-snapshot",
    ],
  ];

  it.each(cases)("%s", (_label, input, expected) => {
    expect(decide(input)).toBe(expected);
  });
});
