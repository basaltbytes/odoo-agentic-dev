import { describe, expect, it } from "vitest";
import "../src/suppress-sqlite-warning.js";

/** Emit via process.emitWarning and collect what actually reaches listeners. */
const collectWarnings = async (emit: () => void): Promise<Array<string>> => {
  const seen: Array<string> = [];
  const listener = (warning: Error): void => {
    seen.push(warning.message);
  };
  process.on("warning", listener);
  emit();
  // warnings are delivered on a later tick
  await new Promise((resolve) => setImmediate(resolve));
  process.off("warning", listener);
  return seen;
};

describe("suppress-sqlite-warning", () => {
  it("swallows only the SQLite ExperimentalWarning", async () => {
    const seen = await collectWarnings(() => {
      process.emitWarning("SQLite is an experimental feature and might change at any time", {
        type: "ExperimentalWarning",
      });
    });
    expect(seen).toEqual([]);
  });

  it("passes every other warning through (string and Error forms)", async () => {
    const seen = await collectWarnings(() => {
      process.emitWarning("odoo-agentic-dev test warning passthrough");
      process.emitWarning(new Error("odoo-agentic-dev error-form warning"));
    });
    expect(seen).toEqual([
      "odoo-agentic-dev test warning passthrough",
      "odoo-agentic-dev error-form warning",
    ]);
  });
});
