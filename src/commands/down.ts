import { Console, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import type { WorktreeContext } from "../core/worktree-context.js";
import { assertSharedDatabaseAllowed } from "../core/safety.js";
import { DockerCompose } from "../platform/docker-compose.js";
import { resolveContext } from "./resolve-context.js";
import type { SharedDatabaseProtectionError } from "../errors/errors.js";

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
  ...(flags.volumes ? ["--volumes"] : []),
];

export const downCommand = Command.make(
  "down",
  {
    volumes: Flag.boolean("volumes").pipe(
      Flag.withDescription("also remove this worktree's volumes"),
    ),
    allowShared: Flag.boolean("allow-shared"),
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    Effect.gen(function* () {
      const { ctx, recipe } = yield* resolveContext(flags.config);
      yield* guardDown(recipe, ctx, flags);
      const compose = yield* DockerCompose;
      yield* compose.ensureAvailable();
      const ref = yield* compose.prepareComposeFile(recipe, ctx);
      yield* Console.log(
        `Stopping compose project: ${ctx.composeProjectName} (database: ${ctx.databaseName})`,
      );
      yield* compose.stream(ref, buildDownArgs(flags));
    }),
);
