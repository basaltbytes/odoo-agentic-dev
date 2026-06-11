#!/usr/bin/env node
import { Cause, Console, Effect, Layer } from "effect";
import { CliError, Command } from "effect/unstable/cli";
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

const services = Layer.mergeAll(GitLive, OdooLifecycleLive, ProcessSupervisorLive).pipe(
  Layer.provideMerge(DockerComposeLive),
  Layer.provideMerge(CommandRunnerLive),
  Layer.provideMerge(NodeServices.layer),
);

const program = Command.run(root, { version: "0.1.0" }).pipe(
  Effect.catch((error) =>
    Effect.gen(function* () {
      // ShowHelp is the cli library's control-flow signal: by the time it
      // reaches us the help text is already printed (bare invocation or
      // unknown subcommand), so the error itself must not be rendered.
      const helpRequested = CliError.isCliError(error) && error._tag === "ShowHelp";
      if (!helpRequested) {
        yield* Console.error(isRuntimeError(error) ? renderError(error) : String(error));
      }
      process.exitCode = 1;
    }),
  ),
  Effect.provide(services),
  // Defects (Die causes, thrown TypeErrors, ...) are not on the typed channel
  // above and runMain's reporting is disabled, so render them ourselves
  // instead of exiting silently. Placed after Effect.provide so defects raised
  // during layer construction are caught too.
  Effect.catchDefect((defect) =>
    Effect.gen(function* () {
      yield* Console.error(
        "Unexpected internal error — this is a bug in odoo-agentic-dev, please report it:",
      );
      yield* Console.error(Cause.pretty(Cause.die(defect)));
      process.exitCode = 1;
    }),
  ),
);

NodeRuntime.runMain(program, { disableErrorReporting: true });
