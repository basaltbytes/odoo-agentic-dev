import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { ProcessSupervisor, ProcessSupervisorLive } from "../../src/platform/process-supervisor.js";
import { makeRecordingRunner } from "../../src/testing/fake-adapters.js";
import { CompanionProcessError } from "../../src/errors/errors.js";
import { runWith } from "../helpers.js";

const makeEnv = (script?: Parameters<typeof makeRecordingRunner>[0]) => {
  const recording = makeRecordingRunner(script);
  return { recording, run: runWith(Layer.provide(ProcessSupervisorLive, recording.layer)) };
};

describe("ProcessSupervisorLive", () => {
  it("runs every companion with prefix and env", async () => {
    const { recording, run } = makeEnv();
    await run(
      Effect.gen(function* () {
        const supervisor = yield* ProcessSupervisor;
        yield* supervisor.runAll([
          {
            name: "pwa",
            cwd: "/w/frontend",
            command: "pnpm",
            args: ["dev"],
            env: { ODOO_DATABASE: "kl_x" },
          },
          { name: "mock", cwd: "/w", command: "node", args: ["mock.js"], env: {} },
        ]);
      }),
    );
    expect(recording.calls).toHaveLength(2);
    expect(recording.calls[0]).toMatchObject({
      command: "pnpm",
      prefix: "[pwa] ",
      env: { ODOO_DATABASE: "kl_x" },
    });
  });

  it("fails with CompanionProcessError naming the failing app", async () => {
    const { run } = makeEnv((spec) =>
      spec.command === "node" ? { exitCode: 5, stdout: "", stderr: "" } : undefined,
    );
    await expect(
      run(
        Effect.gen(function* () {
          const supervisor = yield* ProcessSupervisor;
          yield* supervisor.runAll([
            { name: "mock", cwd: "/w", command: "node", args: ["mock.js"], env: {} },
          ]);
        }),
      ),
    ).rejects.toThrow(CompanionProcessError);
  });

  it("no companions is a no-op", async () => {
    const { recording, run } = makeEnv();
    await run(
      Effect.gen(function* () {
        const supervisor = yield* ProcessSupervisor;
        yield* supervisor.runAll([]);
      }),
    );
    expect(recording.calls).toHaveLength(0);
  });
});
