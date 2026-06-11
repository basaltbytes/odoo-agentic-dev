import { Context, Effect, Layer } from "effect"
import { GitError } from "../errors/errors.js"
import type { GitState } from "../core/worktree-context.js"
import { CommandRunner } from "./command-runner.js"

export interface GitApi {
  readonly state: (rootDir: string) => Effect.Effect<GitState, GitError>
}

export const Git = Context.Service<GitApi>("odoo-agentic-dev/Git")

export const GitLive = Layer.effect(
  Git,
  Effect.gen(function* () {
    const runner = yield* CommandRunner
    return {
      state: (rootDir: string) =>
        runner.run({ command: "git", args: ["rev-parse", "--abbrev-ref", "HEAD"], cwd: rootDir }).pipe(
          Effect.mapError((e) => new GitError({ reason: e.stderrTail || String(e) })),
          Effect.flatMap((result): Effect.Effect<GitState, GitError> => {
            if (result.exitCode === 0) {
              const branch = result.stdout.trim()
              return Effect.succeed(branch === "HEAD" ? { _tag: "Detached" } : { _tag: "Branch", branch })
            }
            if (result.stderr.includes("not a git repository")) {
              return Effect.succeed({ _tag: "NotARepo" })
            }
            return Effect.fail(new GitError({ reason: result.stderr.trim() || `git exited ${result.exitCode}` }))
          })
        )
    }
  })
)
