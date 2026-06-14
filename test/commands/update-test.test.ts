import { describe, expect, it } from "vitest";
import {
  analyzeTestOutput,
  detectSkippedBrowserSuite,
  resolveTestOptions,
} from "../../src/commands/test.js";
import { UsageError } from "../../src/errors/errors.js";
import { makeRecipe, runSyncFailure, runSyncSuccess } from "../helpers.js";

const recipe = makeRecipe({
  project: { id: "kl", dbPrefix: "kl" },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
  test: { profiles: { payment: ["--test-tags", "payment_flow"] } },
});

describe("detectSkippedBrowserSuite", () => {
  it("returns actionable guidance for the websocket-client browser-test skip without requiring the word skipped", () => {
    const message = detectSkippedBrowserSuite({
      stdout: "",
      stderr: "websocket-client module is not installed",
    });
    expect(message).toContain("websocket-client");
    expect(message).toContain("odoo.build");
    expect(message).toContain("oad test --build");
  });

  it("fails known Chrome/browser infrastructure skip reasons", () => {
    for (const stderr of [
      "Chrome executable not found",
      "Failed to detect chrome devtools port after 10s",
      "Error during Chrome connection: never found 'page' target",
      "Cannot connect to chrome dev tools",
    ]) {
      expect(detectSkippedBrowserSuite({ stdout: "", stderr })).toContain("browser tests");
    }
  });

  it("ignores ordinary successful output", () => {
    expect(
      detectSkippedBrowserSuite({
        stdoutTail: "[HOOT] Passed 279 tests",
        stderrTail: "",
      }),
    ).toBeNull();
  });

  it("treats all-skipped Hoot runs as fatal", () => {
    const analysis = analyzeTestOutput({
      stdout: "[HOOT] Passed 0 tests\nskipped: 3",
      stderr: "",
    });
    expect(analysis.fatalReason).toContain("zero passed");
    expect(analysis.warnings).toEqual([]);
  });

  it("reports partial Hoot skips as warnings, not fatal failures", () => {
    const analysis = analyzeTestOutput({
      stdout: "[HOOT] Passed 10 tests\nskipped: 2",
      stderr: "",
    });
    expect(analysis.fatalReason).toBeNull();
    expect(analysis.warnings).toEqual(["Odoo reported 2 skipped Hoot/browser test(s)."]);
  });

  it("ignores unrelated skipped text", () => {
    const analysis = analyzeTestOutput({
      stdout: "inventory import skipped optional row\n[HOOT] Passed 10 tests",
      stderr: "",
    });
    expect(analysis).toEqual({ fatalReason: null, warnings: [] });
  });
});

describe("resolveTestOptions", () => {
  it("maps flags directly", () => {
    expect(
      runSyncSuccess(
        resolveTestOptions(recipe, {
          tags: "x",
          file: undefined,
          module: "m",
          logLevel: "test",
          profile: undefined,
          build: true,
        }),
      ),
    ).toEqual({
      tags: "x",
      file: undefined,
      module: "m",
      logLevel: "test",
      build: true,
      extraArgs: [],
    });
  });

  it("expands a recipe profile into extraArgs", () => {
    expect(
      runSyncSuccess(
        resolveTestOptions(recipe, {
          tags: undefined,
          file: undefined,
          module: undefined,
          logLevel: undefined,
          profile: "payment",
          build: false,
        }),
      ),
    ).toEqual({
      tags: undefined,
      file: undefined,
      module: undefined,
      logLevel: undefined,
      build: false,
      extraArgs: ["--test-tags", "payment_flow"],
    });
  });

  it("rejects unknown profiles listing the available ones", () => {
    const error = runSyncFailure(
      resolveTestOptions(recipe, {
        tags: undefined,
        file: undefined,
        module: undefined,
        logLevel: undefined,
        profile: "nope",
        build: false,
      }),
    );
    expect(error).toBeInstanceOf(UsageError);
    expect(String(error.issues)).toContain("payment");
  });
});
