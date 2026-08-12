import { existsSync, lstatSync, realpathSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { SourceResolverError } from "../errors/errors.js";
import { CommandRunner } from "../platform/command-runner.js";
import type { CommandRunnerApi } from "../platform/command-runner.js";
import { withJsonReport } from "./json-report.js";
import { resolveContext } from "./resolve-context.js";

const tryFs = <A>(thunk: () => A): Effect.Effect<A, SourceResolverError> =>
  Effect.try({ try: thunk, catch: (cause) => new SourceResolverError({ reason: String(cause) }) });

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The legacy script's test: an Odoo source checkout has odoo-bin, odoo/ and addons/. */
export const looksLikeOdooCheckout = (path: string): boolean =>
  existsSync(join(path, "odoo-bin")) &&
  isDirectory(join(path, "odoo")) &&
  isDirectory(join(path, "addons"));

/** Extract the worktree paths from `git worktree list --porcelain` output. */
export const parseWorktreePorcelain = (stdout: string): Array<string> => {
  const paths: Array<string> = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length).trim());
  }
  return paths;
};

/**
 * Candidate discovery when nothing is configured: `<root>/../odoo` first,
 * then `<dirname(worktree)>/odoo` for every git worktree of the project (a
 * checkout cloned next to any worktree is found from all of them). The first
 * candidate that LOOKS like an Odoo checkout wins; the full candidate list is
 * returned for the error message. Git failure (not a repo) is not fatal —
 * only the sibling candidate is checked then.
 */
export const discoverOdooCheckout = (
  rootDir: string,
): Effect.Effect<
  { readonly resolved: string | undefined; readonly candidates: Array<string> },
  never,
  CommandRunnerApi
> =>
  Effect.gen(function* () {
    const runner = yield* CommandRunner;
    const result = yield* runner
      .run({ command: "git", args: ["worktree", "list", "--porcelain"], cwd: rootDir })
      .pipe(Effect.catch(() => Effect.succeed({ exitCode: -1, stdout: "", stderr: "" })));
    const worktrees = result.exitCode === 0 ? parseWorktreePorcelain(result.stdout) : [];
    const candidates: Array<string> = [];
    for (const candidate of [
      resolve(rootDir, "..", "odoo"),
      ...worktrees.map((worktree) => join(dirname(worktree), "odoo")),
    ]) {
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
    return { resolved: candidates.find(looksLikeOdooCheckout), candidates };
  });

export type LinkSourceResult = {
  readonly linkPath: string;
  readonly source: string;
  readonly changed: boolean;
};

export const performLinkSource = (options: {
  readonly rootDir: string;
  readonly target: string | undefined;
  readonly name: string;
  readonly force: boolean;
  readonly recipeSource: string | null;
}): Effect.Effect<LinkSourceResult, SourceResolverError, CommandRunnerApi> =>
  Effect.gen(function* () {
    // explicit wins and skips validation: --target, then odoo.source
    const configured =
      options.target ??
      (options.recipeSource === "docker-only" ? undefined : (options.recipeSource ?? undefined));

    let resolved: string;
    if (configured !== undefined) {
      resolved = isAbsolute(configured) ? configured : resolve(options.rootDir, configured);
      if (!existsSync(resolved)) {
        return yield* Effect.fail(
          new SourceResolverError({ reason: `resolved source path does not exist: ${resolved}` }),
        );
      }
    } else {
      const discovery = yield* discoverOdooCheckout(options.rootDir);
      if (discovery.resolved === undefined) {
        return yield* Effect.fail(
          new SourceResolverError({
            reason:
              "no --target given and no odoo.source configured; no Odoo checkout found at: " +
              discovery.candidates.join(", ") +
              " (a valid checkout contains odoo-bin, odoo/ and addons/)",
          }),
        );
      }
      resolved = discovery.resolved;
    }

    const linkPath = join(options.rootDir, options.name);
    let existing: Stats | undefined;
    try {
      existing = lstatSync(linkPath);
    } catch {
      existing = undefined;
    }
    if (existing !== undefined) {
      if (!existing.isSymbolicLink()) {
        return yield* Effect.fail(
          new SourceResolverError({
            reason: `${linkPath} exists and is not a symlink; refusing to overwrite`,
          }),
        );
      }
      if (!options.force) {
        const alreadyLinked = (() => {
          try {
            const actualSource = realpathSync(linkPath);
            return actualSource === realpathSync(resolved) && looksLikeOdooCheckout(actualSource);
          } catch {
            return false;
          }
        })();
        if (alreadyLinked) return { linkPath, source: resolved, changed: false };
        return yield* Effect.fail(
          new SourceResolverError({
            reason: `${linkPath} already exists; pass --force to replace it`,
          }),
        );
      }
      yield* tryFs(() => unlinkSync(linkPath));
    }
    yield* tryFs(() => symlinkSync(resolved, linkPath));
    return { linkPath, source: resolved, changed: true };
  });

export const linkSourceCommand = Command.make(
  "link-source",
  {
    target: Flag.string("target").pipe(Flag.optional),
    name: Flag.string("name").pipe(Flag.withDefault(".odoo")),
    force: Flag.boolean("force"),
    json: Flag.boolean("json").pipe(Flag.withDescription("print machine-readable JSON")),
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    withJsonReport("link-source", flags.json, (report) =>
      Effect.gen(function* () {
        const { ctx, recipe } = yield* resolveContext(flags.config);
        yield* report.setContext(ctx);
        const result = yield* performLinkSource({
          rootDir: ctx.rootDir,
          target: Option.getOrUndefined(flags.target),
          name: flags.name,
          force: flags.force,
          recipeSource: recipe.odoo.source,
        });
        yield* report.setExtra("changed", result.changed);
        yield* report.setExtra("source", result.source);
        yield* report.setExtra("linkPath", result.linkPath);
        yield* report.say(
          result.changed
            ? `Linked ${result.linkPath} -> ${result.source}`
            : `${result.linkPath} already points to ${result.source}; no change required.`,
        );
      }),
    ),
).pipe(Command.withDescription("symlink a local Odoo checkout for editor navigation"));
