import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildComposeModel, renderComposeYaml } from "../../src/core/compose-model.js";
import { GENERATED_DOCKERFILE_RELATIVE_PATH } from "../../src/core/dockerfile-model.js";
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

  it("points the build at the generated Dockerfile when odoo.build is configured", () => {
    const built = makeRecipe({
      project: { id: "x", dbPrefix: "x" },
      odoo: {
        version: "18.0",
        build: { pipPackages: ["requests"] },
        addons: [{ host: "addons", container: "/mnt/c" }],
      },
    });
    const m = buildComposeModel(built, makeCtx(built, "b"));
    expect((m.services["odoo"] as Record<string, unknown>)["build"]).toEqual({
      context: ".",
      dockerfile: GENERATED_DOCKERFILE_RELATIVE_PATH,
    });
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

  it("serves exactly the derived database with addons path and dev mode", () => {
    const odoo = model.services["odoo"] as Record<string, any>;
    expect(odoo.command).toEqual([
      "odoo",
      `--database=${ctx.databaseName}`,
      "--http-port=8069",
      "--no-database-list",
      "--addons-path=/usr/lib/python3/dist-packages/odoo/addons,/mnt/extra-addons/Custom,/mnt/extra-addons/OCA",
      "--dev=xml,reload",
    ]);
  });

  it("omits --dev when odoo.dev is false", () => {
    const noDev = makeRecipe({
      project: { id: "x", dbPrefix: "x" },
      odoo: { version: "18.0", dev: false, addons: [{ host: "addons", container: "/mnt/c" }] },
    });
    const m = buildComposeModel(noDev, makeCtx(noDev, "b"));
    const command = (m.services["odoo"] as Record<string, any>).command as Array<string>;
    expect(command.some((arg) => arg.startsWith("--dev"))).toBe(false);
  });

  it("injects the full context env into the odoo service", () => {
    const env = (model.services["odoo"] as Record<string, any>).environment;
    expect(env.HOST).toBe("db");
    expect(env.ODOO_DATABASE).toBe(ctx.databaseName);
    expect(env.ODOO_BASE_URL).toBe(ctx.odooBaseUrl);
    expect(env.ODOO_HTTP_PORT).toBe(String(ctx.odooHttpPort));
  });

  it("restarts both services unless stopped", () => {
    expect((model.services["odoo"] as Record<string, any>).restart).toBe("unless-stopped");
    expect((model.services["db"] as Record<string, any>).restart).toBe("unless-stopped");
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

describe("buildComposeModel (portable mode)", () => {
  const portable = buildComposeModel(recipe, ctx, { portable: true });

  it("interpolates the database into the command instead of baking it", () => {
    const command = (portable.services["odoo"] as Record<string, any>).command as Array<string>;
    expect(command).toContain("--database=${ODOO_DATABASE:?}");
    expect(command.some((arg) => arg.includes(ctx.databaseName))).toBe(false);
  });

  it("interpolates the http port into the ports entry instead of baking it", () => {
    const odoo = portable.services["odoo"] as Record<string, any>;
    expect(odoo.ports).toEqual(["127.0.0.1:${ODOO_HTTP_PORT:?}:8069"]);
  });

  it("maps each context env key to a required interpolation, keeping HOST/USER/PASSWORD literal", () => {
    const env = (portable.services["odoo"] as Record<string, any>).environment as Record<
      string,
      string
    >;
    expect(env.HOST).toBe("db");
    expect(env.USER).toBe("odoo");
    expect(env.PASSWORD).toBe("odoo");
    for (const key of Object.keys(ctx.env)) {
      expect(env[key]).toBe(`\${${key}:?}`);
    }
    // and the literal derived values never leak through
    expect(env.ODOO_DATABASE).toBe("${ODOO_DATABASE:?}");
    expect(env.ODOO_HTTP_PORT).toBe("${ODOO_HTTP_PORT:?}");
  });

  it("keeps static labels literal, interpolates database, and omits root-dir/branch", () => {
    const expected = {
      "dev.basaltbytes.oad": "1",
      "dev.basaltbytes.oad.project-id": "kriss-laure",
      "dev.basaltbytes.oad.database": "${ODOO_DATABASE}",
    };
    expect((portable.services["odoo"] as Record<string, unknown>)["labels"]).toEqual(expected);
    expect((portable.services["db"] as Record<string, unknown>)["labels"]).toEqual(expected);
    expect(portable.volumes).toEqual({
      "db-data": { labels: expected },
      "web-data": { labels: expected },
    });
    const odooLabels = (portable.services["odoo"] as Record<string, any>)["labels"] as Record<
      string,
      string
    >;
    expect(odooLabels["dev.basaltbytes.oad.root-dir"]).toBeUndefined();
    expect(odooLabels["dev.basaltbytes.oad.branch"]).toBeUndefined();
  });

  it("bakes neither the database name nor the port number anywhere in the YAML", () => {
    const yaml = renderComposeYaml(portable);
    expect(yaml).not.toContain(ctx.databaseName);
    expect(yaml).not.toContain(String(ctx.odooHttpPort));
    expect(yaml).not.toContain("/work/kl");
    expect(yaml).not.toContain("feature/x");
  });

  it("renders YAML that parses back to the model and is deterministic", () => {
    expect(parse(renderComposeYaml(portable))).toEqual(JSON.parse(JSON.stringify(portable)));
    expect(renderComposeYaml(portable)).toBe(
      renderComposeYaml(buildComposeModel(recipe, ctx, { portable: true })),
    );
  });

  it("points build.dockerfile at the dockerfilePath override when provided", () => {
    const built = makeRecipe({
      project: { id: "x", dbPrefix: "x" },
      odoo: {
        version: "18.0",
        build: { pipPackages: ["requests"] },
        addons: [{ host: "addons", container: "/mnt/c" }],
      },
    });
    const m = buildComposeModel(built, makeCtx(built, "b"), {
      portable: true,
      dockerfilePath: "Dockerfile.odoo",
    });
    expect((m.services["odoo"] as Record<string, unknown>)["build"]).toEqual({
      context: ".",
      dockerfile: "Dockerfile.odoo",
    });
  });

  it("falls back to the generated dockerfile path when no override is given", () => {
    const built = makeRecipe({
      project: { id: "x", dbPrefix: "x" },
      odoo: {
        version: "18.0",
        build: { pipPackages: ["requests"] },
        addons: [{ host: "addons", container: "/mnt/c" }],
      },
    });
    const m = buildComposeModel(built, makeCtx(built, "b"), { portable: true });
    expect((m.services["odoo"] as Record<string, unknown>)["build"]).toEqual({
      context: ".",
      dockerfile: GENERATED_DOCKERFILE_RELATIVE_PATH,
    });
  });
});
