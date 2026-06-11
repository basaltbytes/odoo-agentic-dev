#!/usr/bin/env node
import { Console, Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { infoCommand } from "./commands/info.js";
import { setupCommand } from "./commands/setup.js";
import { upCommand } from "./commands/up.js";
import { downCommand } from "./commands/down.js";
import { resetDbCommand } from "./commands/reset-db.js";
import { updateCommand } from "./commands/update.js";
import { testCommand } from "./commands/test.js";
import { linkSourceCommand } from "./commands/link-source.js";
import { CommandRunnerLive } from "./platform/command-runner.js";
import { GitLive } from "./platform/git.js";
import { DockerComposeLive } from "./platform/docker-compose.js";
import { OdooLifecycleLive } from "./platform/odoo-lifecycle.js";
import { ProcessSupervisorLive } from "./platform/process-supervisor.js";
import { isRuntimeError, renderError } from "./errors/errors.js";

const root = Command.make("odoo-agentic-dev").pipe(
  Command.withDescription("Agent-friendly local Odoo development runtime"),
  Command.withSubcommands([
    infoCommand,
    setupCommand,
    upCommand,
    downCommand,
    resetDbCommand,
    updateCommand,
    testCommand,
    linkSourceCommand,
  ]),
);

const services = Layer.mergeAll(
  GitLive.pipe(Layer.provide(CommandRunnerLive)),
  DockerComposeLive.pipe(Layer.provide(CommandRunnerLive)),
  OdooLifecycleLive.pipe(
    Layer.provide(DockerComposeLive.pipe(Layer.provide(CommandRunnerLive))),
    Layer.provide(CommandRunnerLive),
  ),
  ProcessSupervisorLive.pipe(Layer.provide(CommandRunnerLive)),
  CommandRunnerLive,
).pipe(Layer.provideMerge(NodeServices.layer));

const program = Command.run(root, { version: "0.1.0" }).pipe(
  Effect.catch((error) =>
    Effect.gen(function* () {
      yield* Console.error(isRuntimeError(error) ? renderError(error) : String(error));
      yield* Effect.sync(() => {
        process.exitCode = 1;
      });
    }),
  ),
  Effect.provide(services),
);

NodeRuntime.runMain(program, { disableErrorReporting: true });
