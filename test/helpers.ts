import { Cause, Effect, Exit, Layer, Option } from "effect";
import { normalizeConfig, validateConfigInput } from "../src/config/schema.js";
import type { OdooAgenticDevConfig } from "../src/core/project-recipe.js";
import { buildWorktreeContext } from "../src/core/worktree-context.js";
import type { WorktreeContext } from "../src/core/worktree-context.js";

/** Run a sync Effect expected to succeed; returns its value. */
export const runSyncSuccess = <A, E>(effect: Effect.Effect<A, E>): A => Effect.runSync(effect);

/** Run a sync Effect expected to fail; returns its typed failure. */
export const runSyncFailure = <A, E>(effect: Effect.Effect<A, E>): E => {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) {
    throw new Error("expected failure, got success: " + JSON.stringify(exit.value));
  }
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isNone(failure)) {
    throw new Error("expected a typed failure, got: " + String(Cause.squash(exit.cause)));
  }
  return failure.value;
};

/** Validate + normalize a raw config input into a recipe fixture. */
export const makeRecipe = (input: unknown): OdooAgenticDevConfig =>
  runSyncSuccess(validateConfigInput(input).pipe(Effect.flatMap(normalizeConfig)));

/** Build a WorktreeContext fixture for a recipe on a plain branch checkout. */
export const makeCtx = (
  recipe: OdooAgenticDevConfig,
  branch: string,
  rootDir = "/w",
): WorktreeContext =>
  runSyncSuccess(
    buildWorktreeContext({ rootDir, recipe, env: {}, git: { _tag: "Branch", branch } }),
  );

/** Provide a fully built layer and run the Effect as a Promise. */
export const runWith =
  <Services>(layer: Layer.Layer<Services>) =>
  <A, E>(effect: Effect.Effect<A, E, Services>): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)));
