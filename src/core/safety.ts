import { Effect } from "effect";
import { ConfigValidationError, SharedDatabaseProtectionError } from "../errors/errors.js";

const COMPOSE_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export const isSharedDatabase = (databaseName: string, sharedDatabase: string | null): boolean =>
  sharedDatabase !== null && databaseName === sharedDatabase;

export const assertSharedDatabaseAllowed = (options: {
  readonly databaseName: string;
  readonly sharedDatabase: string | null;
  readonly allowShared: boolean;
  /** false permits first creation of a configured shared database */
  readonly databaseExists?: boolean | undefined;
  /** command name for the error message, e.g. "reset-db" */
  readonly action: string;
}): Effect.Effect<void, SharedDatabaseProtectionError> =>
  isSharedDatabase(options.databaseName, options.sharedDatabase) &&
  !options.allowShared &&
  options.databaseExists !== false
    ? Effect.fail(
        new SharedDatabaseProtectionError({
          database: options.databaseName,
          action: options.action,
        }),
      )
    : Effect.void;

export const assertComposeProjectName = (
  name: string,
): Effect.Effect<string, ConfigValidationError> =>
  COMPOSE_PROJECT_PATTERN.test(name)
    ? Effect.succeed(name)
    : Effect.fail(
        new ConfigValidationError({
          issues: [`compose project name "${name}" is empty or unsafe`],
        }),
      );
