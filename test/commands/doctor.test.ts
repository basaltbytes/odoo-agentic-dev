import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import {
  collectDoctorChecks,
  detectWsl,
  formatDoctorReport,
  hasHardFailure,
  nodeVersionOk,
} from "../../src/commands/doctor.js";
import type { DoctorCheck } from "../../src/commands/doctor.js";
import { DockerComposeLive } from "../../src/platform/docker-compose.js";
import { StateStore } from "../../src/platform/state-store.js";
import { StateError } from "../../src/errors/errors.js";
import { buildWorktreeContext } from "../../src/core/worktree-context.js";
import type { EnvironmentRow } from "../../src/core/environment.js";
import type { ExecSpec, ExecResult } from "../../src/platform/command-runner.js";
import type { StateStoreApi } from "../../src/platform/state-store.js";
import {
  makeFakeGit,
  makeFakePortProbe,
  makeFakeStateStore,
  makeRecordingRunner,
} from "../../src/testing/fake-adapters.js";
import { makeRecipe, runSyncSuccess, runWith } from "../helpers.js";

const tmp: Array<string> = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const CONFIG_SOURCE = `
export default {
  project: { id: "fixture", dbPrefix: "fx" },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/extra-addons/custom" }] }
}
`;

const writeConfig = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "oad-doctor-"));
  tmp.push(dir);
  const path = join(dir, "odoo-agentic-dev.config.mjs");
  writeFileSync(path, CONFIG_SOURCE);
  return path;
};

const recipe = makeRecipe({
  project: { id: "fixture", dbPrefix: "fx" },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/extra-addons/custom" }] },
});

const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "" });

const happyScript = (spec: ExecSpec): ExecResult | undefined => {
  if (spec.command === "docker" && spec.args[0] === "version") return ok("{}");
  if (spec.command === "docker" && spec.args[0] === "compose" && spec.args[1] === "version") {
    return ok("Docker Compose version v2.27.1\n");
  }
  if (spec.command === "docker" && spec.args[0] === "compose" && spec.args[1] === "ls") {
    return ok("[]");
  }
  if (spec.command === "git" && spec.args[0] === "--version") return ok("git version 2.43.0\n");
  return undefined;
};

const makeEnv = (options: {
  readonly rows?: ReadonlyArray<EnvironmentRow>;
  readonly busy?: ReadonlySet<number>;
  readonly script?: (spec: ExecSpec) => ExecResult | undefined;
  readonly storeLayer?: Layer.Layer<StateStoreApi>;
}) => {
  const recording = makeRecordingRunner((spec) => options.script?.(spec) ?? happyScript(spec));
  const store = makeFakeStateStore(options.rows ?? []);
  const layer = Layer.mergeAll(
    Layer.provide(DockerComposeLive, recording.layer),
    recording.layer,
    options.storeLayer ?? store.layer,
    makeFakePortProbe(options.busy ?? new Set()),
    makeFakeGit({ _tag: "Branch", branch: "main" }),
  );
  return { run: runWith(layer), store };
};

const byName = (checks: ReadonlyArray<DoctorCheck>, name: string): DoctorCheck => {
  const check = checks.find((c) => c.name === name);
  if (check === undefined) throw new Error(`missing check ${name}: ${JSON.stringify(checks)}`);
  return check;
};

/** The port doctor derives for the fixture config on branch main. */
const fixturePort = (): number =>
  runSyncSuccess(
    buildWorktreeContext({
      rootDir: "/irrelevant",
      recipe,
      env: process.env,
      git: { _tag: "Branch", branch: "main" },
    }),
  ).odooHttpPort;

