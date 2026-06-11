import { createHash } from "node:crypto";
import { UnsafeDatabaseNameError } from "../errors/errors.js";

export const DB_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
export const MAX_DB_NAME_LENGTH = 63;

/** Leading branch path segments dropped before deriving a name. */
const TYPE_SEGMENTS = new Set([
  "feature",
  "feat",
  "bugfix",
  "bug",
  "hotfix",
  "fix",
  "chore",
  "task",
]);

export const sanitizeNamePart = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const sha8 = (input: string): string =>
  createHash("sha256").update(input).digest("hex").slice(0, 8);

const truncate = (name: string): string =>
  name.length <= MAX_DB_NAME_LENGTH ? name : `${name.slice(0, 54)}_${sha8(name)}`;

export const assertSafeDatabaseName = (name: string): string => {
  if (name.length === 0 || name.length > MAX_DB_NAME_LENGTH || !DB_NAME_PATTERN.test(name)) {
    throw new UnsafeDatabaseNameError({ name });
  }
  return name;
};

export const deriveDatabaseName = (options: {
  readonly branch: string | undefined;
  readonly worktreeName: string;
  readonly dbPrefix: string;
  readonly sharedDatabase: string | null;
  readonly sharedBranches: ReadonlyArray<string>;
  readonly envDatabase: string | undefined;
}): string => {
  if (options.envDatabase !== undefined) return assertSafeDatabaseName(options.envDatabase);

  if (
    options.branch !== undefined &&
    options.sharedDatabase !== null &&
    options.sharedBranches.includes(options.branch)
  ) {
    return assertSafeDatabaseName(options.sharedDatabase);
  }

  const seed = options.branch ?? options.worktreeName;
  const segments = seed.split("/");
  while (segments.length > 1 && TYPE_SEGMENTS.has(segments[0]!.toLowerCase())) segments.shift();
  let body = sanitizeNamePart(segments.join("/"));
  if (body.length === 0) body = sanitizeNamePart(options.worktreeName);

  const prefixed =
    body === options.dbPrefix || body.startsWith(`${options.dbPrefix}_`)
      ? body
      : `${options.dbPrefix}_${body}`;

  return assertSafeDatabaseName(truncate(prefixed));
};
