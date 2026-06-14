// test/commands/info.test.ts
import { describe, expect, it } from "vitest";
import { buildInfoEnv, buildInfoJson, buildInfoText } from "../../src/commands/info.js";
import { makeCtx, makeRecipe } from "../helpers.js";

const recipe = makeRecipe({
  project: {
    id: "kriss-laure",
    dbPrefix: "kl",
    sharedDatabase: "kl_e2e_demo",
    sharedBranches: ["main"],
  },
  ports: { odooBase: 18069, companionBase: 28028, range: 1000 },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/x" }] },
  envAliases: { E2E_PWA_PORT: "PWA_PORT" },
  companionApps: [
    {
      name: "pwa",
      cwd: "frontend",
      command: "pnpm",
      args: ["dev"],
      portEnv: "PWA_PORT",
      urlEnv: "PWA_URL",
    },
  ],
});

const ctx = makeCtx(recipe, "feature/KL-123-payment-flow", "/work/kl");

describe("info output", () => {
  it("text output contains the PRD-required lines", () => {
    const text = buildInfoText(ctx);
    expect(text).toContain("Worktree: feature/KL-123-payment-flow");
    expect(text).toContain("Database: kl_123_payment_flow");
    expect(text).toContain("Compose project: kriss_laure_kl_123_payment_flow");
    expect(text).toMatch(/Odoo URL: http:\/\/127\.0\.0\.1:\d+\/web/);
    expect(text).not.toContain("?db=");
    expect(text).toMatch(/pwa URL: http:\/\/localhost:\d+/);
  });

  it("json output is stable and machine-readable", () => {
    const a = JSON.parse(buildInfoJson(ctx));
    const b = JSON.parse(buildInfoJson(ctx));
    expect(a).toEqual(b);
    expect(a.databaseName).toBe("kl_123_payment_flow");
    expect(a.composeProjectName).toBe("kriss_laure_kl_123_payment_flow");
    expect(typeof a.odooHttpPort).toBe("number");
    expect(a.odooUrl).toBe(ctx.odooWebUrl);
    expect(a.odooExplicitDbUrl).toBe(`${ctx.odooWebUrl}?db=${ctx.databaseName}`);
    expect(a.companions.pwa).toBe(ctx.companionPorts.get("pwa"));
    expect(a.env.ODOO_DATABASE).toBe("kl_123_payment_flow");
  });

  it("env output includes companion port/url vars and their aliases", () => {
    const port = ctx.companionPorts.get("pwa");
    const lines = buildInfoEnv(ctx).split("\n");
    expect(lines).toContain(`PWA_PORT=${port}`);
    expect(lines).toContain(`PWA_URL=http://localhost:${port}`);
    expect(lines).toContain(`E2E_PWA_PORT=${port}`);
  });
});
