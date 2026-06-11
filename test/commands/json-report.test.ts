import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { resetPathActions, withJsonReport } from "../../src/commands/json-report.js";
import { StateError } from "../../src/errors/errors.js";
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

  it("json mode: say is recorded into actions and exactly one json line is printed", async () => {
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
      composeProject: ctx.composeProjectName,
      odooUrl: `${ctx.odooBaseUrl}/web?db=${ctx.databaseName}`,
      actions: ["decorative line", "compose-up"],
    });
    expect(typeof parsed.durationMs).toBe("number");
    expect(parsed).not.toHaveProperty("exitCode");
  });

  it("json mode: a failing body emits ok:false (nulls before context) and re-fails", async () => {
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
      composeProject: null,
      odooUrl: null,
    });
  });

  it("json mode: a recorded non-zero exit code makes the report not-ok and is included", async () => {
    const log = spyLog();
    await Effect.runPromise(
      withJsonReport("test", true, (report) =>
        Effect.gen(function* () {
          yield* report.setContext(ctx);
          yield* report.action("run-tests");
          yield* report.setExitCode(7);
        }),
      ),
    );
    const parsed = JSON.parse(String(log.mock.calls[0]![0]));
    expect(parsed.ok).toBe(false);
    expect(parsed.exitCode).toBe(7);
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
});
