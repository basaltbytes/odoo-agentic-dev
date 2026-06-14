import { Data } from "effect";

export class ConfigLoadError extends Data.TaggedError("ConfigLoadError")<{
  readonly path: string;
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

export class ConfigValidationError extends Data.TaggedError("ConfigValidationError")<{
  readonly issues: ReadonlyArray<string>;
}> {
  // v4 beta TaggedError leaves Error#message empty; expose the issues there so
  // standard tooling (and assertions on the thrown message) see the details.
  override get message(): string {
    return this.issues.join("; ");
  }
}

export class UsageError extends Data.TaggedError("UsageError")<{
  readonly issues: ReadonlyArray<string>;
}> {
  override get message(): string {
    return this.issues.join("; ");
  }
}

export class GitError extends Data.TaggedError("GitError")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

export class UnsafeDatabaseNameError extends Data.TaggedError("UnsafeDatabaseNameError")<{
  readonly name: string;
}> {
  override get message(): string {
    return `unsafe database name: "${this.name}"`;
  }
}

export class SharedDatabaseProtectionError extends Data.TaggedError(
  "SharedDatabaseProtectionError",
)<{
  readonly database: string;
  /** the command the user attempted, e.g. "reset-db" */
  readonly action: string;
}> {
  override get message(): string {
    return `refusing to touch shared database "${this.database}" (re-run ${this.action} with --allow-shared)`;
  }
}

export class DockerUnavailableError extends Data.TaggedError("DockerUnavailableError")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

export class CommandFailedError extends Data.TaggedError("CommandFailedError")<{
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly exitCode: number;
  readonly stderrTail: string;
}> {
  override get message(): string {
    return `${this.command} ${this.args.join(" ")} exited ${this.exitCode}: ${this.stderrTail}`;
  }
}

export class ComposeCommandError extends Data.TaggedError("ComposeCommandError")<{
  readonly args: ReadonlyArray<string>;
  readonly exitCode: number;
  readonly stderrTail: string;
}> {
  override get message(): string {
    return `docker ${this.args.join(" ")} exited ${this.exitCode}: ${this.stderrTail}`;
  }
}

export class OdooCommandError extends Data.TaggedError("OdooCommandError")<{
  readonly args: ReadonlyArray<string>;
  readonly exitCode: number;
  readonly stderrTail: string;
}> {
  override get message(): string {
    return `docker ${this.args.join(" ")} exited ${this.exitCode}: ${this.stderrTail}`;
  }
}

export class CompanionProcessError extends Data.TaggedError("CompanionProcessError")<{
  readonly name: string;
  readonly exitCode: number;
}> {
  override get message(): string {
    return `companion "${this.name}" exited ${this.exitCode}`;
  }
}

export class SourceResolverError extends Data.TaggedError("SourceResolverError")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

export class StateError extends Data.TaggedError("StateError")<{
  readonly reason: string;
  readonly path?: string | undefined;
  readonly parentDir?: string | undefined;
  readonly parentExists?: boolean | undefined;
  readonly parentWritable?: boolean | undefined;
}> {
  override get message(): string {
    return this.reason;
  }
}

export class PortConflictError extends Data.TaggedError("PortConflictError")<{
  readonly port: number;
  /** compose project holding the port, when the state registry knows it */
  readonly holder: string | null;
}> {
  override get message(): string {
    return this.holder === null
      ? `port ${this.port} is already in use`
      : `port ${this.port} is already in use by "${this.holder}"`;
  }
}

export class EjectError extends Data.TaggedError("EjectError")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

export class InitError extends Data.TaggedError("InitError")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

export type RuntimeError =
  | ConfigLoadError
  | ConfigValidationError
  | UsageError
  | GitError
  | UnsafeDatabaseNameError
  | SharedDatabaseProtectionError
  | DockerUnavailableError
  | CommandFailedError
  | ComposeCommandError
  | OdooCommandError
  | CompanionProcessError
  | SourceResolverError
  | StateError
  | PortConflictError
  | EjectError
  | InitError;

const RUNTIME_ERROR_TAGS: ReadonlySet<string> = new Set([
  "ConfigLoadError",
  "ConfigValidationError",
  "UsageError",
  "GitError",
  "UnsafeDatabaseNameError",
  "SharedDatabaseProtectionError",
  "DockerUnavailableError",
  "CommandFailedError",
  "ComposeCommandError",
  "OdooCommandError",
  "CompanionProcessError",
  "SourceResolverError",
  "StateError",
  "PortConflictError",
  "EjectError",
  "InitError",
]);

export const isRuntimeError = (u: unknown): u is RuntimeError =>
  typeof u === "object" &&
  u !== null &&
  "_tag" in u &&
  RUNTIME_ERROR_TAGS.has((u as { _tag: string })._tag);

const lines = (...xs: ReadonlyArray<string>): string => xs.join("\n");

const composeProjectFromArgs = (args: ReadonlyArray<string>): string | null => {
  const projectFlag = args.indexOf("-p");
  const project = projectFlag === -1 ? undefined : args[projectFlag + 1];
  return project === undefined || project.length === 0 ? null : project;
};

const composeDebugLine = (args: ReadonlyArray<string>): string => {
  const project = composeProjectFromArgs(args);
  return project === null
    ? "Next: re-run the docker compose command above, or inspect the generated compose file."
    : `Next: inspect with \`odoo-agentic-dev compose -- ps\` or \`docker compose -p ${project} ps\`.`;
};

export const renderError = (error: RuntimeError): string => {
  switch (error._tag) {
    case "ConfigLoadError":
      return lines(
        `Could not load config: ${error.path}`,
        `Reason: ${error.reason}`,
        `Next: check the file exists and its default export is defineConfig({...}).`,
      );
    case "ConfigValidationError":
      return lines(
        "Invalid odoo-agentic-dev config:",
        ...error.issues.map((issue) => `  - ${issue}`),
        "Next: fix the config file and re-run.",
      );
    case "UsageError":
      return lines(
        "Invalid odoo-agentic-dev command usage:",
        ...error.issues.map((issue) => `  - ${issue}`),
        "Next: fix the command flags or arguments and re-run.",
      );
    case "GitError":
      return lines(
        `Git inspection failed: ${error.reason}`,
        "Next: run the command inside the project worktree.",
      );
    case "UnsafeDatabaseNameError":
      return lines(
        `Refusing unsafe database name: "${error.name}"`,
        "Database names must match ^[a-z][a-z0-9_]*$ and be at most 63 characters.",
        "Next: rename the branch or set ODOO_DATABASE to a safe name.",
      );
    case "SharedDatabaseProtectionError":
      return lines(
        `Refusing to touch the shared database "${error.database}".`,
        `Next: re-run \`odoo-agentic-dev ${error.action} --allow-shared\` if you really mean it.`,
      );
    case "DockerUnavailableError":
      return lines(
        `Docker is not available: ${error.reason}`,
        "Next: start Docker Desktop / the docker daemon and retry.",
      );
    case "CommandFailedError":
      return lines(
        `Command failed (exit ${error.exitCode}): ${[error.command, ...error.args].join(" ")}`,
        `Working directory: ${error.cwd ?? process.cwd()}`,
        error.stderrTail.length > 0 ? `output (tail):\n${error.stderrTail}` : "output: (empty)",
        "Next: re-run the command above manually to investigate.",
      );
    case "ComposeCommandError":
      return lines(
        `docker compose failed (exit ${error.exitCode}): docker ${error.args.join(" ")}`,
        ...(composeProjectFromArgs(error.args) === null
          ? []
          : [`Compose project: ${composeProjectFromArgs(error.args)}`]),
        error.stderrTail.length > 0 ? `stderr (tail):\n${error.stderrTail}` : "stderr: (empty)",
        composeDebugLine(error.args),
      );
    case "OdooCommandError":
      return lines(
        `Odoo command failed (exit ${error.exitCode}): docker ${error.args.join(" ")}`,
        ...(composeProjectFromArgs(error.args) === null
          ? []
          : [`Compose project: ${composeProjectFromArgs(error.args)}`]),
        error.stderrTail.length > 0 ? `output (tail):\n${error.stderrTail}` : "output: (empty)",
        "Next: inspect the Odoo log output above.",
      );
    case "CompanionProcessError":
      return lines(
        `Companion app "${error.name}" exited with code ${error.exitCode}.`,
        "Next: check its logs above; other processes were stopped.",
      );
    case "SourceResolverError":
      return lines(
        `Could not resolve Odoo source: ${error.reason}`,
        "Next: pass --target <path> or set odoo.source in the config.",
      );
    case "StateError":
      if (error.path !== undefined) {
        return lines(
          `State registry error: ${error.reason}`,
          `State DB: ${error.path}`,
          `Parent directory: ${error.parentDir ?? "(unknown)"} (${
            error.parentExists === undefined
              ? "existence unknown"
              : error.parentExists
                ? "exists"
                : "missing"
          }, ${
            error.parentWritable === undefined
              ? "writability unknown"
              : error.parentWritable
                ? "writable"
                : "not writable"
          })`,
          "Next: set ODOO_AGENTIC_DEV_STATE_DB to a writable path, or make the parent directory writable.",
        );
      }
      return lines(
        `State registry error: ${error.reason}`,
        "Next: check the state database file, or set ODOO_AGENTIC_DEV_STATE_DB to a writable path.",
      );
    case "PortConflictError":
      return lines(
        error.holder === null
          ? `Port ${error.port} is already in use by another process.`
          : `Port ${error.port} is already in use by the "${error.holder}" stack.`,
        "Next: set ODOO_HTTP_PORT to a free port, or run `odoo-agentic-dev prune` to",
        "clean up environments you no longer need.",
      );
    case "EjectError":
      return lines(`Eject failed: ${error.reason}`);
    case "InitError":
      return lines(`Init failed: ${error.reason}`);
  }
};

/** Keep only the last `maxLines` lines of process output for error messages. */
export const tail = (text: string, maxLines = 20): string =>
  text
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .slice(-maxLines)
    .join("\n");