describe("pure helpers", () => {
  it("nodeVersionOk enforces the >=22.15 floor", () => {
    expect(nodeVersionOk("22.15.0")).toBe(true);
    expect(nodeVersionOk("22.14.3")).toBe(false);
    expect(nodeVersionOk("23.0.0")).toBe(true);
    expect(nodeVersionOk("24.1.0")).toBe(true);
    expect(nodeVersionOk("21.9.0")).toBe(false);
  });

  it("detectWsl looks for microsoft in /proc/version", () => {
    expect(detectWsl(null)).toBe(false);
    expect(detectWsl("Linux version 5.15.90.1-microsoft-standard-WSL2")).toBe(true);
    expect(detectWsl("Linux version 6.1.0-13-amd64 (debian)")).toBe(false);
  });

  it("formatDoctorReport renders check marks and failure severity", () => {
    const report = formatDoctorReport([
      { name: "docker-daemon", ok: true, hard: true, detail: "responsive" },
      { name: "node-version", ok: false, hard: true, detail: "node 21" },
      { name: "config", ok: false, hard: false, detail: "missing" },
    ]);
    expect(report).toContain("✓ docker-daemon — responsive");
    expect(report).toContain("✗ node-version — node 21 (hard)");
    expect(report).toContain("✗ config — missing (soft)");
  });

  it("hasHardFailure ignores soft failures", () => {
    const soft: DoctorCheck = { name: "config", ok: false, hard: false, detail: "" };
    const hard: DoctorCheck = { name: "git", ok: false, hard: true, detail: "" };
    expect(hasHardFailure([soft])).toBe(false);
    expect(hasHardFailure([soft, hard])).toBe(true);
  });
});

