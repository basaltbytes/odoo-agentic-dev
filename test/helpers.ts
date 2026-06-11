import { Cause, Effect, Exit, Option } from "effect";

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
