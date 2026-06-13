import { describe, expect, it } from "vitest";
import {
  CommandFailedError,
  ConfigValidationError,
  PortConflictError,
  SharedDatabaseProtectionError,
  StateError,
  UsageError,
  isRuntimeError,
  renderError,
} from "../../src/errors/errors.js";

describe("renderError", () => {
  it("renders shared-db protection with the exact retry flag", () => {
    const text = renderError(
      new SharedDatabaseProtectionError({ database: "kl_e2e_demo", action: "reset-db" }),
    );
    expect(text).toContain("kl_e2e_demo");
    expect(text).toContain("--allow-shared");
    expect(text).toContain("reset-db");
  });

  it("renders command failures with argv, cwd, exit code and a next action", () => {
    const text = renderError(
      new CommandFailedError({
        command: "docker",
        args: ["compose", "up"],
        cwd: "/work",
        exitCode: 17,
        stderrTail: "boom",
      }),
    );
    expect(text).toContain("docker compose up");
    expect(text).toContain("/work");
    expect(text).toContain("17");
    expect(text).toContain("output (tail)");
    expect(text).toContain("boom");
  });

  it("renders validation issues as a list", () => {
    const text = renderError(new ConfigValidationError({ issues: ["a bad", "b bad"] }));
    expect(text).toContain("a bad");
    expect(text).toContain("b bad");
  });

  it("renders command usage issues separately from config validation", () => {
    const text = renderError(new UsageError({ issues: ["pass --detach with --json"] }));
    expect(text).toContain("Invalid odoo-agentic-dev command usage");
    expect(text).toContain("pass --detach with --json");
    expect(text).toContain("fix the command flags or arguments");
  });

  it("renders state registry errors with the override env var as next action", () => {
    const error = new StateError({ reason: "disk I/O error" });
    expect(error.message).toContain("disk I/O error");
    const text = renderError(error);
    expect(text).toContain("disk I/O error");
    expect(text).toContain("ODOO_AGENTIC_DEV_STATE_DB");
  });

  it("renders port conflicts naming the holder stack when known", () => {
    const text = renderError(new PortConflictError({ port: 10018, holder: "kl_feature_x" }));
    expect(text).toContain("10018");
    expect(text).toContain("kl_feature_x");
    expect(text).toContain("ODOO_HTTP_PORT");
    expect(text).toContain("odoo-agentic-dev prune");
  });

  it("renders port conflicts without a known holder", () => {
    const error = new PortConflictError({ port: 10018, holder: null });
    expect(error.message).toContain("10018");
    const text = renderError(error);
    expect(text).toContain("10018");
    expect(text).not.toContain("null");
    expect(text).toContain("ODOO_HTTP_PORT");
    expect(text).toContain("odoo-agentic-dev prune");
  });

  it("isRuntimeError discriminates", () => {
    expect(isRuntimeError(new ConfigValidationError({ issues: [] }))).toBe(true);
    expect(isRuntimeError(new UsageError({ issues: [] }))).toBe(true);
    expect(isRuntimeError(new StateError({ reason: "x" }))).toBe(true);
    expect(isRuntimeError(new PortConflictError({ port: 1, holder: null }))).toBe(true);
    expect(isRuntimeError(new Error("nope"))).toBe(false);
  });
});
