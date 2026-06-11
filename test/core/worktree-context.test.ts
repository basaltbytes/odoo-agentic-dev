import { describe, expect, it } from "vitest";
import { buildWorktreeContext, substituteEnvTokens } from "../../src/core/worktree-context.js";
import type { GitState } from "../../src/core/worktree-context.js";
import { ConfigValidationError } from "../../src/errors/errors.js";
import { fnv1a32 } from "../../src/core/port-allocator.js";
import { makeRecipe, runSyncFailure, runSyncSuccess } from "../helpers.js";

const recipe = makeRecipe({
  project: {
    id: "kriss-laure",
    dbPrefix: "kl",
    sharedDatabase: "kl_e2e_demo",
    sharedBranches: ["main", "master", "dev", "develop", "development"],
  },
  ports: { odooBase: 18069, companionBase: 28028, range: 1000 },
  odoo: {
    version: "18.0",
    addons: [{ host: "backend/addons/Custom", container: "/mnt/extra-addons/Custom" }],
  },
  envAliases: { KL_WORKTREE_DB_NAME: "ODOO_DATABASE", E2E_BASE_URL: "ODOO_BASE_URL" },
  companionApps: [
    { name: "pwa", cwd: "frontend", command: "pnpm", args: ["dev"], portEnv: "PWA_PORT" },
  ],
});

const onBranch = (branch: string): GitState => ({ _tag: "Branch", branch });

const build = (git: GitState, env: Record<string, string | undefined> = {}) =>
  buildWorktreeContext({ rootDir: "/work/kriss-laure", recipe, env, git });

