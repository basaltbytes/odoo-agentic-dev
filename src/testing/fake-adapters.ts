import { Effect, Layer } from "effect"
import { CommandRunner } from "../platform/command-runner.js"
import type { CommandRunnerApi, ExecResult, ExecSpec } from "../platform/command-runner.js"

/**
 * CommandRunner fake: records every call; `script` may return a result per
 * spec (default: exit 0, empty output).
 */
export const makeRecordingRunner = (
  script?: (spec: ExecSpec) => ExecResult | undefined
): { readonly calls: Array<ExecSpec>; readonly layer: Layer.Layer<CommandRunnerApi> } => {
  const calls: Array<ExecSpec> = []
  const respond = (spec: ExecSpec): ExecResult => {
    calls.push(spec)
    return script?.(spec) ?? { exitCode: 0, stdout: "", stderr: "" }
  }
  return {
    calls,
    layer: Layer.succeed(CommandRunner, {
      run: (spec) => Effect.sync(() => respond(spec)),
      runInherited: (spec) => Effect.sync(() => respond(spec).exitCode)
    })
  }
}

// makeFakeGit is added in Task 10 alongside the Git service it fakes.
