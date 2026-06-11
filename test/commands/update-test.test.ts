import { describe, expect, it } from "vitest"
import { resolveTestOptions } from "../../src/commands/test.js"
import { ConfigValidationError } from "../../src/errors/errors.js"
import { normalizeConfig, validateConfigInput } from "../../src/config/schema.js"

const recipe = normalizeConfig(validateConfigInput({
  project: { id: "kl", dbPrefix: "kl" },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
  test: { profiles: { payment: ["--test-tags", "payment_flow"] } }
}))

describe("resolveTestOptions", () => {
  it("maps flags directly", () => {
    expect(resolveTestOptions(recipe, { tags: "x", file: undefined, module: "m", logLevel: "test", profile: undefined }))
      .toEqual({ tags: "x", file: undefined, module: "m", logLevel: "test", extraArgs: [] })
  })

  it("expands a recipe profile into extraArgs", () => {
    expect(
      resolveTestOptions(recipe, {
        tags: undefined,
        file: undefined,
        module: undefined,
        logLevel: undefined,
        profile: "payment"
      })
    )
      .toEqual({
        tags: undefined,
        file: undefined,
        module: undefined,
        logLevel: undefined,
        extraArgs: ["--test-tags", "payment_flow"]
      })
  })

  it("rejects unknown profiles listing the available ones", () => {
    expect(() =>
      resolveTestOptions(recipe, {
        tags: undefined,
        file: undefined,
        module: undefined,
        logLevel: undefined,
        profile: "nope"
      })
    )
      .toThrow(ConfigValidationError)
    try {
      resolveTestOptions(recipe, {
        tags: undefined,
        file: undefined,
        module: undefined,
        logLevel: undefined,
        profile: "nope"
      })
    } catch (e) {
      expect(String((e as ConfigValidationError).issues)).toContain("payment")
    }
  })
})
