import { Effect, Option } from "effect";
import { loadRecipe } from "../config/load-recipe.js";
import { buildWorktreeContext } from "../core/worktree-context.js";
import type { WorktreeContext } from "../core/worktree-context.js";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import { Git } from "../platform/git.js";
import type { GitApi } from "../platform/git.js";
import type { ConfigLoadError, ConfigValidationError, RuntimeError } from "../errors/errors.js";

export type ResolvedContext = {
  readonly recipe: OdooAgenticDevConfig;
  readonly ctx: WorktreeContext;
};

/** Shared preamble for every command: config + git -> context. */
export const resolveContext = (
  configFlag: Option.Option<string>,
): Effect.Effect<ResolvedContext, RuntimeError, GitApi> =>
  Effect.gen(function* () {
    const env = process.env;
    const { recipe, rootDir } = yield* loadRecipe({
      cwd: process.cwd(),
      explicitPath: Option.getOrUndefined(configFlag),
      env,
    });
    const git = yield* Git;
    const gitState = yield* git.state(rootDir);
    const ctx = yield* buildWorktreeContext({ rootDir, recipe, env, git: gitState });
    return { recipe, ctx };
  });

export type ProjectScope = {
  readonly projectId: string | undefined;
  readonly rootDir: string | undefined;
};

/**
 * Project scope for `list`/`prune`: `--all-projects` means "no filter" and
 * deliberately skips config discovery entirely, so these commands work from
 * any directory. Otherwise the discovered recipe's project id filters rows and
 * its root scopes the worktree-local state DB.
 */
export const resolveProjectScope = (
  configFlag: Option.Option<string>,
  allProjects: boolean,
): Effect.Effect<ProjectScope, ConfigLoadError | ConfigValidationError> =>
  allProjects
    ? Effect.succeed({ projectId: undefined, rootDir: undefined })
    : loadRecipe({
        cwd: process.cwd(),
        explicitPath: Option.getOrUndefined(configFlag),
        env: process.env,
      }).pipe(Effect.map(({ recipe, rootDir }) => ({ projectId: recipe.project.id, rootDir })));
