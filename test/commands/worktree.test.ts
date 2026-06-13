import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import {
  defaultWorktreePath,
  makeStepLogger,
  parseCreateHookPayload,
  parseRemoveHookPayload,
  planCopyFiles,
  resolveBaseRef,
  runWorktreeCreate,
  runWorktreeRemove,
  runWorktreeRemoveHook,
  withStdoutRedirectedToStderr,
} from "../../src/commands/worktree.js";
import { DockerComposeLive } from "../../src/platform/docker-compose.js";
import { OdooLifecycle } from "../../src/platform/odoo-lifecycle.js";
import { GENERATED_COMPOSE_RELATIVE_PATH } from "../../src/core/compose-model.js";
import type { ExecResult, ExecSpec } from "../../src/platform/command-runner.js";
import {
  makeFakeGit,
  makeFakeStateStore,
  makeRecordingRunner,
} from "../../src/testing/fake-adapters.js";
import { makeRecipe, runSyncFailure, runSyncSuccess, runWith } from "../helpers.js";

const tmp: Array<string> = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const CONFIG_SOURCE = `export default {
  project: { id: "kl", dbPrefix: "kl" },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
}
`;

describe("parseCreateHookPayload", () => {
  it("extracts worktree_name and worktree_path", () => {
    expect(
      runSyncSuccess(parseCreateHookPayload('{"worktree_name":"pay","worktree_path":"/tmp/wt"}')),
    ).toEqual({ worktreeName: "pay", worktreePath: "/tmp/wt" });
  });

  it("fails ConfigValidationError when a field is missing or not a string", () => {
    for (const bad of [
      '{"worktree_path":"/tmp/wt"}',
      '{"worktree_name":"pay"}',
      '{"worktree_name":42,"worktree_path":"/tmp/wt"}',
      '{"worktree_name":"","worktree_path":"/tmp/wt"}',
      "not json at all",
    ]) {
      expect(runSyncFailure(parseCreateHookPayload(bad))._tag).toBe("ConfigValidationError");
    }
  });
});

describe("parseRemoveHookPayload", () => {
  it("extracts worktree_path", () => {
    expect(runSyncSuccess(parseRemoveHookPayload('{"worktree_path":"/tmp/wt"}'))).toEqual({
      worktreePath: "/tmp/wt",
    });
  });

  it("fails ConfigValidationError on a missing path or invalid JSON", () => {
    expect(runSyncFailure(parseRemoveHookPayload("{}"))._tag).toBe("ConfigValidationError");
    expect(runSyncFailure(parseRemoveHookPayload("nope"))._tag).toBe("ConfigValidationError");
  });
});

describe("resolveBaseRef", () => {
  it("prefers the flag, then the env var, then origin HEAD, then HEAD", () => {
    expect(
      resolveBaseRef({
        flag: "origin/release",
        env: { ODOO_WORKTREE_BASE_REF: "origin/env" },
        originHead: "refs/remotes/origin/main",
      }),
    ).toBe("origin/release");
    expect(
      resolveBaseRef({
        flag: undefined,
        env: { ODOO_WORKTREE_BASE_REF: "origin/env" },
        originHead: "refs/remotes/origin/main",
      }),
    ).toBe("origin/env");
    expect(
      resolveBaseRef({ flag: undefined, env: {}, originHead: "refs/remotes/origin/main" }),
    ).toBe("origin/main");
    expect(resolveBaseRef({ flag: undefined, env: {}, originHead: undefined })).toBe("HEAD");
  });

  it("treats an empty env var as unset (shell [[ -n ]] parity)", () => {
    expect(
      resolveBaseRef({
        flag: undefined,
        env: { ODOO_WORKTREE_BASE_REF: "" },
        originHead: undefined,
      }),
    ).toBe("HEAD");
  });
});

describe("defaultWorktreePath", () => {
  it("is the sibling <repo-basename>-<name> of the project root", () => {
    expect(defaultWorktreePath("/repos/kriss-laure", "payment")).toBe(
      resolve("/repos/kriss-laure-payment"),
    );
  });
});

describe("planCopyFiles", () => {
  it("splits files into copy (exists in root) and skip", () => {
    const exists = (path: string) => path === join("/root", ".env.e2e");
    expect(planCopyFiles([".env.e2e", "missing.env"], "/root", exists)).toEqual({
      copy: [".env.e2e"],
      skip: ["missing.env"],
    });
  });
});

