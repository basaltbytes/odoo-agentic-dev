import { describe, expect, it } from "vitest";
import {
  containerAddonsPath,
  copyFilestoreArgs,
  createDatabaseSql,
  createFromTemplateSql,
  databaseExistsArgs,
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
import { makeRecipe } from "../helpers.js";

const ADDONS = "/usr/lib/python3/dist-packages/odoo/addons,/mnt/c";

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

  it("databaseExistsArgs checks pg_database through the postgres database", () => {
    expect(databaseExistsArgs("db", "kl_x")).toEqual([
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "odoo",
      "-d",
      "postgres",
      "-tAc",
      "SELECT 1 FROM pg_database WHERE datname = 'kl_x'",
    ]);
  });

  it("session/drop/create SQL quote the database name", () => {
    expect(terminateSessionsSql("kl_x")).toContain("datname = 'kl_x'");
    expect(dropDatabaseSql("kl_x")).toBe('DROP DATABASE IF EXISTS "kl_x"');
    expect(createDatabaseSql("kl_x")).toBe('CREATE DATABASE "kl_x" OWNER "odoo"');
  });

  it("createFromTemplateSql quotes both names", () => {
    expect(createFromTemplateSql("kl_x", "kl_x__tpl")).toBe(
      'CREATE DATABASE "kl_x" TEMPLATE "kl_x__tpl"',
    );
    expect(createFromTemplateSql("kl_x__tpl", "kl_x")).toBe(
      'CREATE DATABASE "kl_x__tpl" TEMPLATE "kl_x"',
    );
  });

  it("copyFilestoreArgs clears the target and copies only when the source exists", () => {
    expect(copyFilestoreArgs("odoo", "kl_x", "kl_x__tpl")).toEqual([
      "run",
      "--rm",
      "--no-deps",
      "--entrypoint",
      "/bin/sh",
      "odoo",
      "-c",
      "rm -rf /var/lib/odoo/filestore/kl_x__tpl && if [ -d /var/lib/odoo/filestore/kl_x ]; then cp -a /var/lib/odoo/filestore/kl_x /var/lib/odoo/filestore/kl_x__tpl; fi",
    ]);
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
    expect(odooInitArgs("odoo", "kl_x", ADDONS, ["KL_setup", "KL_pay"], "all")).toEqual([
      "run",
      "--rm",
      "odoo",
      "odoo",
      "-d",
      "kl_x",
      `--addons-path=${ADDONS}`,
      "-i",
      "KL_setup,KL_pay",
      "--without-demo=all",
      "--stop-after-init",
    ]);
    expect(odooInitArgs("odoo", "kl_x", ADDONS, [], false)).toEqual([
      "run",
      "--rm",
      "odoo",
      "odoo",
      "-d",
      "kl_x",
      `--addons-path=${ADDONS}`,
      "-i",
      "base",
      "--stop-after-init",
    ]);
  });

  it("passes --with-demo for Odoo 19 when demo data is explicitly enabled", () => {
    expect(odooInitArgs("odoo", "kl_x", ADDONS, ["huco_planning"], false, "19.0")).toEqual([
      "run",
      "--rm",
      "odoo",
      "odoo",
      "-d",
      "kl_x",
      `--addons-path=${ADDONS}`,
      "-i",
      "huco_planning",
      "--with-demo",
      "--stop-after-init",
    ]);
  });

  it("passes --without-demo=all for Odoo 19 when demo data is disabled", () => {
    const args = odooInitArgs("odoo", "kl_x", ADDONS, ["huco_planning"], "all", "19.0");
    expect(args).toContain("--without-demo=all");
    expect(args).not.toContain("--with-demo");
  });

  it("keeps Odoo 18 demo-enable behavior by omitting both demo flags", () => {
    const args = odooInitArgs("odoo", "kl_x", ADDONS, ["KL_setup"], false, "18.0");
    expect(args).not.toContain("--with-demo");
    expect(args.some((arg) => arg.startsWith("--without-demo"))).toBe(false);
  });

  it("update and shell argv", () => {
    expect(odooUpdateArgs("odoo", "kl_x", ADDONS, ["KL_base", "KL_sale"])).toEqual([
      "run",
      "--rm",
      "odoo",
      "odoo",
      "-d",
      "kl_x",
      `--addons-path=${ADDONS}`,
      "-u",
      "KL_base,KL_sale",
      "--stop-after-init",
    ]);
    expect(odooShellArgs("odoo", "kl_x", ADDONS)).toEqual([
      "run",
      "--rm",
      "-T",
      "odoo",
      "odoo",
      "shell",
      "-d",
      "kl_x",
      `--addons-path=${ADDONS}`,
      "--no-http",
    ]);
  });

  it("test argv maps every option", () => {
    expect(odooTestArgs("odoo", "kl_x", ADDONS, {})).toEqual([
      "run",
      "--rm",
      "odoo",
      "odoo",
      "-d",
      "kl_x",
      `--addons-path=${ADDONS}`,
      "--test-enable",
      "--stop-after-init",
    ]);
    expect(
      odooTestArgs("odoo", "kl_x", ADDONS, {
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
      `--addons-path=${ADDONS}`,
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

describe("containerAddonsPath", () => {
  it("joins the image base path with every mount container path", () => {
    const recipe = makeRecipe({
      project: { id: "kl", dbPrefix: "kl" },
      odoo: {
        version: "18.0",
        addons: [
          { host: "backend/addons/Custom", container: "/mnt/extra-addons/Custom" },
          { host: "backend/addons/OCA", container: "/mnt/extra-addons/OCA" },
        ],
      },
    });
    expect(containerAddonsPath(recipe)).toBe(
      "/usr/lib/python3/dist-packages/odoo/addons,/mnt/extra-addons/Custom,/mnt/extra-addons/OCA",
    );
  });

  it("honors a custom baseAddonsPath", () => {
    const recipe = makeRecipe({
      project: { id: "kl", dbPrefix: "kl" },
      odoo: {
        version: "18.0",
        baseAddonsPath: "/odoo/addons",
        addons: [{ host: "addons", container: "/mnt/c" }],
      },
    });
    expect(containerAddonsPath(recipe)).toBe("/odoo/addons,/mnt/c");
  });
});

describe("expandHook", () => {
  const ctxEnv = {
    ODOO_DATABASE: "kl_x",
    E2E_BASE_URL: "http://localhost:28128",
  };

  it("passes through shell file and inline hooks", () => {
    expect(expandHook({ type: "odoo-shell-file", file: "scripts/x.py" }, ctxEnv)).toEqual({
      kind: "odoo-shell-file",
      file: "scripts/x.py",
    });
    expect(expandHook({ type: "odoo-shell-inline", code: "print(1)" }, ctxEnv)).toEqual({
      kind: "odoo-shell",
      code: "print(1)",
    });
  });

  it("set-ir-config-parameter expands to committing shell code", () => {
    const expanded = expandHook(
      {
        type: "set-ir-config-parameter",
        key: "web.base.url",
        value: "http://x",
      },
      ctxEnv,
    );
    expect(expanded).toEqual({
      kind: "odoo-shell",
      code: setIrConfigParameterCode("web.base.url", "http://x"),
    });
    expect((expanded as { code: string }).code).toContain('set_param("web.base.url", "http://x")');
    expect((expanded as { code: string }).code).toContain("env.cr.commit()");
  });

  it("substitutes context env tokens in set-ir-config-parameter values", () => {
    const expanded = expandHook(
      { type: "set-ir-config-parameter", key: "app.mobile.url", value: "$E2E_BASE_URL" },
      ctxEnv,
    ) as { code: string };
    expect(expanded.code).toContain('set_param("app.mobile.url", "http://localhost:28128")');
    // unknown tokens stay verbatim (substituteEnvTokens semantics)
    const unknown = expandHook(
      { type: "set-ir-config-parameter", key: "k", value: "$NOT_SET" },
      ctxEnv,
    ) as { code: string };
    expect(unknown.code).toContain('set_param("k", "$NOT_SET")');
  });

  it("inline scripts are not substituted (they manage their own env)", () => {
    expect(
      expandHook({ type: "odoo-shell-inline", code: 'print("$ODOO_DATABASE")' }, ctxEnv),
    ).toEqual({ kind: "odoo-shell", code: 'print("$ODOO_DATABASE")' });
  });

  it("command hooks become host commands", () => {
    expect(
      expandHook({ type: "command", command: "pnpm", args: ["seed"], cwd: "frontend" }, ctxEnv),
    ).toEqual({ kind: "host-command", command: "pnpm", args: ["seed"], cwd: "frontend" });
  });
});
