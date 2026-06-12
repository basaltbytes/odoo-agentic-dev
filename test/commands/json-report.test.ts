import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { resetPathActions, resetPathMode, withJsonReport } from "../../src/commands/json-report.js";
import { SharedDatabaseProtectionError, StateError } from "../../src/errors/errors.js";
import { makeCtx, makeRecipe } from "../helpers.js";

const recipe = makeRecipe({
  project: { id: "kl", dbPrefix: "kl" },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
});
const ctx = makeCtx(recipe, "feature/z");

afterEach(() => {
  vi.restoreAllMocks();
});

const spyLog = () => vi.spyOn(console, "log").mockImplementation(() => {});

describe("resetPathActions", () => {
  it("maps every reset path to the action names the nightly workflow asserts", () => {
    expect(resetPathActions("restore")).toEqual(["restore-from-template"]);
    expect(resetPathActions("full")).toEqual(["full-init"]);
    expect(resetPathActions("full-then-snapshot")).toEqual(["full-init", "snapshot-template"]);
  });
});

describe("resetPathMode", () => {
  it("collapses the reset path to the coarse JSON mode", () => {
    expect(resetPathMode("restore")).toBe("template-restore");
    expect(resetPathMode("full")).toBe("full-init");
    expect(resetPathMode("full-then-snapshot")).toBe("full-init");
  });
});

