import { describe, expect, it } from "vitest";
import {
  DB_NAME_PATTERN,
  deriveDatabaseName,
  sanitizeNamePart,
} from "../../src/core/database-name.js";
import { UnsafeDatabaseNameError } from "../../src/errors/errors.js";

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
    expect(deriveDatabaseName({ ...base, branch: "feature/KL-123-payment-flow" })).toBe(
      "kl_123_payment_flow",
    );
  });

  it("prefixes when the branch does not already carry the prefix", () => {
    expect(deriveDatabaseName({ ...base, branch: "feature/checkout-v2" })).toBe("kl_checkout_v2");
  });

  it("keeps non-type leading segments (user namespaces stay unique)", () => {
    expect(deriveDatabaseName({ ...base, branch: "alice/fix-1" })).toBe("kl_alice_fix_1");
  });

  it("uses the shared database for shared branches", () => {
    expect(deriveDatabaseName({ ...base, branch: "main" })).toBe("kl_e2e_demo");
    expect(deriveDatabaseName({ ...base, branch: "develop" })).toBe("kl_e2e_demo");
  });

  it("env override wins over everything", () => {
    expect(deriveDatabaseName({ ...base, branch: "main", envDatabase: "kl_custom" })).toBe(
      "kl_custom",
    );
  });

  it("rejects unsafe env overrides", () => {
    expect(() =>
      deriveDatabaseName({ ...base, branch: "main", envDatabase: "Robert'); DROP" }),
    ).toThrow(UnsafeDatabaseNameError);
  });

  it("falls back to the worktree name without a branch", () => {
    expect(deriveDatabaseName({ ...base, branch: undefined })).toBe("kl_fallback_wt");
  });

  it("truncates long names to 63 chars with a stable hash suffix", () => {
    const branch = "feature/" + "very-long-segment-".repeat(8);
    const name = deriveDatabaseName({ ...base, branch });
    const again = deriveDatabaseName({ ...base, branch });
    expect(name).toHaveLength(63);
    expect(name).toBe(again);
    expect(name).toMatch(DB_NAME_PATTERN);
    expect(name.slice(54, 55)).toBe("_");
  });

  it("derived names always match the safety pattern", () => {
    for (const branch of ["feature/X", "fix/émoji-🎉", "release/2025.06", "UPPER/Case"]) {
      expect(deriveDatabaseName({ ...base, branch })).toMatch(DB_NAME_PATTERN);
    }
  });
});
