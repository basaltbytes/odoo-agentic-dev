import { describe, expect, it } from "vitest"
import { normalizeConfig, validateConfigInput } from "../../src/config/schema.js"
import { ConfigValidationError } from "../../src/errors/errors.js"

const minimal = {
  project: { id: "billing-odoo", dbPrefix: "billing" },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/extra-addons/custom" }] }
}

describe("validateConfigInput", () => {
  it("accepts a minimal config", () => {
    expect(validateConfigInput(minimal)).toEqual(minimal)
  })

  it("rejects a non-object and missing required fields", () => {
    expect(() => validateConfigInput("nope")).toThrow(ConfigValidationError)
    expect(() => validateConfigInput({ project: { id: "x" } })).toThrow(ConfigValidationError)
  })

  it("rejects an unknown hook type", () => {
    const bad = {
      ...minimal,
      database: { postInit: [{ type: "winrm-exec", cmd: "x" }] }
    }
    expect(() => validateConfigInput(bad)).toThrow(ConfigValidationError)
  })
})

describe("normalizeConfig", () => {
  it("applies every documented default", () => {
    const cfg = normalizeConfig(validateConfigInput(minimal))
    expect(cfg.ports).toEqual({ odooBase: 18069, companionBase: 28000, range: 1000 })
    expect(cfg.odoo.serviceName).toBe("odoo")
    expect(cfg.odoo.databaseServiceName).toBe("db")
    expect(cfg.odoo.postgresImage).toBe("postgres:16")
    expect(cfg.odoo.configFile).toBeNull()
    expect(cfg.database.withoutDemo).toBe("all")
    expect(cfg.database.initialModules).toEqual([])
    expect(cfg.project.sharedDatabase).toBeNull()
    expect(cfg.project.sharedBranches).toEqual([])
    expect(cfg.compose.file).toBeNull()
    expect(cfg.companionApps).toEqual([])
  })

  it("defaults sharedBranches to main/master when sharedDatabase is set", () => {
    const cfg = normalizeConfig(validateConfigInput({
      ...minimal,
      project: { ...minimal.project, sharedDatabase: "billing_dev" }
    }))
    expect(cfg.project.sharedBranches).toEqual(["main", "master"])
  })

  it.each([
    ["bad dbPrefix", { ...minimal, project: { id: "x", dbPrefix: "9bad" } }, /dbPrefix/],
    ["duplicate container mounts", {
      ...minimal,
      odoo: { version: "18.0", addons: [
        { host: "a", container: "/mnt/x" }, { host: "b", container: "/mnt/x" }
      ] }
    }, /duplicate/i],
    ["port range too small", { ...minimal, ports: { range: 1 } }, /range/],
    ["unsafe companion name", {
      ...minimal,
      companionApps: [{ name: "P W A!", cwd: ".", command: "pnpm", args: ["dev"] }]
    }, /companion/i],
    ["addon escaping repo", {
      ...minimal,
      odoo: { version: "18.0", addons: [{ host: "../outside", container: "/mnt/x" }] }
    }, /outside/i]
  ])("rejects %s", (_label, input, pattern) => {
    expect(() => normalizeConfig(validateConfigInput(input))).toThrow(pattern)
  })

  it("allows addon outside repo when explicitly flagged", () => {
    const cfg = normalizeConfig(validateConfigInput({
      ...minimal,
      odoo: { version: "18.0", addons: [{ host: "../outside", container: "/mnt/x", allowOutsideRepo: true }] }
    }))
    expect(cfg.odoo.addons[0]?.host).toBe("../outside")
  })
})