describe("makeStepLogger", () => {
  it("appends lines to the log file, creating its directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oad-wt-log-"));
    tmp.push(dir);
    const logFile = join(dir, "nested", "remove.log");
    const log = makeStepLogger(logFile, () => Effect.void);
    await Effect.runPromise(log("step one"));
    await Effect.runPromise(log("step two"));
    expect(readFileSync(logFile, "utf8")).toBe("step one\nstep two\n");
  });

  it("falls back to the provided sink without a log file", async () => {
    const lines: Array<string> = [];
    const log = makeStepLogger(undefined, (line) =>
      Effect.sync(() => {
        lines.push(line);
      }),
    );
    await Effect.runPromise(log("hello"));
    expect(lines).toEqual(["hello"]);
  });
});

describe("withStdoutRedirectedToStderr", () => {
  it("routes stdout writes to stderr during the effect and restores after", async () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const originalWrite = process.stdout.write;
    await Effect.runPromise(
      withStdoutRedirectedToStderr(
        Effect.sync(() => {
          process.stdout.write("diverted\n");
        }),
      ),
    );
    expect(errSpy).toHaveBeenCalledWith("diverted\n");
    expect(process.stdout.write).toBe(originalWrite);
  });

  it("restores stdout on failure too", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const originalWrite = process.stdout.write;
    await expect(
      Effect.runPromise(withStdoutRedirectedToStderr(Effect.fail(new Error("boom")))),
    ).rejects.toThrow();
    expect(process.stdout.write).toBe(originalWrite);
  });
});

const makeLifecycle = (calls: Array<string>) => {
  const record = (name: string) =>
    Effect.sync(() => {
      calls.push(name);
    });
  return Layer.succeed(OdooLifecycle, {
    databaseExists: () => record("databaseExists").pipe(Effect.as(true)),
    resetDatabase: () => record("resetDatabase"),
    runPostInitHooks: () => record("runPostInitHooks"),
    updateModules: () => record("updateModules"),
    runTests: () =>
      record("runTests").pipe(Effect.as({ exitCode: 0, stdoutTail: "", stderrTail: "" })),
    snapshotTemplate: () => record("snapshotTemplate"),
    restoreFromTemplate: () => record("restoreFromTemplate"),
  });
};