describe("collectDoctorChecks", () => {
  it("reports green across the board on a healthy host with a valid config", async () => {
    const { run } = makeEnv({});
    const checks = await run(collectDoctorChecks(writeConfig()));
    for (const name of ["docker-daemon", "compose-v2", "node-version", "git", "state-db"]) {
      expect(byName(checks, name)).toMatchObject({ ok: true, hard: true });
    }
    expect(byName(checks, "config").ok).toBe(true);
    expect(byName(checks, "context")).toMatchObject({ ok: true, hard: false });
    expect(byName(checks, "context").detail).toContain("database fx_main");
    expect(byName(checks, "port")).toMatchObject({ ok: true, hard: true });
    expect(byName(checks, "port").detail).toMatch(/port \d+ is free/);
    expect(byName(checks, "port-collisions")).toMatchObject({ ok: true, hard: false });
    expect(byName(checks, "wsl")).toMatchObject({ ok: true, hard: false });
    expect(byName(checks, "prune-candidates")).toMatchObject({ ok: true, hard: false });
    expect(hasHardFailure(checks)).toBe(false);
  });

  it("docker daemon down is a hard failure but the report still completes", async () => {
    const { run } = makeEnv({
      script: (spec) =>
        spec.command === "docker" && spec.args[0] === "version"
          ? { exitCode: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }
          : undefined,
    });
    const checks = await run(collectDoctorChecks(writeConfig()));
    expect(byName(checks, "docker-daemon")).toMatchObject({ ok: false, hard: true });
    expect(byName(checks, "docker-daemon").detail).toContain("Cannot connect");
    expect(byName(checks, "compose-v2").ok).toBe(true);
    expect(hasHardFailure(checks)).toBe(true);
  });

  it("compose v1 fails the compose-v2 check", async () => {
    const { run } = makeEnv({
      script: (spec) =>
        spec.command === "docker" && spec.args[0] === "compose" && spec.args[1] === "version"
          ? ok("docker-compose version 1.29.2\n")
          : undefined,
    });
    const checks = await run(collectDoctorChecks(writeConfig()));
    expect(byName(checks, "compose-v2")).toMatchObject({ ok: false, hard: true });
  });

  it("missing config is soft and skips the context/port checks", async () => {
    const { run } = makeEnv({});
    const checks = await run(collectDoctorChecks("/nonexistent/odoo-agentic-dev.config.ts"));
    expect(byName(checks, "config")).toMatchObject({ ok: false, hard: false });
    expect(checks.find((c) => c.name === "context")).toBeUndefined();
    expect(checks.find((c) => c.name === "port")).toBeUndefined();
    expect(hasHardFailure(checks)).toBe(false);
  });

  it("a busy port held by a known stack stays ok; an unknown holder fails", async () => {
    const port = fixturePort();
    const known = makeEnv({
      busy: new Set([port]),
      rows: [
        {
          composeProject: "fixture_holder",
          projectId: "fixture",
          databaseName: "fx_holder",
          rootDir: "/w",
          worktreeName: "holder",
          branch: "holder",
          odooHttpPort: port,
          shared: false,
          createdAt: "2026-06-01T00:00:00.000Z",
          lastUsedAt: new Date().toISOString(),
          templateDb: null,
          templateKey: null,
        },
      ],
    });
    const knownChecks = await known.run(collectDoctorChecks(writeConfig()));
    expect(byName(knownChecks, "port")).toMatchObject({ ok: true, hard: true });
    expect(byName(knownChecks, "port").detail).toContain("fixture_holder");

    const unknown = makeEnv({ busy: new Set([port]) });
    const unknownChecks = await unknown.run(collectDoctorChecks(writeConfig()));
    expect(byName(unknownChecks, "port")).toMatchObject({ ok: false, hard: true });
    expect(byName(unknownChecks, "port").detail).toContain("unknown process");
  });

  it("reports port collisions among known stacks", async () => {
    const base = {
      projectId: "fixture",
      databaseName: "fx",
      rootDir: "/w",
      worktreeName: "w",
      branch: "w",
      shared: false,
      createdAt: "2026-06-01T00:00:00.000Z",
      lastUsedAt: new Date().toISOString(),
      templateDb: null,
      templateKey: null,
    };
    const { run } = makeEnv({
      rows: [
        { ...base, composeProject: "fixture_a", odooHttpPort: 18300 },
        { ...base, composeProject: "fixture_b", odooHttpPort: 18300 },
        // adopted rows with unknown ports never count as collisions
        { ...base, composeProject: "fixture_c", odooHttpPort: 0 },
        { ...base, composeProject: "fixture_d", odooHttpPort: 0 },
      ],
    });
    const checks = await run(collectDoctorChecks(writeConfig()));
    const collisions = byName(checks, "port-collisions");
    expect(collisions.ok).toBe(false);
    expect(collisions.detail).toContain("port 18300: fixture_a, fixture_b");
  });

  it("a broken state DB is a hard failure and degrades the dependent checks", async () => {
    const fail = <A>(label: string): Effect.Effect<A, StateError> =>
      Effect.fail(new StateError({ reason: `${label}: disk melted` }));
    const failingStore = Layer.succeed(StateStore, {
      upsert: () => fail("upsert"),
      touch: () => fail("touch"),
      get: () => fail("get"),
      list: () => fail("list"),
      remove: () => fail("remove"),
      setTemplate: () => fail("setTemplate"),
    });
    const { run } = makeEnv({ storeLayer: failingStore });
    const checks = await run(collectDoctorChecks(writeConfig()));
    expect(byName(checks, "state-db")).toMatchObject({ ok: false, hard: true });
    expect(checks.find((c) => c.name === "port-collisions")).toBeUndefined();
    expect(byName(checks, "prune-candidates")).toMatchObject({ ok: true, hard: false });
    expect(byName(checks, "prune-candidates").detail).toContain("skipped");
    expect(hasHardFailure(checks)).toBe(true);
  });

  it("counts prune candidates for the discovered project", async () => {
    const { run } = makeEnv({
      rows: [
        {
          composeProject: "fixture_gone",
          projectId: "fixture",
          databaseName: "fx_gone",
          rootDir: "/nonexistent/oad-doctor",
          worktreeName: "gone",
          branch: "gone",
          odooHttpPort: 18400,
          shared: false,
          createdAt: "2026-06-01T00:00:00.000Z",
          lastUsedAt: new Date().toISOString(),
          templateDb: null,
          templateKey: null,
        },
      ],
    });
    const checks = await run(collectDoctorChecks(writeConfig()));
    const prune = byName(checks, "prune-candidates");
    expect(prune.ok).toBe(false);
    expect(prune.detail).toContain("1 prune candidate");
  });
});
