import { describe, expect, it } from "vitest";
import { resolveTestOptions } from "../../src/commands/test.js";
import { ConfigValidationError } from "../../src/errors/errors.js";
import { makeRecipe, runSyncFailure, runSyncSuccess } from "../helpers.js";

const recipe = makeRecipe({
  project: { id: "kl", dbPrefix: "kl" },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
  test: { profiles: { payment: ["--test-tags", "payment_flow"] } },
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
        }),
      ),
    ).toEqual({ tags: "x", file: undefined, module: "m", logLevel: "test", extraArgs: [] });
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
        }),
      ),
    ).toEqual({
      tags: undefined,
      file: undefined,
      module: undefined,
      logLevel: undefined,
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
      }),
    );
    expect(error).toBeInstanceOf(ConfigValidationError);
    expect(String(error.issues)).toContain("payment");
  });
});
