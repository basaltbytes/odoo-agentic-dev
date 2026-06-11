import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildComposeModel, renderComposeYaml } from "../../src/core/compose-model.js";
import { makeCtx, makeRecipe } from "../helpers.js";

const recipe = makeRecipe({
  project: { id: "kriss-laure", dbPrefix: "kl" },
  odoo: {
    version: "18.0-20250606",
    configFile: "config/odoo.worktree.conf",
    dockerfile: "Dockerfile.odoo",
    imageName: "krisslaure-odoo-agentic-dev",
    addons: [
      { host: "backend/addons/Custom", container: "/mnt/extra-addons/Custom" },
      { host: "backend/addons/OCA", container: "/mnt/extra-addons/OCA" },
    ],
  },
});
const ctx = makeCtx(recipe, "feature/x", "/work/kl");
const model = buildComposeModel(recipe, ctx);

describe("buildComposeModel", () => {
  it("renders YAML that parses back to the model", () => {
    expect(parse(renderComposeYaml(model))).toEqual(JSON.parse(JSON.stringify(model)));
  });

  it("uses build+image when a dockerfile is configured", () => {
    const odoo = model.services["odoo"] as Record<string, unknown>;
    expect(odoo["build"]).toEqual({ context: ".", dockerfile: "Dockerfile.odoo" });
    expect(odoo["image"]).toBe("krisslaure-odoo-agentic-dev");
  });

  it("falls back to the official image without a dockerfile", () => {
    const plain = makeRecipe({
      project: { id: "x", dbPrefix: "x" },
      odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
    });
    const plainCtx = makeCtx(plain, "b");
    const m = buildComposeModel(plain, plainCtx);
    expect((m.services["odoo"] as Record<string, unknown>)["image"]).toBe("odoo:18.0");
  });

  it("maps the derived port on loopback, addon mounts, config mount, and healthy-db dependency", () => {
    const odoo = model.services["odoo"] as Record<string, any>;
    expect(odoo.ports).toEqual([`127.0.0.1:${ctx.odooHttpPort}:8069`]);
    expect(odoo.volumes).toContain("./backend/addons/Custom:/mnt/extra-addons/Custom");
    expect(odoo.volumes).toContain("./config/odoo.worktree.conf:/etc/odoo/odoo.conf");
    expect(odoo.depends_on).toEqual({ db: { condition: "service_healthy" } });
    const db = model.services["db"] as Record<string, any>;
    expect(db.image).toBe("postgres:16");
    expect(db.healthcheck.test).toEqual(["CMD-SHELL", "pg_isready -U odoo -d postgres"]);
  });

  it("stamps oad labels on both services and both volumes", () => {
    const expected = {
      "dev.basaltbytes.oad": "1",
      "dev.basaltbytes.oad.project-id": "kriss-laure",
      "dev.basaltbytes.oad.database": ctx.databaseName,
      "dev.basaltbytes.oad.root-dir": "/work/kl",
      "dev.basaltbytes.oad.branch": "feature/x",
    };
    expect((model.services["odoo"] as Record<string, unknown>)["labels"]).toEqual(expected);
    expect((model.services["db"] as Record<string, unknown>)["labels"]).toEqual(expected);
    expect(model.volumes).toEqual({
      "db-data": { labels: expected },
      "web-data": { labels: expected },
    });
  });

  it("renders an empty-string branch label when the context has no branch", () => {
    const m = buildComposeModel(recipe, { ...ctx, branch: null });
    const labels = (m.services["odoo"] as Record<string, any>)["labels"];
    expect(labels["dev.basaltbytes.oad.branch"]).toBe("");
    expect(parse(renderComposeYaml(m))).toEqual(JSON.parse(JSON.stringify(m)));
  });

  it("is deterministic", () => {
    expect(renderComposeYaml(model)).toBe(renderComposeYaml(buildComposeModel(recipe, ctx)));
  });
});
