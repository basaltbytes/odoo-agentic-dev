// test/platform/command-runner.test.ts
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { NodeServices } from "@effect/platform-node";
import { CommandRunner, CommandRunnerLive } from "../../src/platform/command-runner.js";
import { makeRecordingRunner } from "../../src/testing/fake-adapters.js";

const runLive = <A, E>(effect: Effect.Effect<A, E, any>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(CommandRunnerLive),
      Effect.provide(NodeServices.layer),
    ) as Effect.Effect<A, E>,
  );

describe("CommandRunnerLive", () => {
  it("captures stdout, stderr and exit code", async () => {
    const result = await runLive(
      Effect.gen(function* () {
        const runner = yield* CommandRunner;
        return yield* runner.run({
          command: "node",
          args: ["-e", "console.log('out'); console.error('err'); process.exit(3)"],
        });
      }),
    );
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain("out");
    expect(result.stderr).toContain("err");
  });

  it("merges env over the parent env", async () => {
    const result = await runLive(
      Effect.gen(function* () {
        const runner = yield* CommandRunner;
        return yield* runner.run({
          command: "node",
          args: [
            "-e",
            "console.log(process.env.OAD_TEST_VAR + ':' + (process.env.PATH ? 'has-path' : 'no-path'))",
          ],
          env: { OAD_TEST_VAR: "hello" },
        });
      }),
    );
    expect(result.stdout).toContain("hello:has-path");
  });

  it("pipes stdin to the child", async () => {
    const result = await runLive(
      Effect.gen(function* () {
        const runner = yield* CommandRunner;
        return yield* runner.run({
          command: "node",
          args: ["-e", "process.stdin.pipe(process.stdout)"],
          stdin: "fed-via-stdin",
        });
      }),
    );
    expect(result.stdout).toContain("fed-via-stdin");
  });
});

describe("makeRecordingRunner", () => {
  it("records calls and returns scripted results", async () => {
    const recording = makeRecordingRunner((spec) =>
      spec.args[0] === "version" ? { exitCode: 0, stdout: "Docker 27", stderr: "" } : undefined,
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* CommandRunner;
        yield* runner.run({ command: "docker", args: ["compose", "up"] });
        return yield* runner.run({ command: "docker", args: ["version"] });
      }).pipe(Effect.provide(recording.layer)),
    );
    expect(result.stdout).toBe("Docker 27");
    expect(recording.calls.map((c) => [c.command, ...c.args].join(" "))).toEqual([
      "docker compose up",
      "docker version",
    ]);
  });
});
