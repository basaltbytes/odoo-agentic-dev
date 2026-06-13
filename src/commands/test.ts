import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { UsageError } from "../errors/errors.js";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import type { OdooTestOptions } from "../core/command-plan.js";
import { OdooLifecycle } from "../platform/odoo-lifecycle.js";
import { resolveContext } from "./resolve-context.js";
import { recordEnvironment } from "./state-hooks.js";
import { withJsonReport } from "./json-report.js";

export const resolveTestOptions = (
  recipe: OdooAgenticDevConfig,
  flags: {
    readonly tags: string | undefined;
    readonly file: string | undefined;
    readonly module: string | undefined;
    readonly logLevel: string | undefined;
    readonly profile: string | undefined;
    readonly build: boolean;
  },
): Effect.Effect<OdooTestOptions & { readonly extraArgs: ReadonlyArray<string> }, UsageError> => {
  let extraArgs: ReadonlyArray<string> = [];
  if (flags.profile !== undefined) {
    const profile = recipe.test.profiles[flags.profile];
    if (profile === undefined) {
      return Effect.fail(
        new UsageError({
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
    build: flags.build,
    extraArgs,
  });
};

export const detectSkippedBrowserSuite = (output: {
  readonly stdoutTail: string;
  readonly stderrTail: string;
}): string | null => {
  const combined = `${output.stdoutTail}\n${output.stderrTail}`;
  return /websocket-client/i.test(combined) && /skipp?ed/i.test(combined)
    ? "Odoo skipped browser tests because the websocket-client Python package is missing in the image. Add `websocket-client` to odoo.build.pipPackages, rebuild with `oad test --build` or `oad setup`, then rerun the test command."
    : null;
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
    build: Flag.boolean("build").pipe(
      Flag.withDescription("rebuild the Odoo image before running the test container"),
    ),
    includeDemo: Flag.boolean("include-demo").pipe(
      Flag.withDescription(
        "accepted for compatibility; demo data is controlled at database init in v1",
      ),
    ),
    json: Flag.boolean("json").pipe(
      Flag.withDescription("suppress decorative output; print one final JSON report line"),
    ),
    config: Flag.string("config").pipe(Flag.optional),
  },
  (flags) =>
    withJsonReport("test", flags.json, (report) =>
      Effect.gen(function* () {
        const { ctx, recipe } = yield* resolveContext(flags.config);
        yield* report.setContext(ctx);
        yield* recordEnvironment(recipe, ctx);
        if (flags.includeDemo) {
          yield* report.say(
            "note: --include-demo has no effect in v1; reset the database with --without-demo=false instead",
          );
        }
        const options = yield* resolveTestOptions(recipe, {
          tags: Option.getOrUndefined(flags.tags),
          file: Option.getOrUndefined(flags.file),
          module: Option.getOrUndefined(flags.module),
          logLevel: Option.getOrUndefined(flags.logLevel),
          profile: Option.getOrUndefined(flags.profile),
          build: flags.build,
        });
        const lifecycle = yield* OdooLifecycle;
        const { exitCode, stderrTail, stdoutTail } = yield* lifecycle.runTests(
          recipe,
          ctx,
          options,
        );
        const skipReason =
          exitCode === 0 ? detectSkippedBrowserSuite({ stdoutTail, stderrTail }) : null;
        const effectiveExitCode = skipReason === null ? exitCode : 1;
        yield* report.action("run-tests");
        yield* report.setExitCode(effectiveExitCode);
        yield* report.setExtra("stdoutTail", stdoutTail);
        yield* report.setExtra("stderrTail", stderrTail);
        if (skipReason !== null) yield* report.setExtra("skipReason", skipReason);
        // in json mode the stream-swap already routes process.stdout writes to
        // stderr, so the human-facing tail never reaches the JSON stdout line
        if (stdoutTail.length > 0) process.stdout.write(stdoutTail + "\n");
        if (stderrTail.length > 0) process.stderr.write(stderrTail + "\n");
        if (effectiveExitCode !== 0) {
          yield* Console.error(skipReason ?? `Tests failed (odoo exit ${exitCode})`);
          process.exitCode = effectiveExitCode;
        } else {
          yield* report.say("Tests passed");
        }
      }),
    ),
).pipe(Command.withDescription("run odoo tests against this worktree's database"));