describe("buildWorktreeContext", () => {
  it("derives the PRD example end to end", () => {
    const ctx = runSyncSuccess(build(onBranch("feature/KL-123-payment-flow")));
    const offset = fnv1a32("kl_123_payment_flow") % 1000;
    expect(ctx.worktreeName).toBe("feature/KL-123-payment-flow");
    expect(ctx.databaseName).toBe("kl_123_payment_flow");
    expect(ctx.composeProjectName).toBe("kriss_laure_kl_123_payment_flow");
    expect(ctx.odooHttpPort).toBe(18069 + offset);
    expect(ctx.odooBaseUrl).toBe(`http://127.0.0.1:${18069 + offset}`);
    expect(ctx.companionPorts.get("pwa")).toBe(28028 + offset);
  });

  it("injects canonical env plus companion vars plus aliases", () => {
    const ctx = runSyncSuccess(build(onBranch("feature/x")));
    expect(ctx.env.ODOO_DATABASE).toBe(ctx.databaseName);
    expect(ctx.env.E2E_ODOO_DB).toBe(ctx.databaseName);
    expect(ctx.env.ODOO_BASE_URL).toBe(ctx.odooBaseUrl);
    expect(ctx.env.ODOO_HTTP_PORT).toBe(String(ctx.odooHttpPort));
    expect(ctx.env.ODOO_COMPOSE_PROJECT_NAME).toBe(ctx.composeProjectName);
    expect(ctx.env.KL_WORKTREE_DB_NAME).toBe(ctx.databaseName);
    expect(ctx.env.E2E_BASE_URL).toBe(ctx.odooBaseUrl);
    expect(ctx.env.PWA_PORT).toBe(String(ctx.companionPorts.get("pwa")));
  });

  it("companion urlEnv exposes a localhost URL and aliases can retarget companion vars", () => {
    const withUrlEnv = makeRecipe({
      project: { id: "kriss-laure", dbPrefix: "kl" },
      odoo: {
        version: "18.0",
        addons: [{ host: "backend/addons/Custom", container: "/mnt/extra-addons/Custom" }],
      },
      envAliases: { E2E_PWA_PORT: "PWA_PORT" },
      companionApps: [
        {
          name: "pwa",
          cwd: "frontend",
          command: "pnpm",
          args: ["dev"],
          portEnv: "PWA_PORT",
          urlEnv: "E2E_BASE_URL",
        },
      ],
    });
    const ctx = runSyncSuccess(
      buildWorktreeContext({
        rootDir: "/work/kriss-laure",
        recipe: withUrlEnv,
        env: {},
        git: onBranch("feature/x"),
      }),
    );
    const port = ctx.companionPorts.get("pwa");
    expect(ctx.env.E2E_BASE_URL).toBe(`http://localhost:${port}`);
    expect(ctx.env.E2E_PWA_PORT).toBe(String(port));
  });

  it("an alias targeting an unknown env key fails listing the available keys", () => {
    const broken = makeRecipe({
      project: { id: "kriss-laure", dbPrefix: "kl" },
      odoo: {
        version: "18.0",
        addons: [{ host: "backend/addons/Custom", container: "/mnt/extra-addons/Custom" }],
      },
      envAliases: { MY_ALIAS: "NOT_A_KEY" },
      companionApps: [
        { name: "pwa", cwd: "frontend", command: "pnpm", args: ["dev"], portEnv: "PWA_PORT" },
      ],
    });
    const error = runSyncFailure(
      buildWorktreeContext({
        rootDir: "/work/kriss-laure",
        recipe: broken,
        env: {},
        git: onBranch("feature/x"),
      }),
    );
    expect(error).toBeInstanceOf(ConfigValidationError);
    expect(error.message).toContain('"MY_ALIAS"');
    expect(error.message).toContain('"NOT_A_KEY"');
    expect(error.message).toContain("ODOO_DATABASE");
    expect(error.message).toContain("PWA_PORT");
  });

  it("ODOO_WORKTREE_NAME env override beats the branch", () => {
    const ctx = runSyncSuccess(build(onBranch("feature/x"), { ODOO_WORKTREE_NAME: "custom-name" }));
    expect(ctx.worktreeName).toBe("custom-name");
    expect(ctx.databaseName).toBe("kl_custom_name");
  });

  it("records the real git branch on the context", () => {
    expect(runSyncSuccess(build(onBranch("feature/x"))).branch).toBe("feature/x");
    expect(runSyncSuccess(build({ _tag: "Detached" })).branch).toBeNull();
    expect(runSyncSuccess(build({ _tag: "NotARepo" })).branch).toBeNull();
  });

  it("ODOO_WORKTREE_NAME is a name override, never a branch", () => {
    // on a branch the real branch is kept; without one the override adds none
    expect(
      runSyncSuccess(build(onBranch("feature/x"), { ODOO_WORKTREE_NAME: "custom-name" })).branch,
    ).toBe("feature/x");
    expect(
      runSyncSuccess(build({ _tag: "Detached" }, { ODOO_WORKTREE_NAME: "custom-name" })).branch,
    ).toBeNull();
  });

  it("agreeing ODOO_DATABASE/E2E_ODOO_DB overrides are honored", () => {
    const ctx = runSyncSuccess(
      build(onBranch("main"), { ODOO_DATABASE: "kl_pinned", E2E_ODOO_DB: "kl_pinned" }),
    );
    expect(ctx.databaseName).toBe("kl_pinned");
  });

  it("disagreeing ODOO_DATABASE/E2E_ODOO_DB fail", () => {
    expect(
      runSyncFailure(build(onBranch("main"), { ODOO_DATABASE: "kl_a", E2E_ODOO_DB: "kl_b" })),
    ).toBeInstanceOf(ConfigValidationError);
  });

  it("detached and non-repo states use a deterministic fallback name", () => {
    const detached = runSyncSuccess(build({ _tag: "Detached" }));
    const again = runSyncSuccess(build({ _tag: "Detached" }));
    expect(detached.worktreeName).toBe(again.worktreeName);
    expect(detached.worktreeName).toMatch(/^kriss-laure-[0-9a-f]{8}$/);
    expect(detached.databaseName).toMatch(/^kl_kriss_laure_[0-9a-f]{8}$/);
  });

  it("shared branch uses the shared database", () => {
    expect(runSyncSuccess(build(onBranch("main"))).databaseName).toBe("kl_e2e_demo");
  });

  it("threads project.stripBranchPrefixes into database derivation", () => {
    const custom = makeRecipe({
      project: { id: "kriss-laure", dbPrefix: "kl", stripBranchPrefixes: ["release"] },
      odoo: {
        version: "18.0",
        addons: [{ host: "backend/addons/Custom", container: "/mnt/extra-addons/Custom" }],
      },
    });
    const buildCustom = (branch: string) =>
      buildWorktreeContext({
        rootDir: "/work/kriss-laure",
        recipe: custom,
        env: {},
        git: onBranch(branch),
      });
    expect(runSyncSuccess(buildCustom("release/checkout")).databaseName).toBe("kl_checkout");
    expect(runSyncSuccess(buildCustom("feature/checkout")).databaseName).toBe(
      "kl_feature_checkout",
    );
  });
});

describe("substituteEnvTokens", () => {
  it("replaces $VARS that exist and leaves unknown ones", () => {
    const env = { ODOO_DATABASE: "kl_x", ODOO_BASE_URL: "http://127.0.0.1:18100" };
    expect(substituteEnvTokens("$ODOO_BASE_URL/web", env)).toBe("http://127.0.0.1:18100/web");
    expect(substituteEnvTokens("$UNKNOWN_VAR", env)).toBe("$UNKNOWN_VAR");
    expect(substituteEnvTokens("", env)).toBe("");
  });
});
