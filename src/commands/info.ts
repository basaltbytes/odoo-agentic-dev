import { Console, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type { WorktreeContext } from "../core/worktree-context.js";
import { resolveContext } from "./resolve-context.js";

export const buildInfoText = (ctx: WorktreeContext): string => {
  const out = [
    `Worktree: ${ctx.worktreeName}`,
    `Database: ${ctx.databaseName}`,
    `Compose project: ${ctx.composeProjectName}`,
    `Odoo URL: ${ctx.odooBaseUrl}/web?db=${ctx.databaseName}`,
  ];
  for (const [name, port] of ctx.companionPorts) out.push(`${name} URL: http://localhost:${port}`);
  return out.join("\n");
};

export const buildInfoJson = (ctx: WorktreeContext): string =>
  JSON.stringify(
    {
      rootDir: ctx.rootDir,
      worktreeName: ctx.worktreeName,
      databaseName: ctx.databaseName,
      composeProjectName: ctx.composeProjectName,
      odooHttpPort: ctx.odooHttpPort,
      odooBaseUrl: ctx.odooBaseUrl,
      odooUrl: `${ctx.odooBaseUrl}/web?db=${ctx.databaseName}`,
      companions: Object.fromEntries(ctx.companionPorts),
      env: ctx.env,
    },
    null,
    2,
  );

export const buildInfoEnv = (ctx: WorktreeContext): string =>
  Object.entries(ctx.env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

export const infoCommand = Command.make(
  "info",
  {
    json: Flag.boolean("json").pipe(Flag.withDescription("print machine-readable JSON")),
    env: Flag.boolean("env").pipe(Flag.withDescription("print KEY=value env lines")),
    config: Flag.string("config").pipe(
      Flag.optional,
      Flag.withDescription("explicit config file path"),
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const { ctx } = yield* resolveContext(flags.config);
      const output = flags.json
        ? buildInfoJson(ctx)
        : flags.env
          ? buildInfoEnv(ctx)
          : buildInfoText(ctx);
      yield* Console.log(output);
    }),
);
