import { describe, expect, it } from "vitest"
import {
  CommandFailedError, ConfigValidationError, SharedDatabaseProtectionError,
  isRuntimeError, renderError
} from "../../src/errors/errors.js"

describe("renderError", () => {
  it("renders shared-db protection with the exact retry flag", () => {
    const text = renderError(new SharedDatabaseProtectionError({ database: "kl_e2e_demo", action: "reset-db" }))
    expect(text).toContain("kl_e2e_demo")
    expect(text).toContain("--allow-shared")
    expect(text).toContain("reset-db")
  })

  it("renders command failures with argv, cwd, exit code and a next action", () => {
    const text = renderError(new CommandFailedError({
      command: "docker", args: ["compose", "up"], cwd: "/work", exitCode: 17, stderrTail: "boom"
    }))
    expect(text).toContain("docker compose up")
    expect(text).toContain("/work")
    expect(text).toContain("17")
    expect(text).toContain("boom")
  })

  it("renders validation issues as a list", () => {
    const text = renderError(new ConfigValidationError({ issues: ["a bad", "b bad"] }))
    expect(text).toContain("a bad")
    expect(text).toContain("b bad")
  })

  it("isRuntimeError discriminates", () => {
    expect(isRuntimeError(new ConfigValidationError({ issues: [] }))).toBe(true)
    expect(isRuntimeError(new Error("nope"))).toBe(false)
  })
})
