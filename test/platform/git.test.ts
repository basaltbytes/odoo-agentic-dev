// test/platform/git.test.ts
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { Git, GitLive } from "../../src/platform/git.js";
import { makeRecordingRunner } from "../../src/testing/fake-adapters.js";
import { runWith } from "../helpers.js";

const state = (script: Parameters<typeof makeRecordingRunner>[0]) => {
  const recording = makeRecordingRunner(script);
  return {
    recording,
    run: runWith(Layer.provide(GitLive, recording.layer))(
      Effect.gen(function* () {
        const git = yield* Git;
        return yield* git.state("/work/repo");
      }),
    ),
  };
};

describe("GitLive.state", () => {
  it("returns Branch for a normal checkout", async () => {
    const { recording, run } = state(() => ({
      exitCode: 0,
      stdout: "feature/KL-123-payment-flow\n",
      stderr: "",
    }));
    expect(await run).toEqual({ _tag: "Branch", branch: "feature/KL-123-payment-flow" });
    expect(recording.calls[0]).toMatchObject({
      command: "git",
      args: ["rev-parse", "--abbrev-ref", "HEAD"],
      cwd: "/work/repo",
    });
  });

  it("returns Detached when HEAD is not on a branch", async () => {
    const { run } = state(() => ({ exitCode: 0, stdout: "HEAD\n", stderr: "" }));
    expect(await run).toEqual({ _tag: "Detached" });
  });

  it("returns NotARepo on the dedicated git error", async () => {
    const { run } = state(() => ({
      exitCode: 128,
      stdout: "",
      stderr: "fatal: not a git repository",
    }));
    expect(await run).toEqual({ _tag: "NotARepo" });
  });

  it("fails with GitError on other failures", async () => {
    const { run } = state(() => ({ exitCode: 1, stdout: "", stderr: "fatal: weird" }));
    await expect(run).rejects.toThrow(/weird/);
  });
});
