import { describe, expect, it } from "vitest";
import { decideDelegation } from "../../src/delegate.js";

describe("decideDelegation", () => {
  it("delegates to a distinct local CLI in the normal case", () => {
    const decision = decideDelegation({
      selfPath: "/usr/global/dist/cli.js",
      localCliPath: "/project/node_modules/@basaltbytes/odoo-agentic-dev/dist/cli.js",
      envValue: undefined,
    });
    expect(decision).toEqual({
      delegate: true,
      localCliPath: "/project/node_modules/@basaltbytes/odoo-agentic-dev/dist/cli.js",
    });
  });

  it("does not delegate when the no-delegate env var is set non-empty", () => {
    const decision = decideDelegation({
      selfPath: "/usr/global/dist/cli.js",
      localCliPath: "/project/node_modules/@basaltbytes/odoo-agentic-dev/dist/cli.js",
      envValue: "1",
    });
    expect(decision).toEqual({ delegate: false });
  });

  it("delegates when the no-delegate env var is set but empty (shell -n semantics)", () => {
    const decision = decideDelegation({
      selfPath: "/usr/global/dist/cli.js",
      localCliPath: "/project/node_modules/@basaltbytes/odoo-agentic-dev/dist/cli.js",
      envValue: "",
    });
    expect(decision).toEqual({
      delegate: true,
      localCliPath: "/project/node_modules/@basaltbytes/odoo-agentic-dev/dist/cli.js",
    });
  });

  it("does not delegate when no local CLI resolved", () => {
    const decision = decideDelegation({
      selfPath: "/usr/global/dist/cli.js",
      localCliPath: undefined,
      envValue: undefined,
    });
    expect(decision).toEqual({ delegate: false });
  });

  it("does not delegate when the local CLI is the currently running script", () => {
    const decision = decideDelegation({
      selfPath: "/project/node_modules/@basaltbytes/odoo-agentic-dev/dist/cli.js",
      localCliPath: "/project/node_modules/@basaltbytes/odoo-agentic-dev/dist/cli.js",
      envValue: undefined,
    });
    expect(decision).toEqual({ delegate: false });
  });
});
