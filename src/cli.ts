#!/usr/bin/env node
// must stay first: installs the node:sqlite ExperimentalWarning filter before
// any import that could transitively load node:sqlite (imports hoist)
import "./suppress-sqlite-warning.js";
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
import { listCommand } from "./commands/list.js";
import { pruneCommand } from "./commands/prune.js";
import { doctorCommand } from "./commands/doctor.js";
import { logsCommand } from "./commands/logs.js";
import { shellCommand } from "./commands/shell.js";
import { psqlCommand } from "./commands/psql.js";
import { runCommand } from "./commands/run.js";
import { CommandRunnerLive } from "./platform/command-runner.js";
import { GitLive } from "./platform/git.js";
import { DockerComposeLive } from "./platform/docker-compose.js";
import { OdooLifecycleLive } from "./platform/odoo-lifecycle.js";
import { ProcessSupervisorLive } from "./platform/process-supervisor.js";
import { StateStoreLive } from "./platform/state-store.js";
import { PortProbeLive } from "./platform/port-probe.js";
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
    listCommand,
    pruneCommand,
    doctorCommand,
    logsCommand,
    shellCommand,
    psqlCommand,
    runCommand,
  ]),
);

const services = Layer.mergeAll(
  GitLive,
  OdooLifecycleLive,
  ProcessSupervisorLive,
  StateStoreLive,
  PortProbeLive,
).pipe(
  Layer.provideMerge(DockerComposeLive),
  Layer.provideMerge(CommandRunnerLive),
  Layer.provideMerge(NodeServices.layer),
);

const program = Command.runWith(root, { version: "0.1.0-beta.1" })(process.argv.slice(2)).pipe(
  Effect.provide(services),
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
