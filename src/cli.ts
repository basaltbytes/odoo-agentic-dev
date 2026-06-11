#!/usr/bin/env node
import { Console, Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { infoCommand } from "./commands/info.js"
import { CommandRunnerLive } from "./platform/command-runner.js"
import { GitLive } from "./platform/git.js"
import { isRuntimeError, renderError } from "./errors/errors.js"

const root = Command.make("odoo-agentic-dev").pipe(
  Command.withDescription("Agent-friendly local Odoo development runtime"),
  Command.withSubcommands([infoCommand])
)

const services = Layer.mergeAll(
  GitLive.pipe(Layer.provide(CommandRunnerLive)),
  CommandRunnerLive
).pipe(Layer.provideMerge(NodeServices.layer))

const program = Command.run(root, { version: "0.1.0" }).pipe(
  Effect.catch((error) =>
    Effect.gen(function* () {
      yield* Console.error(isRuntimeError(error) ? renderError(error) : String(error))
      yield* Effect.sync(() => {
        process.exitCode = 1
      })
    })
  ),
  Effect.provide(services)
)

NodeRuntime.runMain(program, { disableErrorReporting: true })
