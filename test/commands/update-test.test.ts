import { describe, expect, it } from "vitest";
import { detectSkippedBrowserSuite, resolveTestOptions } from "../../src/commands/test.js";
import { UsageError } from "../../src/errors/errors.js";
import { makeRecipe, runSyncFailure, runSyncSuccess } from "../helpers.js";

const recipe = makeRecipe({
  project: { id: "kl", dbPrefix: "kl" },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
  test: { profiles: { payment: ["--test-tags", "payment_flow"] } },
});

describe("detectSkippedBrowserSuite", () => {
  it("returns actionable guidance for the websocket-client browser-test skip", () => {
    const message = detectSkippedBrowserSuite({
      stdoutTail: "",
      stderrTail: "skipped because websocket-client module is not installed",
    });
    expect(message).toContain("websocket-client");
    expect(message).toContain("odoo.build.pipPackages");
    expect(message).toContain("oad test --build");
  });

  it("ignores ordinary successful output", () => {
    expect(
      detectSkippedBrowserSuite({
        stdoutTail: "[HOOT] Passed 279 tests",
        stderrTail: "",
      }),
    ).toBeNull();
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
