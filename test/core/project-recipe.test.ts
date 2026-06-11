import { describe, expect, it } from "vitest";
import { defineOdooAgenticDevConfig } from "../../src/index.js";
import type { OdooAgenticDevConfigInput, PostInitHook } from "../../src/index.js";

describe("defineOdooAgenticDevConfig", () => {
  it("returns its input unchanged (identity, validation happens in the loader)", () => {
    const input: OdooAgenticDevConfigInput = {
      project: { id: "billing-odoo", dbPrefix: "billing" },
      odoo: {
        version: "18.0",
        addons: [{ host: "addons", container: "/mnt/extra-addons/custom" }],
      },
    };
    expect(defineOdooAgenticDevConfig(input)).toBe(input);
  });

  it("hook union accepts all four v1 hook types", () => {
    const hooks: ReadonlyArray<PostInitHook> = [
      { type: "odoo-shell-file", file: "scripts/post-init.py" },
      { type: "odoo-shell-inline", code: "print('hi')" },
      { type: "set-ir-config-parameter", key: "k", value: "v" },
      { type: "command", command: "pnpm", args: ["seed"], cwd: "frontend" },
    ];
    expect(hooks).toHaveLength(4);
  });
});
