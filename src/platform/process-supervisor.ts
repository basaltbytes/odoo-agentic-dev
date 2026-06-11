import { Context, Effect, Layer } from "effect";
import { CompanionProcessError } from "../errors/errors.js";
import type { CommandFailedError } from "../errors/errors.js";
import { CommandRunner } from "./command-runner.js";

export type CompanionSpec = {
  readonly name: string;
  readonly cwd: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string>;
};

export interface ProcessSupervisorApi {
  /** Run all companions concurrently; first failure interrupts the rest. */
  readonly runAll: (
    specs: ReadonlyArray<CompanionSpec>,
  ) => Effect.Effect<void, CompanionProcessError | CommandFailedError>;
}

export const ProcessSupervisor = Context.Service<ProcessSupervisorApi>(
  "odoo-agentic-dev/ProcessSupervisor",
);

export const ProcessSupervisorLive = Layer.effect(
  ProcessSupervisor,
  Effect.gen(function* () {
    const runner = yield* CommandRunner;
    return {
      runAll: (specs) =>
        specs.length === 0
          ? Effect.void
          : Effect.all(
              specs.map((spec) =>
                runner
                  .runInherited({
                    command: spec.command,
                    args: spec.args,
                    cwd: spec.cwd,
                    env: spec.env,
                    prefix: `[${spec.name}] `,
                  })
                  .pipe(
                    Effect.flatMap((code) =>
                      code === 0
                        ? Effect.void
                        : Effect.fail(
                            new CompanionProcessError({ name: spec.name, exitCode: code }),
                          ),
                    ),
                  ),
              ),
              { concurrency: "unbounded" },
            ).pipe(Effect.asVoid),
    };
  }),
);
