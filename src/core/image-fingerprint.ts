import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import { Effect } from "effect";
import { ConfigLoadError } from "../errors/errors.js";
import { renderDockerfile } from "./dockerfile-model.js";
import { sanitizeNamePart } from "./database-name.js";
import type { OdooAgenticDevConfig } from "./project-recipe.js";
import type { WorktreeContext } from "./worktree-context.js";

/**
 * One image repository per project (not per worktree): worktrees whose build
 * inputs hash to the same key share a single image instead of each tagging a
 * multi-GB copy under compose's default `<composeProject>-<service>` name.
 */
export const imageRepository = (recipe: OdooAgenticDevConfig): string =>
  `oad-${sanitizeNamePart(recipe.project.id)}-odoo`;

/** Content-addressed reference: the tag IS the image key, so "tag exists" means "fresh". */
export const imageReference = (recipe: OdooAgenticDevConfig, imageKey: string): string =>
  `${imageRepository(recipe)}:${imageKey.slice(0, 12)}`;

/**
 * Keyed naming applies only to fully oad-managed builds: `odoo.build` recipes
 * fingerprint every build input, while a user `odoo.dockerfile`'s COPY sources
 * are opaque to us, and an explicit `imageName` stays the user's to manage.
 */
export const usesKeyedImage = (recipe: OdooAgenticDevConfig): boolean =>
  recipe.odoo.build !== null && recipe.odoo.imageName === null;

const updatePathFingerprint = (
  hash: ReturnType<typeof createHash>,
  rootDir: string,
  sourcePath: string,
) => {
  const absolute = isAbsolute(sourcePath) ? sourcePath : resolvePath(rootDir, sourcePath);
  const visit = (path: string) => {
    const stat = lstatSync(path);
    const name = relative(rootDir, path) || ".";
    if (stat.isSymbolicLink()) {
      hash.update(`symlink:${name}:${readlinkSync(path)}\0`);
      return;
    }
    if (stat.isDirectory()) {
      hash.update(`dir:${name}\0`);
      for (const entry of readdirSync(path).sort()) visit(resolvePath(path, entry));
      return;
    }
    if (stat.isFile()) {
      hash.update(`file:${name}\0`);
      hash.update(readFileSync(path));
      hash.update("\0");
      return;
    }
    hash.update(`other:${name}:${stat.mode}:${stat.size}\0`);
  };
  visit(absolute);
};

const extension = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
};

export const isTemplateInputFile = (relativePath: string): boolean => {
  const parts = relativePath
    .split(/[\\/]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 0 && part !== ".");
  const basename = parts.at(-1);
  if (basename === undefined) return false;
  if (basename === "__manifest__.py" || basename === "__openerp__.py") return true;

  const ext = extension(basename);
  const dirs = new Set(parts.slice(0, -1));
  if (dirs.has("security")) return ext === ".xml" || ext === ".csv";
  if (dirs.has("views")) return ext === ".xml";
  if (dirs.has("data") || dirs.has("demo")) return ext === ".xml" || ext === ".csv";
  if (dirs.has("i18n")) return ext === ".po" || ext === ".pot" || ext === ".csv";
  if (dirs.has("tests")) {
    return ext === ".xml" || ext === ".yml" || ext === ".yaml" || ext === ".json" || ext === ".csv";
  }
  return false;
};

const updateFilteredPathFingerprint = (
  hash: ReturnType<typeof createHash>,
  rootDir: string,
  sourcePath: string,
  include: (relativeToSource: string) => boolean,
): boolean => {
  const absolute = isAbsolute(sourcePath) ? sourcePath : resolvePath(rootDir, sourcePath);
  if (!existsSync(absolute)) return false;
  let matched = false;
  const visit = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(resolvePath(path, entry));
      return;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) return;

    const relativeToSource = relative(absolute, path) || ".";
    if (!include(relativeToSource)) return;
    matched = true;
    const name = relative(rootDir, path) || ".";
    if (stat.isSymbolicLink()) {
      hash.update(`symlink:${name}:${readlinkSync(path)}\0`);
      return;
    }
    hash.update(`file:${name}\0`);
    hash.update(readFileSync(path));
    hash.update("\0");
  };
  visit(absolute);
  return matched;
};

const computeImageKeySync = (recipe: OdooAgenticDevConfig, ctx: WorktreeContext): string | null => {
  const hasManagedImage = recipe.odoo.build !== null || recipe.odoo.dockerfile !== null;
  if (!hasManagedImage) return null;

  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      kind: "oad-image",
      version: recipe.odoo.version,
      imageName: recipe.odoo.imageName,
      build: recipe.odoo.build,
      dockerfile: recipe.odoo.dockerfile,
    }),
  );

  if (recipe.odoo.build !== null) {
    hash.update(renderDockerfile(recipe.odoo.version, recipe.odoo.build));
    for (const source of recipe.odoo.build.pipRequirements) {
      hash.update(`pipRequirements:${source}\0`);
      updatePathFingerprint(hash, ctx.rootDir, source);
    }
    for (const entry of recipe.odoo.build.copy) {
      hash.update(`copy:${entry.from}:${entry.to}\0`);
      updatePathFingerprint(hash, ctx.rootDir, entry.from);
    }
  }

  if (recipe.odoo.dockerfile !== null) {
    hash.update(`dockerfile:${recipe.odoo.dockerfile}\0`);
    updatePathFingerprint(hash, ctx.rootDir, recipe.odoo.dockerfile);
  }

  return hash.digest("hex");
};

/** Current Odoo image identity, or null when the recipe uses an unmanaged stock/prebuilt image. */
export const computeImageKeyForContext = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
): Effect.Effect<string | null, ConfigLoadError> =>
  Effect.try({
    try: () => computeImageKeySync(recipe, ctx),
    catch: (cause) =>
      new ConfigLoadError({
        path: ctx.rootDir,
        reason: `could not fingerprint Odoo image inputs: ${String(cause)}`,
      }),
  });

/**
 * Content hash for database template invalidation. This deliberately includes
 * mounted config-file contents because they can change Odoo init/update
 * behavior, while image freshness itself only tracks build/dockerfile inputs.
 */
export const computeTemplateInputHashForContext = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
): Effect.Effect<string | null, ConfigLoadError> =>
  Effect.try({
    try: () => {
      const hash = createHash("sha256");
      let hasContentInputs = false;
      const imageKey = computeImageKeySync(recipe, ctx);
      if (imageKey !== null) {
        hasContentInputs = true;
        hash.update(`image:${imageKey}\0`);
      }
      if (recipe.odoo.configFile !== null) {
        hasContentInputs = true;
        hash.update(`configFile:${recipe.odoo.configFile}\0`);
        updatePathFingerprint(hash, ctx.rootDir, recipe.odoo.configFile);
      }
      for (const addon of recipe.odoo.addons) {
        const matched = updateFilteredPathFingerprint(
          hash,
          ctx.rootDir,
          addon.host,
          isTemplateInputFile,
        );
        if (matched) {
          hasContentInputs = true;
          hash.update(`addons:${addon.host}:${addon.container}\0`);
        }
      }
      return hasContentInputs ? hash.digest("hex") : null;
    },
    catch: (cause) =>
      new ConfigLoadError({
        path: ctx.rootDir,
        reason: `could not fingerprint template inputs: ${String(cause)}`,
      }),
  });
