import { describe, expect, it } from "vitest";
import {
  createDatabaseSql,
  dropDatabaseSql,
  expandHook,
  odooInitArgs,
  odooShellArgs,
  odooTestArgs,
  odooUpdateArgs,
  psqlArgs,
  removeFilestoreArgs,
  setIrConfigParameterCode,
  terminateSessionsSql,
} from "../../src/core/command-plan.js";

describe("sql/argv builders", () => {
  it("psqlArgs targets the db service with ON_ERROR_STOP", () => {
    expect(psqlArgs("db", "SELECT 1")).toEqual([
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "odoo",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "SELECT 1",
    ]);
  });

  it("session/drop/create SQL quote the database name", () => {
    expect(terminateSessionsSql("kl_x")).toContain("datname = 'kl_x'");
    expect(dropDatabaseSql("kl_x")).toBe('DROP DATABASE IF EXISTS "kl_x"');
    expect(createDatabaseSql("kl_x")).toBe('CREATE DATABASE "kl_x" OWNER "odoo"');
  });

  it("filestore removal runs without deps through /bin/sh", () => {
    expect(removeFilestoreArgs("odoo", "kl_x")).toEqual([
      "run",
      "--rm",
      "--no-deps",
      "--entrypoint",
      "/bin/sh",
      "odoo",
      "-c",
      "rm -rf /var/lib/odoo/filestore/kl_x",
    ]);
  });

  it("init installs modules (base fallback) honoring withoutDemo", () => {
    expect(odooInitArgs("odoo", "kl_x", ["KL_setup", "KL_pay"], "all")).toEqual([
      "run",
      "--rm",
      "odoo",
      "odoo",
      "-d",
      "kl_x",
      "-i",
      "KL_setup,KL_pay",
      "--without-demo=all",
      "--stop-after-init",
    ]);
    expect(odooInitArgs("odoo", "kl_x", [], false)).toEqual([
      "run",
      "--rm",
      "odoo",
      "odoo",
      "-d",
      "kl_x",
      "-i",
      "base",
      "--stop-after-init",
    ]);
  });

  it("update and shell argv", () => {
    expect(odooUpdateArgs("odoo", "kl_x", ["KL_base", "KL_sale"])).toEqual([
      "run",
      "--rm",
      "odoo",
      "odoo",
      "-d",
      "kl_x",
      "-u",
      "KL_base,KL_sale",
      "--stop-after-init",
    ]);
    expect(odooShellArgs("odoo", "kl_x")).toEqual([
      "run",
      "--rm",
      "-T",
      "odoo",
      "odoo",
      "shell",
      "-d",
      "kl_x",
      "--no-http",
    ]);
  });

  it("test argv maps every option", () => {
    expect(odooTestArgs("odoo", "kl_x", {})).toEqual([
      "run",
      "--rm",
      "odoo",
      "odoo",
      "-d",
      "kl_x",
      "--test-enable",
      "--stop-after-init",
    ]);
    expect(
      odooTestArgs("odoo", "kl_x", {
        tags: "payment",
        file: "tests/test_x.py",
        module: "KL_sale",
        logLevel: "test",
        extraArgs: ["--workers", "0"],
      }),
    ).toEqual([
      "run",
      "--rm",
      "odoo",
      "odoo",
      "-d",
      "kl_x",
      "--test-enable",
      "--test-tags",
      "payment",
      "--test-file",
      "tests/test_x.py",
      "--test-tags",
      "/KL_sale",
      "--log-level",
      "test",
      "--workers",
      "0",
      "--stop-after-init",
    ]);
  });
});

describe("expandHook", () => {
  it("passes through shell file and inline hooks", () => {
    expect(expandHook({ type: "odoo-shell-file", file: "scripts/x.py" })).toEqual({
      kind: "odoo-shell-file",
      file: "scripts/x.py",
    });
    expect(expandHook({ type: "odoo-shell-inline", code: "print(1)" })).toEqual({
      kind: "odoo-shell",
      code: "print(1)",
    });
  });

  it("set-ir-config-parameter expands to committing shell code", () => {
    const expanded = expandHook({
      type: "set-ir-config-parameter",
      key: "web.base.url",
      value: "http://x",
    });
    expect(expanded).toEqual({
      kind: "odoo-shell",
      code: setIrConfigParameterCode("web.base.url", "http://x"),
    });
    expect((expanded as { code: string }).code).toContain('set_param("web.base.url", "http://x")');
    expect((expanded as { code: string }).code).toContain("env.cr.commit()");
  });

  it("command hooks become host commands", () => {
    expect(
      expandHook({ type: "command", command: "pnpm", args: ["seed"], cwd: "frontend" }),
    ).toEqual({ kind: "host-command", command: "pnpm", args: ["seed"], cwd: "frontend" });
  });
});
