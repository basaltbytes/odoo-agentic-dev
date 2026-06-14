import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import { Effect } from "effect";
import { ConfigLoadError } from "../errors/errors.js";
import { renderDockerfile } from "./dockerfile-model.js";
import type { OdooAgenticDevConfig } from "./project-recipe.js";
import type { WorktreeContext } from "./worktree-context.js";

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
      return hasContentInputs ? hash.digest("hex") : null;
    },
    catch: (cause) =>
      new ConfigLoadError({
        path: ctx.rootDir,
        reason: `could not fingerprint template inputs: ${String(cause)}`,
      }),
  });
