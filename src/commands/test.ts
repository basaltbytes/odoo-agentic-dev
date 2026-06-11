import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { ConfigValidationError } from "../errors/errors.js";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import type { OdooTestOptions } from "../core/command-plan.js";
import { OdooLifecycle } from "../platform/odoo-lifecycle.js";
import { resolveContext } from "./resolve-context.js";

export const resolveTestOptions = (
  recipe: OdooAgenticDevConfig,
  flags: {
    readonly tags: string | undefined;
    readonly file: string | undefined;
    readonly module: string | undefined;
    readonly logLevel: string | undefined;
    readonly profile: string | undefined;
  },
): Effect.Effect<
  OdooTestOptions & { readonly extraArgs: ReadonlyArray<string> },
  ConfigValidationError
> => {
  let extraArgs: ReadonlyArray<string> = [];
  if (flags.profile !== undefined) {
    const profile = recipe.test.profiles[flags.profile];
    if (profile === undefined) {
      return Effect.fail(
        new ConfigValidationError({
          issues: [
            `unknown test profile "${flags.profile}"; available: ${
              Object.keys(recipe.test.profiles).join(", ") || "(none)"
            }`,
          ],
        }),
      );
    }
    extraArgs = profile;
  }
  return Effect.succeed({
    tags: flags.tags,
    file: flags.file,
    module: flags.module,
    logLevel: flags.logLevel,
    extraArgs,
  });
};

export const testCommand = Command.make(
  "test",
  {
    tags: Flag.string("tags").pipe(Flag.optional),
    file: Flag.string("file").pipe(Flag.optional),
    module: Flag.string("module").pipe(Flag.optional),
    logLevel: Flag.string("log-level").pipe(Flag.optional),
    profile: Flag.string("profile").pipe(
      Flag.optional,
      Flag.withDescription("recipe-defined test profile"),
    ),
    includeDemo: Flag.boolean("include-demo").pipe(
      Flag.withDescription(
        "accepted for compatibility; demo data is controlled at database init in v1",
      ),
    ),
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    Effect.gen(function* () {
      const { ctx, recipe } = yield* resolveContext(flags.config);
      if (flags.includeDemo) {
        yield* Console.log(
          "note: --include-demo has no effect in v1; reset the database with --without-demo=false instead",
        );
      }
      const options = yield* resolveTestOptions(recipe, {
        tags: Option.getOrUndefined(flags.tags),
        file: Option.getOrUndefined(flags.file),
        module: Option.getOrUndefined(flags.module),
        logLevel: Option.getOrUndefined(flags.logLevel),
        profile: Option.getOrUndefined(flags.profile),
      });
      const lifecycle = yield* OdooLifecycle;
      const code = yield* lifecycle.runTests(recipe, ctx, options);
      if (code !== 0) {
        yield* Console.error(`Tests failed (odoo exit ${code})`);
        yield* Effect.sync(() => {
          process.exitCode = code;
        });
      } else {
        yield* Console.log("Tests passed");
      }
    }),
);