describe("runWorktreeCreate", () => {
  const setup = (options?: {
    readonly base?: string;
    readonly failBuild?: boolean;
    readonly hookJson?: boolean;
  }) => {
    const rootDir = mkdtempSync(join(tmpdir(), "oad-wt-root-"));
    tmp.push(rootDir);
    writeFileSync(join(rootDir, ".env.e2e"), "E2E=1\n");
    const wtPath = join(rootDir, "..", `${basename(rootDir)}-feat`);
    tmp.push(wtPath);
    const recipe = makeRecipe({
      project: { id: "kl", dbPrefix: "kl" },
      odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
      worktree: { copyFiles: [".env.e2e", "missing.env"] },
    });
    const recording = makeRecordingRunner((spec: ExecSpec): ExecResult | undefined => {
      if (spec.command === "git" && spec.args[0] === "symbolic-ref") {
        return { exitCode: 0, stdout: "refs/remotes/origin/main\n", stderr: "" };
      }
      if (spec.command === "git" && spec.args[0] === "worktree" && spec.args[1] === "add") {
        mkdirSync(wtPath, { recursive: true });
        writeFileSync(join(wtPath, "odoo-agentic-dev.config.mjs"), CONFIG_SOURCE);
        return undefined;
      }
      if (options?.failBuild === true && spec.args.includes("build")) {
        return { exitCode: 1, stdout: "", stderr: "build exploded" };
      }
      if (spec.command === "docker" && spec.args[0] === "compose" && spec.args[1] === "ls") {
        return { exitCode: 0, stdout: "[]", stderr: "" };
      }
      return undefined;
    });
    const store = makeFakeStateStore();
    const lifecycleCalls: Array<string> = [];
    const layer = Layer.mergeAll(
      Layer.provide(DockerComposeLive, recording.layer),
      recording.layer,
      store.layer,
      makeLifecycle(lifecycleCalls),
      makeFakeGit({ _tag: "Branch", branch: "worktree-feat" }),
    );
    const said: Array<string> = [];
    const say = (line: string) =>
      Effect.sync(() => {
        said.push(line);
      });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const effect = runWorktreeCreate({
      recipe,
      rootDir,
      name: "feat",
      path: wtPath,
      base: options?.base,
      env: {},
      hookJson: options?.hookJson ?? false,
      say,
    });
    return { effect, lifecycleCalls, recording, rootDir, run: runWith(layer), said, store, wtPath };
  };

  it("fetches, resolves the base ref, adds the worktree, copies files, and runs the full setup", async () => {
    const { effect, lifecycleCalls, recording, rootDir, run, said, store, wtPath } = setup();
    const result = await run(effect);
    expect(result).toBe(wtPath);

    expect(recording.calls[0]).toMatchObject({
      command: "git",
      args: ["fetch", "origin"],
      cwd: rootDir,
    });
    expect(recording.calls[1]).toMatchObject({
      command: "git",
      args: ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
      cwd: rootDir,
    });
    expect(recording.calls[2]).toMatchObject({
      command: "git",
      args: ["worktree", "add", "-b", "worktree-feat", wtPath, "origin/main"],
      cwd: rootDir,
    });

    // copyFiles: the existing file landed, the missing one was skipped with a log line
    expect(readFileSync(join(wtPath, ".env.e2e"), "utf8")).toBe("E2E=1\n");
    expect(said.some((l) => l.includes(".env.e2e"))).toBe(true);
    expect(said.some((l) => l.includes("missing.env"))).toBe(true);

    // the full setup ran against the WORKTREE as project root: image build,
    // db reset via the lifecycle, and the environment recorded in the registry
    expect(
      recording.calls.some(
        (c) => c.command === "docker" && c.args.includes("build") && c.cwd === wtPath,
      ),
    ).toBe(true);
    expect(lifecycleCalls).toContain("resetDatabase");
    expect(store.rows.has("kl_kl_worktree_feat")).toBe(true);
  });

  it("uses the --base flag without querying origin HEAD", async () => {
    const { effect, recording, run, wtPath } = setup({ base: "origin/release" });
    await run(effect);
    expect(recording.calls.some((c) => c.args[0] === "symbolic-ref")).toBe(false);
    expect(
      recording.calls.some(
        (c) =>
          c.args[0] === "worktree" &&
          c.args[1] === "add" &&
          c.args[4] === wtPath &&
          c.args[5] === "origin/release",
      ),
    ).toBe(true);
  });

  it("fails with GitError when git worktree add fails (no cleanup needed)", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "oad-wt-fail-"));
    tmp.push(rootDir);
    const recipe = makeRecipe({
      project: { id: "kl", dbPrefix: "kl" },
      odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
    });
    const recording = makeRecordingRunner((spec) =>
      spec.args[0] === "worktree" && spec.args[1] === "add"
        ? { exitCode: 128, stdout: "", stderr: "fatal: branch already exists" }
        : spec.args[0] === "symbolic-ref"
          ? { exitCode: 1, stdout: "", stderr: "" }
          : undefined,
    );
    const store = makeFakeStateStore();
    const layer = Layer.mergeAll(
      Layer.provide(DockerComposeLive, recording.layer),
      recording.layer,
      store.layer,
      makeLifecycle([]),
      makeFakeGit({ _tag: "Branch", branch: "worktree-feat" }),
    );
    await expect(
      runWith(layer)(
        runWorktreeCreate({
          recipe,
          rootDir,
          name: "feat",
          path: join(rootDir, "..", "nowhere"),
          base: undefined,
          env: {},
          hookJson: true,
          say: () => Effect.void,
        }),
      ),
    ).rejects.toThrow(/already exists/);
    // worktree add itself failed: nothing half-made, so no force-removal
    expect(recording.calls.some((c) => c.args[1] === "remove")).toBe(false);
  });

  it("hook mode: a setup failure force-removes the half-made worktree and still fails", async () => {
    const { effect, recording, rootDir, run, wtPath } = setup({
      failBuild: true,
      hookJson: true,
    });
    await expect(run(effect)).rejects.toThrow(/build/);
    expect(
      recording.calls.some(
        (c) =>
          c.command === "git" &&
          c.args[0] === "worktree" &&
          c.args[1] === "remove" &&
          c.args[2] === "--force" &&
          c.args[3] === wtPath &&
          c.cwd === rootDir,
      ),
    ).toBe(true);
  });

  it("without hook mode a setup failure leaves the worktree in place for inspection", async () => {
    const { effect, recording, run } = setup({ failBuild: true, hookJson: false });
    await expect(run(effect)).rejects.toThrow(/build/);
    expect(recording.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toBe(
      false,
    );
  });
});

