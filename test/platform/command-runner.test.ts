// test/platform/command-runner.test.ts
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { NodeServices } from "@effect/platform-node";
import { CommandRunner, CommandRunnerLive } from "../../src/platform/command-runner.js";
import { makeRecordingRunner } from "../../src/testing/fake-adapters.js";
import { runWith } from "../helpers.js";

const runLive = runWith(Layer.provide(CommandRunnerLive, NodeServices.layer));

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

  it("runInteractive inherits stdio and resolves with the child's exit code", async () => {
    // full stdio inheritance must work headless (vitest pipes, no TTY)
    const exitCode = await runLive(
      Effect.gen(function* () {
        const runner = yield* CommandRunner;
        return yield* runner.runInteractive({ command: "node", args: ["-e", "process.exit(7)"] });
      }),
    );
    expect(exitCode).toBe(7);
  });

  it("runInherited streams output and returns a bounded output tail with the exit code", async () => {
    const result = await runLive(
      Effect.gen(function* () {
        const runner = yield* CommandRunner;
        return yield* runner.runInherited({
          command: "node",
          args: ["-e", "console.log('visible out'); console.error('visible err'); process.exit(5)"],
        });
      }),
    );
    expect(result.exitCode).toBe(5);
    expect(result.outputTail).toContain("visible out");
    expect(result.outputTail).toContain("visible err");
  });

  it("runInteractive fails typed when the binary cannot be spawned", async () => {
    await expect(
      runLive(
        Effect.gen(function* () {
          const runner = yield* CommandRunner;
          return yield* runner.runInteractive({
            command: "definitely-not-a-real-binary-oad",
            args: [],
          });
        }),
      ),
    ).rejects.toThrow(/definitely-not-a-real-binary-oad/);
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

  it("returns a tail from scripted inherited runs", async () => {
    const recording = makeRecordingRunner(() => ({
      exitCode: 9,
      stdout: "",
      stderr: "important failure",
    }));
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* CommandRunner;
        return yield* runner.runInherited({ command: "docker", args: ["compose", "up"] });
      }).pipe(Effect.provide(recording.layer)),
    );
    expect(result).toEqual({ exitCode: 9, outputTail: "important failure" });
  });
});
