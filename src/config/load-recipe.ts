import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Effect } from "effect";
import { createJiti } from "jiti";
import { ConfigLoadError, ConfigValidationError } from "../errors/errors.js";
import type { OdooAgenticDevConfig } from "../core/project-recipe.js";
import { normalizeConfig, validateConfigInput } from "./schema.js";

export const CONFIG_FILENAMES = [
  "odoo-agentic-dev.config.ts",
  "odoo-agentic-dev.config.mts",
  "odoo-agentic-dev.config.js",
  "odoo-agentic-dev.config.mjs",
] as const;

/** Walk from startDir upward; first directory containing a config file wins. */
export const discoverConfigPath = (startDir: string): string | undefined => {
  let dir = resolve(startDir);
  for (;;) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = join(dir, filename);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
};

const jiti = createJiti(import.meta.url, { interopDefault: true });

export const loadRecipe = (options: {
  readonly cwd: string;
  readonly explicitPath?: string;
  readonly env: Record<string, string | undefined>;
}): Effect.Effect<
  { readonly rootDir: string; readonly recipe: OdooAgenticDevConfig },
  ConfigLoadError | ConfigValidationError
> =>
  Effect.gen(function* () {
    const override = options.explicitPath ?? options.env["ODOO_WORKTREE_CONFIG"];
    const path =
      override !== undefined
        ? isAbsolute(override)
          ? override
          : resolve(options.cwd, override)
        : discoverConfigPath(options.cwd);

    if (path === undefined) {
      return yield* Effect.fail(
        new ConfigLoadError({
          path: options.cwd,
          reason: `No odoo-agentic-dev config found from ${options.cwd} upward (looked for ${CONFIG_FILENAMES.join(", ")})`,
        }),
      );
    }
    if (!existsSync(path)) {
      return yield* Effect.fail(new ConfigLoadError({ path, reason: "file does not exist" }));
    }

    const raw = yield* Effect.tryPromise({
      try: () => jiti.import(path, { default: true }),
      catch: (cause) => new ConfigLoadError({ path, reason: String(cause) }),
    });

    const recipe = yield* Effect.try({
      try: () => normalizeConfig(validateConfigInput(raw)),
      catch: (cause) => cause as ConfigValidationError,
    });

    return { rootDir: dirname(path), recipe };
  });
