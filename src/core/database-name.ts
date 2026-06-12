import { createHash } from "node:crypto";
import { Effect } from "effect";
import { UnsafeDatabaseNameError } from "../errors/errors.js";

export const DB_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const MAX_DB_NAME_LENGTH = 63;
/**
 * Derived names are capped below PostgreSQL's 63 so the 5-char `__tpl`
 * template suffix still fits. Explicit env overrides keep the full 63 budget
 * (template snapshots are skipped for names longer than this — see
 * decideResetPath in core/environment.ts).
 */
const DERIVED_NAME_BUDGET = 58;

/** Default leading branch type segments dropped (once) before deriving a name. */
export const DEFAULT_STRIP_BRANCH_PREFIXES: ReadonlyArray<string> = [
  "feature",
  "feat",
  "bugfix",
  "bug",
  "hotfix",
  "fix",
  "chore",
  "task",
];

export const sanitizeNamePart = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const sha8 = (input: string): string =>
  createHash("sha256").update(input).digest("hex").slice(0, 8);

const truncate = (name: string): string =>
  name.length <= DERIVED_NAME_BUDGET ? name : `${name.slice(0, 49)}_${sha8(name)}`;

const assertSafeDatabaseName = (name: string): Effect.Effect<string, UnsafeDatabaseNameError> =>
  name.length === 0 || name.length > MAX_DB_NAME_LENGTH || !DB_NAME_PATTERN.test(name)
    ? Effect.fail(new UnsafeDatabaseNameError({ name }))
    : Effect.succeed(name);

export const deriveDatabaseName = (options: {
  readonly branch: string | undefined;
  readonly worktreeName: string;
  readonly dbPrefix: string;
  readonly sharedDatabase: string | null;
  readonly sharedBranches: ReadonlyArray<string>;
  readonly stripBranchPrefixes: ReadonlyArray<string>;
  readonly envDatabase: string | undefined;
}): Effect.Effect<string, UnsafeDatabaseNameError> => {
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
  // strip AT MOST one leading type segment — the bash `case feature/*|fix/*)`
  // this reproduces matches a single prefix, so feature/fix/x keeps "fix"
  const prefixes = options.stripBranchPrefixes.map((prefix) => prefix.toLowerCase());
  if (segments.length > 1 && prefixes.includes(segments[0]!.toLowerCase())) segments.shift();
  let body = sanitizeNamePart(segments.join("/"));
  if (body.length === 0) body = sanitizeNamePart(options.worktreeName);
  // bash parity: a name that sanitizes to nothing becomes "worktree", never "<prefix>_"
  if (body.length === 0) body = "worktree";

  const prefixed =
    body === options.dbPrefix || body.startsWith(`${options.dbPrefix}_`)
      ? body
      : `${options.dbPrefix}_${body}`;

  return assertSafeDatabaseName(truncate(prefixed));
};