describe("runWorktreeRemove", () => {
  const seedRow = (composeProject: string, databaseName: string, rootDir: string) => ({
    composeProject,
    projectId: "kl",
    databaseName,
    rootDir,
    worktreeName: "x",
    branch: null,
    odooHttpPort: 18100,
    shared: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    templateDb: null,
    templateKey: null,
  });

  const makeEnv = (initialRows: Parameters<typeof makeFakeStateStore>[0] = []) => {
    const recording = makeRecordingRunner((spec) =>
      spec.args[0] === "compose" && spec.args[1] === "ls"
        ? { exitCode: 0, stdout: "[]", stderr: "" }
        : undefined,
    );
    const store = makeFakeStateStore(initialRows);
    const layer = Layer.mergeAll(
      Layer.provide(DockerComposeLive, recording.layer),
      recording.layer,
      store.layer,
      makeFakeGit({ _tag: "Branch", branch: "worktree-feat" }),
    );
    const logged: Array<string> = [];
    const log = (line: string) =>
      Effect.sync(() => {
        logged.push(line);
      });
    return { log, logged, recording, run: runWith(layer), store };
  };

  it("tears down an existing worktree via compose down --volumes and forgets the row", async () => {
    const wtPath = mkdtempSync(join(tmpdir(), "oad-wt-rm-"));
    tmp.push(wtPath);
    writeFileSync(join(wtPath, "odoo-agentic-dev.config.mjs"), CONFIG_SOURCE);
    const { log, recording, run, store } = makeEnv([
      seedRow("kl_kl_worktree_feat", "kl_worktree_feat", wtPath),
    ]);
    await run(
      runWorktreeRemove({
        path: wtPath,
        allowShared: false,
        env: {},
        cwd: wtPath,
        configFlag: undefined,
        log,
      }),
    );
    const down = recording.calls.find((c) => c.args.includes("down"));
    expect(down).toMatchObject({
      command: "docker",
      args: [
        "compose",
        "-p",
        "kl_kl_worktree_feat",
        "-f",
        join(wtPath, GENERATED_COMPOSE_RELATIVE_PATH),
        "--project-directory",
        wtPath,
        "down",
        "--volumes",
      ],
    });
    expect(store.rows.has("kl_kl_worktree_feat")).toBe(false);
  });

  it("refuses to tear down a shared database without --allow-shared", async () => {
    const wtPath = mkdtempSync(join(tmpdir(), "oad-wt-shared-"));
    tmp.push(wtPath);
    writeFileSync(
      join(wtPath, "odoo-agentic-dev.config.mjs"),
      `export default {
  project: { id: "kl", dbPrefix: "kl", sharedDatabase: "kl_e2e_demo", sharedBranches: ["worktree-feat"] },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
}
`,
    );
    const { log, logged, recording, run, store } = makeEnv([
      seedRow("kl_kl_e2e_demo", "kl_e2e_demo", wtPath),
    ]);
    await run(
      runWorktreeRemove({
        path: wtPath,
        allowShared: false,
        env: {},
        cwd: wtPath,
        configFlag: undefined,
        log,
      }),
    );
    // never silently delete shared: no docker call at all, row kept, step logged
    expect(recording.calls).toHaveLength(0);
    expect(store.rows.has("kl_kl_e2e_demo")).toBe(true);
    expect(logged.some((l) => l.includes("shared"))).toBe(true);
  });

  it("falls back to label-based teardown when the worktree dir is gone", async () => {
    const currentRoot = mkdtempSync(join(tmpdir(), "oad-wt-cur-"));
    tmp.push(currentRoot);
    writeFileSync(join(currentRoot, "odoo-agentic-dev.config.mjs"), CONFIG_SOURCE);
    // basename "gone-worktree-feat" must reconstruct database
    // kl_gone_worktree_feat / compose project kl_kl_gone_worktree_feat
    const gonePath = join(currentRoot, "..", "gone-worktree-feat");
    const { log, recording, run, store } = makeEnv([
      seedRow("kl_kl_gone_worktree_feat", "kl_gone_worktree_feat", gonePath),
    ]);
    await run(
      runWorktreeRemove({
        path: gonePath,
        allowShared: false,
        env: {},
        cwd: currentRoot,
        configFlag: undefined,
        log,
      }),
    );
    expect(
      recording.calls.some(
        (c) =>
          c.command === "docker" &&
          c.args[0] === "ps" &&
          c.args.includes("label=com.docker.compose.project=kl_kl_gone_worktree_feat"),
      ),
    ).toBe(true);
    expect(store.rows.has("kl_kl_gone_worktree_feat")).toBe(false);
  });
});

describe("runWorktreeRemoveHook", () => {
  it("never fails: an unparseable payload is logged and swallowed (hook cannot block)", async () => {
    const recording = makeRecordingRunner();
    const store = makeFakeStateStore();
    const layer = Layer.mergeAll(
      Layer.provide(DockerComposeLive, recording.layer),
      recording.layer,
      store.layer,
      makeFakeGit({ _tag: "NotARepo" }),
    );
    const logged: Array<string> = [];
    const log = (line: string) =>
      Effect.sync(() => {
        logged.push(line);
      });
    await runWith(layer)(
      runWorktreeRemoveHook({
        stdinText: "definitely not json",
        allowShared: false,
        env: {},
        cwd: tmpdir(),
        configFlag: undefined,
        log,
      }),
    );
    expect(logged.some((l) => l.includes("ignored"))).toBe(true);
  });
});
