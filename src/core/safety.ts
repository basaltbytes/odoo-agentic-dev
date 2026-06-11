import { ConfigValidationError, SharedDatabaseProtectionError } from "../errors/errors.js";

const COMPOSE_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export const isSharedDatabase = (databaseName: string, sharedDatabase: string | null): boolean =>
  sharedDatabase !== null && databaseName === sharedDatabase;

export const assertSharedDatabaseAllowed = (options: {
  readonly databaseName: string;
  readonly sharedDatabase: string | null;
  readonly allowShared: boolean;
  /** command name for the error message, e.g. "reset-db" */
  readonly action: string;
}): void => {
  if (isSharedDatabase(options.databaseName, options.sharedDatabase) && !options.allowShared) {
    throw new SharedDatabaseProtectionError({
      database: options.databaseName,
      action: options.action,
    });
  }
};

export const assertComposeProjectName = (name: string): string => {
  if (!COMPOSE_PROJECT_PATTERN.test(name)) {
    throw new ConfigValidationError({
      issues: [`compose project name "${name}" is empty or unsafe`],
    });
  }
  return name;
};
