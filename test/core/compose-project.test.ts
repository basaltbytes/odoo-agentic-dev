import { describe, expect, it } from "vitest"
import { deriveComposeProjectName } from "../../src/core/compose-project.js"
import { ConfigValidationError } from "../../src/errors/errors.js"

describe("deriveComposeProjectName", () => {
  it("matches the PRD example", () => {
    expect(deriveComposeProjectName("kriss-laure", "kl_123_payment_flow"))
      .toBe("kriss_laure_kl_123_payment_flow")
  })

  it("sanitizes the project id", () => {
    expect(deriveComposeProjectName("My Project!", "db_x")).toBe("my_project_db_x")
  })

  it("never returns an empty or invalid name", () => {
    expect(() => deriveComposeProjectName("!!!", "")).toThrow(ConfigValidationError)
  })
})
