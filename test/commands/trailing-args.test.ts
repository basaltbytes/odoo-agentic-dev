import { describe, expect, it } from "vitest";
import { trailingOperands } from "../../src/commands/trailing-args.js";

describe("trailingOperands", () => {
  it("returns everything after the FIRST -- (inner -- preserved)", () => {
    expect(trailingOperands(["node", "cli.js", "run", "--", "pnpm", "exec", "x"])).toEqual([
      "pnpm",
      "exec",
      "x",
    ]);
    expect(trailingOperands(["node", "cli.js", "run", "--", "pnpm", "foo", "--", "--bar"])).toEqual(
      ["pnpm", "foo", "--", "--bar"],
    );
  });

  it("returns nothing without a -- separator", () => {
    expect(trailingOperands(["node", "cli.js", "run", "env"])).toEqual([]);
  });

  it("returns nothing for a trailing bare --", () => {
    expect(trailingOperands(["node", "cli.js", "run", "--"])).toEqual([]);
  });
});
