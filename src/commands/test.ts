import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { UsageError } from "../errors/errors.js";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import type { OdooTestOptions } from "../core/command-plan.js";
import { OdooLifecycle } from "../platform/odoo-lifecycle.js";
import { resolveContext } from "./resolve-context.js";
import {
  buildImageAndRecord,
  recordEnvironment,
  reportImageFreshness,
  warnIfImageStale,
} from "./state-hooks.js";
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

export type TestOutputAnalysis = {
  readonly fatalReason: string | null;
  readonly warnings: ReadonlyArray<string>;
};

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])`, "g");

const normalizeOutput = (output: { readonly stdout: string; readonly stderr: string }): string =>
  `${output.stdout}\n${output.stderr}`.replace(ANSI_RE, "").replace(/\r\n?/g, "\n");

const FATAL_BROWSER_SKIP_PATTERNS: ReadonlyArray<RegExp> = [
  /\bwebsocket-client module is not installed\b/i,
  /\bChrome executable not found\b/i,
  /\b(?:google-chrome|chromium(?:-browser)?|chrome)[^\n:]* not found\b/i,
  /\bChrome headless failed to start\b/i,
  /\bFailed to detect chrome devtools port after \d+(?:\.\d+)?s\b/i,
  /\bError during Chrome headless connection\b/i,
  /\bError during Chrome connection: never found 'page' target\b/i,
  /\bCannot connect to chrome dev tools\b/i,
];

const HOOT_SKIPPED_COUNTER =
  /\bskipped:[^\S\r\n]*([1-9]\d*)\b|\b([1-9]\d*)[^\S\r\n]+tests?[^\S\r\n]+skipped\b/i;
const HOOT_ZERO_PASSED = /\b(?:\[HOOT\]\s*)?Passed\s+0\s+tests\b/i;
const HOOT_SOME_PASSED = /\b(?:\[HOOT\]\s*)?Passed\s+([1-9]\d*)\s+tests\b/i;

const browserDependencyMessage =
  "Odoo skipped browser tests because required browser-test dependencies are missing in the image (for example `websocket-client`, Chrome, or Chromium). Add the missing package(s) to odoo.build, rebuild with `oad test --build`, `oad restart --rebuild`, or `oad setup`, then rerun the test command.";

export const analyzeTestOutput = (output: {
  readonly stdout: string;
  readonly stderr: string;
}): TestOutputAnalysis => {
  const combined = normalizeOutput(output);
  if (FATAL_BROWSER_SKIP_PATTERNS.some((pattern) => pattern.test(combined))) {
    return { fatalReason: browserDependencyMessage, warnings: [] };
  }

  const skipped = HOOT_SKIPPED_COUNTER.exec(combined);
  if (skipped !== null && HOOT_ZERO_PASSED.test(combined)) {
    return {
      fatalReason:
        "Odoo reported skipped Hoot tests with zero passed tests. Treating the run as failed because the intended browser suite did not execute.",
      warnings: [],
    };
  }
  if (skipped !== null && HOOT_SOME_PASSED.test(combined)) {
    const count = skipped[1] ?? skipped[2] ?? "some";
    return {
      fatalReason: null,
      warnings: [`Odoo reported ${count} skipped Hoot/browser test(s).`],
    };
  }

  return { fatalReason: null, warnings: [] };
};

export const detectSkippedBrowserSuite = (output: {
  readonly stdoutTail?: string;
  readonly stderrTail?: string;
  readonly stdout?: string;
  readonly stderr?: string;
}): string | null => {
  const stdout = output.stdout ?? output.stdoutTail ?? "";
  const stderr = output.stderr ?? output.stderrTail ?? "";
  return analyzeTestOutput({ stdout, stderr }).fatalReason;
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
        if (!flags.build) {
          yield* reportImageFreshness(report, yield* warnIfImageStale(recipe, ctx, report.say));
        }
        if (flags.includeDemo) {
          yield* report.say(
            "note: --include-demo has no effect in v1; set database.withoutDemo: false and reset the database instead",
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
        const runOptions = flags.build ? { ...options, build: false } : options;
        if (flags.build) {
          yield* buildImageAndRecord(recipe, ctx, report);
        }
        const { exitCode, stderr, stderrTail, stdout, stdoutTail } = yield* lifecycle.runTests(
          recipe,
          ctx,
          runOptions,
        );
        const analysis =
          exitCode === 0
            ? analyzeTestOutput({ stdout, stderr })
            : { fatalReason: null, warnings: [] };
        const skipReason = analysis.fatalReason;
        const effectiveExitCode = skipReason === null ? exitCode : 1;
        yield* report.action("run-tests");
        yield* report.setExitCode(effectiveExitCode);
        yield* report.setExtra("stdoutTail", stdoutTail);
        yield* report.setExtra("stderrTail", stderrTail);
        if (skipReason !== null) yield* report.setExtra("skipReason", skipReason);
        if (analysis.warnings.length > 0) yield* report.setExtra("warnings", analysis.warnings);
        // in json mode the stream-swap already routes process.stdout writes to
        // stderr, so the human-facing tail never reaches the JSON stdout line
        if (stdoutTail.length > 0) process.stdout.write(stdoutTail + "\n");
        if (stderrTail.length > 0) process.stderr.write(stderrTail + "\n");
        if (effectiveExitCode !== 0) {
          yield* Console.error(skipReason ?? `Tests failed (odoo exit ${exitCode})`);
          process.exitCode = effectiveExitCode;
        } else {
          for (const warning of analysis.warnings) yield* Console.error(warning);
          yield* report.say("Tests passed");
        }
      }),
    ),
).pipe(Command.withDescription("run odoo tests against this worktree's database"));
