import { existsSync, lstatSync, symlinkSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { SourceResolverError } from "../errors/errors.js";
import { resolveContext } from "./resolve-context.js";

const tryFs = <A>(thunk: () => A): Effect.Effect<A, SourceResolverError> =>
  Effect.try({ try: thunk, catch: (cause) => new SourceResolverError({ reason: String(cause) }) });

export const performLinkSource = (options: {
  readonly rootDir: string;
  readonly target: string | undefined;
  readonly name: string;
  readonly force: boolean;
  readonly recipeSource: string | null;
}): Effect.Effect<string, SourceResolverError> =>
  Effect.gen(function* () {
    const configured =
      options.target ??
      (options.recipeSource === "docker-only" ? undefined : (options.recipeSource ?? undefined));
    const sibling = resolve(options.rootDir, "../odoo");
    const resolved =
      configured !== undefined
        ? isAbsolute(configured)
          ? configured
          : resolve(options.rootDir, configured)
        : (yield* Effect.sync(() => existsSync(sibling)))
          ? sibling
          : undefined;

    if (resolved === undefined || !(yield* Effect.sync(() => existsSync(resolved)))) {
      return yield* Effect.fail(
        new SourceResolverError({
          reason:
            resolved === undefined
              ? "no --target given, no odoo.source configured, and no ../odoo sibling checkout found"
              : `resolved source path does not exist: ${resolved}`,
        }),
      );
    }

    const linkPath = join(options.rootDir, options.name);
    const existing = yield* Effect.sync(() => {
      try {
        return lstatSync(linkPath);
      } catch {
        return undefined;
      }
    });
    if (existing !== undefined) {
      if (!existing.isSymbolicLink()) {
        return yield* Effect.fail(
          new SourceResolverError({
            reason: `${linkPath} exists and is not a symlink; refusing to overwrite`,
          }),
        );
      }
      if (!options.force) {
        return yield* Effect.fail(
          new SourceResolverError({
            reason: `${linkPath} already exists; pass --force to replace it`,
          }),
        );
      }
      yield* tryFs(() => unlinkSync(linkPath));
    }
    yield* tryFs(() => symlinkSync(resolved, linkPath));
    return linkPath;
  });

export const linkSourceCommand = Command.make(
  "link-source",
  {
    target: Flag.string("target").pipe(Flag.optional),
    name: Flag.string("name").pipe(Flag.withDefault(".odoo")),
    force: Flag.boolean("force"),
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    Effect.gen(function* () {
      const { ctx, recipe } = yield* resolveContext(flags.config);
      const linkPath = yield* performLinkSource({
        rootDir: ctx.rootDir,
        target: Option.getOrUndefined(flags.target),
        name: flags.name,
        force: flags.force,
        recipeSource: recipe.odoo.source,
      });
      yield* Console.log(`Linked ${linkPath} -> resolved Odoo source`);
    }),
);
