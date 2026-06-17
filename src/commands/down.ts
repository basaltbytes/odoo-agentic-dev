import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import type { WorktreeContext } from "../core/worktree-context.js";
import { assertSharedDatabaseAllowed } from "../core/safety.js";
import { DockerCompose } from "../platform/docker-compose.js";
import type { ComposeRef, DockerComposeApi } from "../platform/docker-compose.js";
import { StateStore } from "../platform/state-store.js";
import type { StateStoreApi } from "../platform/state-store.js";
import { withStateDbRoot } from "../platform/state-store.js";
import { resolveContext } from "./resolve-context.js";
import { withJsonReport } from "./json-report.js";
import type {
  ComposeCommandError,
  SharedDatabaseProtectionError,
  StateError,
} from "../errors/errors.js";

export const guardDown = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
  flags: { volumes: boolean; allowShared: boolean },
): Effect.Effect<void, SharedDatabaseProtectionError> =>
  flags.volumes
    ? assertSharedDatabaseAllowed({
        databaseName: ctx.databaseName,
        sharedDatabase: recipe.project.sharedDatabase,
        allowShared: flags.allowShared,
        action: "down --volumes",
      })
    : Effect.void;

export const buildDownArgs = (flags: { volumes: boolean }): Array<string> => [
  "down",
  "--remove-orphans",
  ...(flags.volumes ? ["--volumes"] : []),
];

export type DownTeardownMode = "compose" | "label-fallback";

export const runDownDocker = (
  compose: DockerComposeApi,
  ref: ComposeRef,
  ctx: WorktreeContext,
  flags: { volumes: boolean },
): Effect.Effect<DownTeardownMode, ComposeCommandError> => {
  const composeDown = compose
    .stream(ref, buildDownArgs(flags))
    .pipe(Effect.as<DownTeardownMode>("compose"));
  return flags.volumes
    ? composeDown.pipe(
        Effect.catchTag("ComposeCommandError", () =>
          compose
            .removeByLabel(ctx.composeProjectName)
            .pipe(Effect.as<DownTeardownMode>("label-fallback")),
        ),
      )
    : composeDown;
};

/** After a successful teardown: `--volumes` forgets the environment, plain down only touches it. */
export const finalizeDownState = (
  ctx: WorktreeContext,
  flags: { volumes: boolean },
): Effect.Effect<void, StateError, StateStoreApi> =>
  withStateDbRoot(
    ctx.rootDir,
    Effect.gen(function* () {
      const store = yield* StateStore;
      yield* flags.volumes
        ? store.remove(ctx.composeProjectName)
        : store.touch(ctx.composeProjectName);
    }),
  );

export const downCommand = Command.make(
  "down",
  {
    volumes: Flag.boolean("volumes").pipe(
      Flag.withDescription("also remove this worktree's volumes"),
    ),
    allowShared: Flag.boolean("allow-shared"),
    json: Flag.boolean("json").pipe(
      Flag.withDescription("suppress decorative output; print one final JSON report line"),
    ),
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    withJsonReport("down", flags.json, (report) =>
      Effect.gen(function* () {
        const { ctx, recipe } = yield* resolveContext(flags.config);
        yield* report.setContext(ctx);
        yield* guardDown(recipe, ctx, flags);
        const compose = yield* DockerCompose;
        yield* compose.ensureAvailable();
        const ref = yield* compose.prepareComposeFile(recipe, ctx);
        yield* report.say(
          `Stopping compose project: ${ctx.composeProjectName} (database: ${ctx.databaseName})`,
        );
        const teardownMode = yield* runDownDocker(compose, ref, ctx, flags);
        yield* report.action(teardownMode === "compose" ? "compose-down" : "label-teardown");
        if (flags.volumes) yield* report.action("remove-volumes");
        yield* report.setExtra("volumesRemoved", flags.volumes);
        yield* finalizeDownState(ctx, flags);
      }),
    ),
).pipe(Command.withDescription("stop this worktree's stack (--volumes to also delete data)"));
