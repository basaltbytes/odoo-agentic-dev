import { describe, expect, it } from "vitest"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Command, Flag } from "effect/unstable/cli"
import { NodeServices } from "@effect/platform-node"

describe("effect v4 beta API smoke test", () => {
  it("runs a trivial effect", async () => {
    expect(await Effect.runPromise(Effect.succeed(41 + 1))).toBe(42)
  })

  it("Schema has the constructors we rely on", () => {
    for (const member of [Schema.Struct, Schema.String, Schema.Boolean, Schema.Number,
      Schema.Literal, Schema.Union, Schema.Record, Schema.Array, Schema.optional,
      Schema.decodeUnknownSync]) {
      expect(member).toBeDefined()
    }
    const S = Schema.Struct({ a: Schema.String })
    expect(Schema.decodeUnknownSync(S)({ a: "x" })).toEqual({ a: "x" })
    expect(() => Schema.decodeUnknownSync(S)({ a: 1 })).toThrow()
  })

  it("Data.TaggedError produces catchable tagged classes", () => {
    class Boom extends Data.TaggedError("Boom")<{ readonly why: string }> {}
    const e = new Boom({ why: "test" })
    expect(e._tag).toBe("Boom")
    expect(e.why).toBe("test")
  })

  it("Context.Service + Layer wire a service", async () => {
    interface Api { readonly n: number }
    const Svc = Context.Service<Api>("smoke/Svc")
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Svc
        return svc.n
      }).pipe(Effect.provide(Layer.succeed(Svc, { n: 7 })))
    )
    expect(out).toBe(7)
  })

  it("ChildProcess array form + NodeServices spawns a process", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* ChildProcess.make("node", ["-e", "console.log('ok')"])
          return yield* handle.exitCode
        })
      ).pipe(Effect.provide(NodeServices.layer))
    )
    expect(result).toBe(0)
  })

  it("cli Command/Flag exist", () => {
    const cmd = Command.make("x", { f: Flag.boolean("f") })
    expect(cmd).toBeDefined()
  })
})
