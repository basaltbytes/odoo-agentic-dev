import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { InitError, isRuntimeError, renderError } from "../errors/errors.js";
import { discoverConfigPath, loadRecipe } from "../config/load-recipe.js";
import { deriveDbPrefix, deriveProjectId, renderInitConfig } from "../core/init-template.js";

const CONFIG_FILENAME = "odoo-agentic-dev.config.ts";
const GITIGNORE_LINE = ".odoo-agentic-dev/";
const DEFAULT_ODOO_VERSION = "18.0";

export type InitResult = {
  readonly written: ReadonlyArray<string>;
  readonly projectId: string;
  readonly dbPrefix: string;
};

export type PerformInitOptions = {
  readonly cwd: string;
  readonly force: boolean;
  readonly id?: string | undefined;
  readonly dbPrefix?: string | undefined;
  readonly odooVersion?: string | undefined;
};

const fail = (reason: string): Effect.Effect<never, InitError> =>
  Effect.fail(new InitError({ reason }));

const tryRead = (path: string): Effect.Effect<string, InitError> =>
  Effect.try({
    try: () => readFileSync(path, "utf8"),
    catch: (cause) => new InitError({ reason: `could not read ${path}: ${String(cause)}` }),
  });

const tryWrite = (path: string, content: string): Effect.Effect<void, InitError> =>
  Effect.try({
    try: () => writeFileSync(path, content),
    catch: (cause) => new InitError({ reason: `could not write ${path}: ${String(cause)}` }),
  });

const dirExists = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Scaffold a config in `cwd`. Refuses when a config already exists: a config in
 * `cwd` only with `--force` (the file is about to be replaced), but a config in
 * any ANCESTOR directory ALWAYS refuses — nested configs are a footgun, and
 * --force must not let you create one. The generated file is proven against the
 * real loader before success is reported; on loader failure the file is left in
 * place for inspection.
 */
export const performInit = (options: PerformInitOptions): Effect.Effect<InitResult, InitError> =>
  Effect.gen(function* () {
    const { cwd, force } = options;
    const configPath = join(cwd, CONFIG_FILENAME);

    // Refusal: discover any existing config from cwd upward.
    const existing = yield* discoverConfigPath(cwd);
    if (existing !== undefined) {
      const inCwd = dirname(existing) === cwd;
      if (!inCwd) {
        return yield* fail(
          `a config already exists in an ancestor directory (${existing}); nested configs are a footgun. Refusing even with --force — run init from that project, or remove the ancestor config first.`,
        );
      }
      if (!force) {
        return yield* fail(
          `a config already exists at ${existing}; re-run with --force to overwrite it.`,
        );
      }
    }

    const projectId = options.id ?? deriveProjectId(basename(cwd));
    const dbPrefix = options.dbPrefix ?? deriveDbPrefix(projectId);
    const odooVersion = options.odooVersion ?? DEFAULT_ODOO_VERSION;

    // addons detection: an existing ./addons dir is a real mount (no comment),
    // otherwise emit the placeholder host WITH the adjust comment.
    const addonsIsPlaceholder = !dirExists(join(cwd, "addons"));

    const configText = renderInitConfig({
      id: projectId,
      dbPrefix,
      odooVersion,
      addonsHost: "addons",
      addonsIsPlaceholder,
    });

    const written: Array<string> = [];

    yield* tryWrite(configPath, configText);
    written.push(CONFIG_FILENAME);

    // Append .odoo-agentic-dev/ to .gitignore; create it if absent, skip the
    // append when the exact line is already present.
    const gitignorePath = join(cwd, ".gitignore");
    if (existsSync(gitignorePath)) {
      const current = yield* tryRead(gitignorePath);
      const hasLine = current.split(/\r?\n/).some((line) => line.trim() === GITIGNORE_LINE);
      if (!hasLine) {
        const sep = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
        yield* tryWrite(gitignorePath, `${current}${sep}${GITIGNORE_LINE}\n`);
        written.push(".gitignore");
      }
    } else {
      yield* tryWrite(gitignorePath, `${GITIGNORE_LINE}\n`);
      written.push(".gitignore");
    }

    // Prove the scaffolded config loads via the REAL loader before reporting
    // success — leave the file on disk for inspection if it does not.
    yield* loadRecipe({ cwd, explicitPath: configPath, env: process.env }).pipe(
      Effect.mapError(
        (error) =>
          new InitError({
            reason: `the generated config did not load: ${
              isRuntimeError(error) ? renderError(error) : String(error)
            }`,
          }),
      ),
    );

    return { written, projectId, dbPrefix };
  });

// --- command ----------------------------------------------------------------

/** The success payload printed (as one line) to stdout in `--json` mode. */
export const renderInitJson = (result: InitResult): string =>
  JSON.stringify({
    ok: true,
    command: "init",
    written: result.written,
    projectId: result.projectId,
    dbPrefix: result.dbPrefix,
  });

/** The failure payload printed (as one line) to stdout in `--json` mode. */
export const renderInitErrorJson = (error: {
  readonly _tag: string;
  readonly message: string;
}): string =>
  JSON.stringify({
    ok: false,
    command: "init",
    error: { tag: error._tag, message: error.message },
  });

const NEXT_STEPS: ReadonlyArray<string> = [
  "",
  "Next steps:",
  "  1. pnpm add -D @basaltbytes/odoo-agentic-dev   (config types + hooks)",
  "  2. odoo-agentic-dev setup",
];

export const initCommand = Command.make(
  "init",
  {
    id: Flag.string("id").pipe(
      Flag.optional,
      Flag.withDescription("project id (default: derived from the folder name)"),
    ),
    dbPrefix: Flag.string("db-prefix").pipe(
      Flag.optional,
      Flag.withDescription("database prefix (default: derived from the project id)"),
    ),
    odooVersion: Flag.string("odoo-version").pipe(
      Flag.withDefault(DEFAULT_ODOO_VERSION),
      Flag.withDescription(`Odoo version (default ${DEFAULT_ODOO_VERSION})`),
    ),
    force: Flag.boolean("force").pipe(
      Flag.withDescription("overwrite an existing config in the current directory"),
    ),
    json: Flag.boolean("json").pipe(Flag.withDescription("print machine-readable JSON")),
  },
  (flags) =>
    Effect.gen(function* () {
      const json = flags.json;
      const program = Effect.gen(function* () {
        const result = yield* performInit({
          cwd: process.cwd(),
          force: flags.force,
          id: Option.getOrUndefined(flags.id),
          dbPrefix: Option.getOrUndefined(flags.dbPrefix),
          odooVersion: flags.odooVersion,
        });

        if (json) {
          // human output to stderr; stdout is exactly one JSON object
          for (const path of result.written) yield* Console.error(`wrote ${path}`);
          for (const line of NEXT_STEPS) yield* Console.error(line);
          yield* Effect.sync(() => process.stdout.write(`${renderInitJson(result)}\n`));
          return;
        }

        for (const path of result.written) yield* Console.log(`wrote ${path}`);
        for (const line of NEXT_STEPS) yield* Console.log(line);
      });

      // in JSON mode, typed failures still emit one JSON object on stdout
      return yield* json
        ? program.pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                if (isRuntimeError(error)) yield* Console.error(renderError(error));
                yield* Effect.sync(() => process.stdout.write(`${renderInitErrorJson(error)}\n`));
                yield* Effect.sync(() => {
                  process.exitCode = 1;
                });
              }),
            ),
          )
        : program;
    }),
).pipe(Command.withDescription("scaffold an odoo-agentic-dev.config.ts in the current directory"));
