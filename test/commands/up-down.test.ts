import { describe, expect, it } from "vitest"
import { buildUpPlan } from "../../src/commands/up.js"
import { buildDownArgs, guardDown } from "../../src/commands/down.js"
import { SharedDatabaseProtectionError } from "../../src/errors/errors.js"
import { normalizeConfig, validateConfigInput } from "../../src/config/schema.js"
import { buildWorktreeContext } from "../../src/core/worktree-context.js"

const recipe = normalizeConfig(validateConfigInput({
  project: { id: "kl", dbPrefix: "kl", sharedDatabase: "kl_e2e_demo", sharedBranches: ["main"] },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
  companionApps: [{ name: "pwa", cwd: "frontend", command: "pnpm", args: ["dev"], portEnv: "PWA_PORT", env: { VITE_DB: "$ODOO_DATABASE" } }]
}))
const onMain = buildWorktreeContext({ rootDir: "/w", recipe, env: {}, git: { _tag: "Branch", branch: "main" } })
const onFeature = buildWorktreeContext({ rootDir: "/w", recipe, env: {}, git: { _tag: "Branch", branch: "feature/z" } })

describe("buildUpPlan", () => {
  it("builds compose args and companion specs with injected env", () => {
    const plan = buildUpPlan(recipe, onFeature, { odooOnly: false, noBuild: false, detach: false, logs: false })
    expect(plan.upArgs).toEqual(["up", "-d", "--build", "odoo"])
    expect(plan.companions).toHaveLength(1)
    const pwa = plan.companions[0]!
    expect(pwa.name).toBe("pwa")
    expect(pwa.cwd).toBe("/w/frontend")
    expect(pwa.env.PWA_PORT).toBe(String(onFeature.companionPorts.get("pwa")))
    expect(pwa.env.VITE_DB).toBe(onFeature.databaseName)
    expect(pwa.env.ODOO_DATABASE).toBe(onFeature.databaseName)
  })

  it("--no-build drops --build; --odoo-only drops companions", () => {
    const plan = buildUpPlan(recipe, onFeature, { odooOnly: true, noBuild: true, detach: false, logs: false })
    expect(plan.upArgs).toEqual(["up", "-d", "odoo"])
    expect(plan.companions).toEqual([])
  })
})

describe("down guard", () => {
  it("refuses --volumes on the shared database without --allow-shared", () => {
    expect(() => guardDown(recipe, onMain, { volumes: true, allowShared: false }))
      .toThrow(SharedDatabaseProtectionError)
    expect(() => guardDown(recipe, onMain, { volumes: false, allowShared: false })).not.toThrow()
    expect(() => guardDown(recipe, onFeature, { volumes: true, allowShared: false })).not.toThrow()
    expect(() => guardDown(recipe, onMain, { volumes: true, allowShared: true })).not.toThrow()
  })

  it("buildDownArgs maps --volumes", () => {
    expect(buildDownArgs({ volumes: false })).toEqual(["down"])
    expect(buildDownArgs({ volumes: true })).toEqual(["down", "--volumes"])
  })
})
