import { describe, expect, it } from "vitest";
import {
  assertComposeProjectName,
  assertSharedDatabaseAllowed,
  isSharedDatabase,
} from "../../src/core/safety.js";
import { ConfigValidationError, SharedDatabaseProtectionError } from "../../src/errors/errors.js";
import { runSyncFailure, runSyncSuccess } from "../helpers.js";

describe("shared database guard", () => {
  it("detects the shared database", () => {
    expect(isSharedDatabase("kl_e2e_demo", "kl_e2e_demo")).toBe(true);
    expect(isSharedDatabase("kl_feature_x", "kl_e2e_demo")).toBe(false);
    expect(isSharedDatabase("kl_feature_x", null)).toBe(false);
  });

  it("fails without allowShared, names the action", () => {
    expect(
      runSyncFailure(
        assertSharedDatabaseAllowed({
          databaseName: "kl_e2e_demo",
          sharedDatabase: "kl_e2e_demo",
          allowShared: false,
          action: "reset-db",
        }),
      ),
    ).toBeInstanceOf(SharedDatabaseProtectionError);
  });

  it("passes with allowShared or on isolated databases", () => {
    expect(() =>
      runSyncSuccess(
        assertSharedDatabaseAllowed({
          databaseName: "kl_e2e_demo",
          sharedDatabase: "kl_e2e_demo",
          allowShared: true,
          action: "reset-db",
        }),
      ),
    ).not.toThrow();
    expect(() =>
      runSyncSuccess(
        assertSharedDatabaseAllowed({
          databaseName: "kl_feature_x",
          sharedDatabase: "kl_e2e_demo",
          allowShared: false,
          action: "reset-db",
        }),
      ),
    ).not.toThrow();
  });
});

describe("assertComposeProjectName", () => {
  it("rejects empty and accepts derived names", () => {
    expect(runSyncFailure(assertComposeProjectName(""))).toBeInstanceOf(ConfigValidationError);
    expect(runSyncSuccess(assertComposeProjectName("kriss_laure_kl_x"))).toBe("kriss_laure_kl_x");
  });
});