describe("withJsonReport", () => {
  it("text mode: say prints lines, actions are silent, no final json", async () => {
    const log = spyLog();
    await Effect.runPromise(
      withJsonReport("up", false, (report) =>
        Effect.gen(function* () {
          yield* report.setContext(ctx);
          yield* report.say("hello");
          yield* report.action("compose-up");
        }),
      ),
    );
    expect(log.mock.calls.map((call) => String(call[0]))).toEqual(["hello"]);
  });

  it("json mode: stdout carries exactly one single-line JSON object with the documented core keys", async () => {
    const log = spyLog();
    await Effect.runPromise(
      withJsonReport("up", true, (report) =>
        Effect.gen(function* () {
          yield* report.setContext(ctx);
          yield* report.say("decorative line");
          yield* report.action("compose-up");
        }),
      ),
    );
    expect(log).toHaveBeenCalledTimes(1);
    const printed = String(log.mock.calls[0]![0]);
    // single line so `tail -n 1` parses it even after streamed child output
    expect(printed).not.toContain("\n");
    const parsed = JSON.parse(printed);
    expect(parsed).toMatchObject({
      ok: true,
      command: "up",
      database: ctx.databaseName,
      composeProjectName: ctx.composeProjectName,
      odooHttpPort: ctx.odooHttpPort,
      // legacy alias kept for the frozen e2e/nightly contract
      composeProject: ctx.composeProjectName,
      odooUrl: `${ctx.odooBaseUrl}/web?db=${ctx.databaseName}`,
      actions: ["decorative line", "compose-up"],
    });
    expect(typeof parsed.durationMs).toBe("number");
    expect(parsed).not.toHaveProperty("exitCode");
    expect(parsed).not.toHaveProperty("error");
  });

  it("json mode: per-command extras are merged into the report", async () => {
    const log = spyLog();
    await Effect.runPromise(
      withJsonReport("reset-db", true, (report) =>
        Effect.gen(function* () {
          yield* report.setContext(ctx);
          yield* report.setExtra("mode", "template-restore");
          yield* report.setExtra("templateKey", "abc123");
        }),
      ),
    );
    const parsed = JSON.parse(String(log.mock.calls[0]![0]));
    expect(parsed.mode).toBe("template-restore");
    expect(parsed.templateKey).toBe("abc123");
  });

  it("json mode: a failing body emits ok:false with a typed error object and re-fails", async () => {
    const log = spyLog();
    await expect(
      Effect.runPromise(
        withJsonReport("down", true, () => Effect.fail(new StateError({ reason: "boom" }))),
      ),
    ).rejects.toThrow(/boom/);
    expect(log).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(String(log.mock.calls[0]![0]));
    expect(parsed).toMatchObject({
      ok: false,
      command: "down",
      database: null,
      composeProjectName: null,
      composeProject: null,
      odooHttpPort: null,
      odooUrl: null,
      error: { tag: "StateError", message: "boom" },
    });
  });

  it("json mode: a guard refusal carries the SharedDatabaseProtectionError tag and message", async () => {
    const log = spyLog();
    const failure = new SharedDatabaseProtectionError({
      database: "kl_e2e_demo",
      action: "reset-db",
    });
    await expect(
      Effect.runPromise(
        withJsonReport("reset-db", true, (report) =>
          Effect.gen(function* () {
            yield* report.setContext(ctx);
            return yield* Effect.fail(failure);
          }),
        ),
      ),
    ).rejects.toThrow();
    const parsed = JSON.parse(String(log.mock.calls[0]![0]));
    expect(parsed.ok).toBe(false);
    expect(parsed.command).toBe("reset-db");
    expect(parsed.error.tag).toBe("SharedDatabaseProtectionError");
    expect(parsed.error.message).toContain("kl_e2e_demo");
    // context resolved before the failure, so identity fields are present
    expect(parsed.database).toBe(ctx.databaseName);
  });

  it("json mode: a recorded non-zero exit code makes the report not-ok and is included", async () => {
    const log = spyLog();
    await Effect.runPromise(
      withJsonReport("test", true, (report) =>
        Effect.gen(function* () {
          yield* report.setContext(ctx);
          yield* report.action("run-tests");
          yield* report.setExitCode(7);
          yield* report.setExtra("stdoutTail", "...tail...");
          yield* report.setExtra("stderrTail", "");
        }),
      ),
    );
    const parsed = JSON.parse(String(log.mock.calls[0]![0]));
    expect(parsed.ok).toBe(false);
    expect(parsed.exitCode).toBe(7);
    expect(parsed.stdoutTail).toBe("...tail...");
    expect(parsed.stderrTail).toBe("");
  });

  it("json mode: a zero exit code keeps the report ok", async () => {
    const log = spyLog();
    await Effect.runPromise(
      withJsonReport("test", true, (report) =>
        Effect.gen(function* () {
          yield* report.setContext(ctx);
          yield* report.setExitCode(0);
        }),
      ),
    );
    const parsed = JSON.parse(String(log.mock.calls[0]![0]));
    expect(parsed.ok).toBe(true);
    expect(parsed.exitCode).toBe(0);
  });

  // The stream-swap replaces `process.stdout.write`, which is exactly the sink
  // `runInherited` re-emits streamed compose/odoo lines through (it pipes the
  // child and writes each line via process.stdout.write — see command-runner).
  // So a body that writes to process.stdout during the run lands on stderr; the
  // final single JSON line is emitted AFTER the swap is restored.
  it("json mode: a body writing to process.stdout has that output swapped onto stderr", async () => {
    const log = spyLog();
    const stdoutChunks: Array<string> = [];
    const stderrChunks: Array<string> = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stderrChunks.push(String(chunk));
        return true;
      });
    try {
      await Effect.runPromise(
        withJsonReport("test", true, (report) =>
          Effect.gen(function* () {
            yield* report.setContext(ctx);
            // simulate streamed subprocess output going to the real stdout
            yield* Effect.sync(() => {
              process.stdout.write("streamed odoo log line\n");
            });
            yield* report.setExitCode(0);
          }),
        ),
      );
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
    // the streamed line was swapped onto stderr, never the captured stdout sink
    expect(stderrChunks.join("")).toContain("streamed odoo log line");
    expect(stdoutChunks.join("")).not.toContain("streamed odoo log line");
    // and the single JSON object is the only thing emitted as the report
    expect(log).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(String(log.mock.calls[0]![0]));
    expect(parsed.command).toBe("test");
    expect(parsed.ok).toBe(true);
  });
});
