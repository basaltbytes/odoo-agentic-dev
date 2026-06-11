import { Data } from "effect"

export class ConfigLoadError extends Data.TaggedError("ConfigLoadError")<{
  readonly path: string
  readonly reason: string
}> {}

export class ConfigValidationError extends Data.TaggedError("ConfigValidationError")<{
  readonly issues: ReadonlyArray<string>
}> {
  // v4 beta TaggedError leaves Error#message empty; expose the issues there so
  // standard tooling (and assertions on the thrown message) see the details.
  override get message(): string {
    return this.issues.join("; ")
  }
}

export class GitError extends Data.TaggedError("GitError")<{
  readonly reason: string
}> {}

export class UnsafeDatabaseNameError extends Data.TaggedError("UnsafeDatabaseNameError")<{
  readonly name: string
}> {}

export class SharedDatabaseProtectionError extends Data.TaggedError("SharedDatabaseProtectionError")<{
  readonly database: string
  /** the command the user attempted, e.g. "reset-db" */
  readonly action: string
}> {}

export class DockerUnavailableError extends Data.TaggedError("DockerUnavailableError")<{
  readonly reason: string
}> {}

export class CommandFailedError extends Data.TaggedError("CommandFailedError")<{
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string | undefined
  readonly exitCode: number
  readonly stderrTail: string
}> {}

export class ComposeCommandError extends Data.TaggedError("ComposeCommandError")<{
  readonly args: ReadonlyArray<string>
  readonly exitCode: number
  readonly stderrTail: string
}> {}

export class OdooCommandError extends Data.TaggedError("OdooCommandError")<{
  readonly args: ReadonlyArray<string>
  readonly exitCode: number
  readonly stderrTail: string
}> {}

export class CompanionProcessError extends Data.TaggedError("CompanionProcessError")<{
  readonly name: string
  readonly exitCode: number
}> {}

export class SourceResolverError extends Data.TaggedError("SourceResolverError")<{
  readonly reason: string
}> {}

export type RuntimeError =
  | ConfigLoadError
  | ConfigValidationError
  | GitError
  | UnsafeDatabaseNameError
  | SharedDatabaseProtectionError
  | DockerUnavailableError
  | CommandFailedError
  | ComposeCommandError
  | OdooCommandError
  | CompanionProcessError
  | SourceResolverError

const RUNTIME_ERROR_TAGS: ReadonlySet<string> = new Set([
  "ConfigLoadError", "ConfigValidationError", "GitError", "UnsafeDatabaseNameError",
  "SharedDatabaseProtectionError", "DockerUnavailableError", "CommandFailedError",
  "ComposeCommandError", "OdooCommandError", "CompanionProcessError", "SourceResolverError"
])

export const isRuntimeError = (u: unknown): u is RuntimeError =>
  typeof u === "object" && u !== null && "_tag" in u &&
  RUNTIME_ERROR_TAGS.has((u as { _tag: string })._tag)

const lines = (...xs: ReadonlyArray<string>): string => xs.join("\n")

export const renderError = (error: RuntimeError): string => {
  switch (error._tag) {
    case "ConfigLoadError":
      return lines(
        `Could not load config: ${error.path}`,
        `Reason: ${error.reason}`,
        `Next: check the file exists and its default export is defineOdooAgenticDevConfig({...}).`
      )
    case "ConfigValidationError":
      return lines(
        "Invalid odoo-agentic-dev config:",
        ...error.issues.map((issue) => `  - ${issue}`),
        "Next: fix the config file and re-run."
      )
    case "GitError":
      return lines(`Git inspection failed: ${error.reason}`, "Next: run the command inside the project worktree.")
    case "UnsafeDatabaseNameError":
      return lines(
        `Refusing unsafe database name: "${error.name}"`,
        "Database names must match ^[a-z][a-z0-9_]*$ and be at most 63 characters.",
        "Next: rename the branch or set ODOO_DATABASE to a safe name."
      )
    case "SharedDatabaseProtectionError":
      return lines(
        `Refusing to touch the shared database "${error.database}".`,
        `Next: re-run \`odoo-agentic-dev ${error.action} --allow-shared\` if you really mean it.`
      )
    case "DockerUnavailableError":
      return lines(`Docker is not available: ${error.reason}`, "Next: start Docker Desktop / the docker daemon and retry.")
    case "CommandFailedError":
      return lines(
        `Command failed (exit ${error.exitCode}): ${[error.command, ...error.args].join(" ")}`,
        `Working directory: ${error.cwd ?? process.cwd()}`,
        error.stderrTail.length > 0 ? `stderr (tail):\n${error.stderrTail}` : "stderr: (empty)",
        "Next: re-run the command above manually to investigate."
      )
    case "ComposeCommandError":
      return lines(
        `docker compose failed (exit ${error.exitCode}): docker ${error.args.join(" ")}`,
        error.stderrTail.length > 0 ? `stderr (tail):\n${error.stderrTail}` : "stderr: (empty)",
        "Next: check container logs with `odoo-agentic-dev up --logs`."
      )
    case "OdooCommandError":
      return lines(
        `Odoo command failed (exit ${error.exitCode}): docker ${error.args.join(" ")}`,
        error.stderrTail.length > 0 ? `output (tail):\n${error.stderrTail}` : "output: (empty)",
        "Next: inspect the Odoo log output above."
      )
    case "CompanionProcessError":
      return lines(`Companion app "${error.name}" exited with code ${error.exitCode}.`, "Next: check its logs above; other processes were stopped.")
    case "SourceResolverError":
      return lines(`Could not resolve Odoo source: ${error.reason}`, "Next: pass --target <path> or set odoo.source in the config.")
  }
}

/** Keep only the last `maxLines` lines of process output for error messages. */
export const tail = (text: string, maxLines = 20): string =>
  text.split(/\r?\n/).filter((l) => l.length > 0).slice(-maxLines).join("\n")
