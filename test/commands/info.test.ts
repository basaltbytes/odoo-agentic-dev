// test/commands/info.test.ts
import { describe, expect, it } from "vitest";
import { buildInfoJson, buildInfoText } from "../../src/commands/info.js";
import { buildWorktreeContext } from "../../src/core/worktree-context.js";
import { normalizeConfig, validateConfigInput } from "../../src/config/schema.js";

const recipe = normalizeConfig(
  validateConfigInput({
    project: {
      id: "kriss-laure",
      dbPrefix: "kl",
      sharedDatabase: "kl_e2e_demo",
      sharedBranches: ["main"],
    },
    ports: { odooBase: 18069, companionBase: 28028, range: 1000 },
    odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/x" }] },
    companionApps: [
      { name: "pwa", cwd: "frontend", command: "pnpm", args: ["dev"], portEnv: "PWA_PORT" },
    ],
  }),
);

const ctx = buildWorktreeContext({
  rootDir: "/work/kl",
  recipe,
  env: {},
  git: { _tag: "Branch", branch: "feature/KL-123-payment-flow" },
});

describe("info output", () => {
  it("text output contains the PRD-required lines", () => {
    const text = buildInfoText(ctx);
    expect(text).toContain("Worktree: feature/KL-123-payment-flow");
    expect(text).toContain("Database: kl_123_payment_flow");
    expect(text).toContain("Compose project: kriss_laure_kl_123_payment_flow");
    expect(text).toMatch(/Odoo URL: http:\/\/127\.0\.0\.1:\d+\/web\?db=kl_123_payment_flow/);
    expect(text).toMatch(/pwa URL: http:\/\/localhost:\d+/);
  });

  it("json output is stable and machine-readable", () => {
    const a = JSON.parse(buildInfoJson(ctx));
    const b = JSON.parse(buildInfoJson(ctx));
    expect(a).toEqual(b);
    expect(a.databaseName).toBe("kl_123_payment_flow");
    expect(a.composeProjectName).toBe("kriss_laure_kl_123_payment_flow");
    expect(typeof a.odooHttpPort).toBe("number");
    expect(a.companions.pwa).toBe(ctx.companionPorts.get("pwa"));
    expect(a.env.ODOO_DATABASE).toBe("kl_123_payment_flow");
  });
});
