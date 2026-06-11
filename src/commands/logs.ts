import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import type { WorktreeContext } from "../core/worktree-context.js";
import type { ComposeCommandError, DockerUnavailableError } from "../errors/errors.js";
import { DockerCompose } from "../platform/docker-compose.js";
import type { DockerComposeApi } from "../platform/docker-compose.js";
import { resolveContext } from "./resolve-context.js";

export const buildLogsArgs = (serviceName: string, follow: boolean): Array<string> => [
  "logs",
  ...(follow ? ["-f"] : []),
  serviceName,
];

/** Stream `docker compose logs` for one service (default: the odoo service). */
export const runLogs = (
  recipe: OdooAgenticDevConfig,
  ctx: WorktreeContext,
  options: { readonly service: string | undefined; readonly follow: boolean },
): Effect.Effect<void, ComposeCommandError | DockerUnavailableError, DockerComposeApi> =>
  Effect.gen(function* () {
    const compose = yield* DockerCompose;
    yield* compose.ensureAvailable();
    const ref = yield* compose.prepareComposeFile(recipe, ctx);
    yield* compose.stream(
      ref,
      buildLogsArgs(options.service ?? recipe.odoo.serviceName, options.follow),
    );
  });

export const logsCommand = Command.make(
  "logs",
  {
    service: Argument.string("service").pipe(
      Argument.optional,
      Argument.withDescription("compose service (defaults to the odoo service)"),
    ),
    follow: Flag.boolean("follow").pipe(Flag.withDescription("follow log output")),
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    Effect.gen(function* () {
      const { ctx, recipe } = yield* resolveContext(flags.config);
      yield* runLogs(recipe, ctx, {
        service: Option.getOrUndefined(flags.service),
        follow: flags.follow,
      });
    }),
);
