import { existsSync, lstatSync, symlinkSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { SourceResolverError } from "../errors/errors.js";
import type { RuntimeError } from "../errors/errors.js";
import { resolveContext } from "./resolve-context.js";

export const performLinkSource = (options: {
  readonly rootDir: string;
  readonly target: string | undefined;
  readonly name: string;
  readonly force: boolean;
  readonly recipeSource: string | null;
}): string => {
  const configured =
    options.target ??
    (options.recipeSource === "docker-only" ? undefined : (options.recipeSource ?? undefined));
  const sibling = resolve(options.rootDir, "../odoo");
  const resolved =
    configured !== undefined
      ? isAbsolute(configured)
        ? configured
        : resolve(options.rootDir, configured)
      : existsSync(sibling)
        ? sibling
        : undefined;

  if (resolved === undefined || !existsSync(resolved)) {
    throw new SourceResolverError({
      reason:
        resolved === undefined
          ? "no --target given, no odoo.source configured, and no ../odoo sibling checkout found"
          : `resolved source path does not exist: ${resolved}`,
    });
  }

  const linkPath = join(options.rootDir, options.name);
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(linkPath);
  } catch {
    existing = undefined;
  }
  if (existing !== undefined) {
    if (!existing.isSymbolicLink()) {
      throw new SourceResolverError({
        reason: `${linkPath} exists and is not a symlink; refusing to overwrite`,
      });
    }
    if (!options.force) {
      throw new SourceResolverError({
        reason: `${linkPath} already exists; pass --force to replace it`,
      });
    }
    unlinkSync(linkPath);
  }
  symlinkSync(resolved, linkPath);
  return linkPath;
};

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
      const linkPath = yield* Effect.try({
        try: () =>
          performLinkSource({
            rootDir: ctx.rootDir,
            target: Option.getOrUndefined(flags.target),
            name: flags.name,
            force: flags.force,
            recipeSource: recipe.odoo.source,
          }),
        catch: (e) => e as RuntimeError,
      });
      yield* Console.log(`Linked ${linkPath} -> resolved Odoo source`);
    }),
);
