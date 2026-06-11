import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { ProcessSupervisor, ProcessSupervisorLive } from "../../src/platform/process-supervisor.js"
import { makeRecordingRunner } from "../../src/testing/fake-adapters.js"
import { CompanionProcessError } from "../../src/errors/errors.js"
import type { CommandRunnerApi } from "../../src/platform/command-runner.js"

const run = <A, E>(layer: Layer.Layer<CommandRunnerApi>, effect: Effect.Effect<A, E, any>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.provide(ProcessSupervisorLive, layer))) as Effect.Effect<A, E>)

describe("ProcessSupervisorLive", () => {
  it("runs every companion with prefix and env", async () => {
    const recording = makeRecordingRunner()
    await run(recording.layer, Effect.gen(function* () {
      const supervisor = yield* ProcessSupervisor
      yield* supervisor.runAll([
        { name: "pwa", cwd: "/w/frontend", command: "pnpm", args: ["dev"], env: { ODOO_DATABASE: "kl_x" } },
        { name: "mock", cwd: "/w", command: "node", args: ["mock.js"], env: {} }
      ])
    }))
    expect(recording.calls).toHaveLength(2)
    expect(recording.calls[0]).toMatchObject({ command: "pnpm", prefix: "[pwa] ", env: { ODOO_DATABASE: "kl_x" } })
  })

  it("fails with CompanionProcessError naming the failing app", async () => {
    const recording = makeRecordingRunner((spec) =>
      spec.command === "node" ? { exitCode: 5, stdout: "", stderr: "" } : undefined)
    await expect(run(recording.layer, Effect.gen(function* () {
      const supervisor = yield* ProcessSupervisor
      yield* supervisor.runAll([
        { name: "mock", cwd: "/w", command: "node", args: ["mock.js"], env: {} }
      ])
    }))).rejects.toThrow(CompanionProcessError)
  })

  it("no companions is a no-op", async () => {
    const recording = makeRecordingRunner()
    await run(recording.layer, Effect.gen(function* () {
      const supervisor = yield* ProcessSupervisor
      yield* supervisor.runAll([])
    }))
    expect(recording.calls).toHaveLength(0)
  })
})
