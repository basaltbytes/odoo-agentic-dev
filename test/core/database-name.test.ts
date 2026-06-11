import { describe, expect, it } from "vitest";
import {
  DB_NAME_PATTERN,
  deriveDatabaseName,
  sanitizeNamePart,
} from "../../src/core/database-name.js";
import { UnsafeDatabaseNameError } from "../../src/errors/errors.js";
import { runSyncFailure, runSyncSuccess } from "../helpers.js";

const base = {
  worktreeName: "fallback-wt",
  dbPrefix: "kl",
  sharedDatabase: "kl_e2e_demo" as string | null,
  sharedBranches: ["main", "master", "dev", "develop", "development"] as ReadonlyArray<string>,
  envDatabase: undefined as string | undefined,
};

describe("sanitizeNamePart", () => {
  it("lowercases and collapses non-alphanumerics to single underscores", () => {
    expect(sanitizeNamePart("KL-123--Payment Flow!")).toBe("kl_123_payment_flow");
    expect(sanitizeNamePart("__x__")).toBe("x");
  });
});

describe("deriveDatabaseName", () => {
  it("matches the PRD example: feature/KL-123-payment-flow -> kl_123_payment_flow", () => {
    expect(
      runSyncSuccess(deriveDatabaseName({ ...base, branch: "feature/KL-123-payment-flow" })),
    ).toBe("kl_123_payment_flow");
  });

  it("prefixes when the branch does not already carry the prefix", () => {
    expect(runSyncSuccess(deriveDatabaseName({ ...base, branch: "feature/checkout-v2" }))).toBe(
      "kl_checkout_v2",
    );
  });

  it("keeps non-type leading segments (user namespaces stay unique)", () => {
    expect(runSyncSuccess(deriveDatabaseName({ ...base, branch: "alice/fix-1" }))).toBe(
      "kl_alice_fix_1",
    );
  });

  it("uses the shared database for shared branches", () => {
    expect(runSyncSuccess(deriveDatabaseName({ ...base, branch: "main" }))).toBe("kl_e2e_demo");
    expect(runSyncSuccess(deriveDatabaseName({ ...base, branch: "develop" }))).toBe("kl_e2e_demo");
  });

  it("env override wins over everything", () => {
    expect(
      runSyncSuccess(deriveDatabaseName({ ...base, branch: "main", envDatabase: "kl_custom" })),
    ).toBe("kl_custom");
  });

  it("rejects unsafe env overrides", () => {
    expect(
      runSyncFailure(
        deriveDatabaseName({ ...base, branch: "main", envDatabase: "Robert'); DROP" }),
      ),
    ).toBeInstanceOf(UnsafeDatabaseNameError);
  });

  it("falls back to the worktree name without a branch", () => {
    expect(runSyncSuccess(deriveDatabaseName({ ...base, branch: undefined }))).toBe(
      "kl_fallback_wt",
    );
  });

  it("truncates long derived names to 58 chars (template-suffix headroom) with a stable hash", () => {
    const branch = "feature/" + "very-long-segment-".repeat(8);
    const name = runSyncSuccess(deriveDatabaseName({ ...base, branch }));
    const again = runSyncSuccess(deriveDatabaseName({ ...base, branch }));
    expect(name).toHaveLength(58);
    expect(name).toBe(again);
    expect(name).toMatch(DB_NAME_PATTERN);
    expect(name.slice(49, 50)).toBe("_");
  });

  it("keeps explicit env overrides up to 63 chars (no template headroom enforced)", () => {
    const long = "a".repeat(63);
    expect(runSyncSuccess(deriveDatabaseName({ ...base, branch: "main", envDatabase: long }))).toBe(
      long,
    );
    expect(
      runSyncFailure(deriveDatabaseName({ ...base, branch: "main", envDatabase: "a".repeat(64) })),
    ).toBeInstanceOf(UnsafeDatabaseNameError);
  });

  it("derived names always match the safety pattern", () => {
    for (const branch of ["feature/X", "fix/émoji-🎉", "release/2025.06", "UPPER/Case"]) {
      expect(runSyncSuccess(deriveDatabaseName({ ...base, branch }))).toMatch(DB_NAME_PATTERN);
    }
  });
});
