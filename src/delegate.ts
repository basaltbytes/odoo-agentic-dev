/**
 * Local-install delegation. When a global `oad` runs inside a project that has
 * its own pinned copy of this package, hand off to that local CLI so per-project
 * version pinning keeps working.
 *
 * This is process bootstrap: it runs before the Command program is built, every
 * branch that can fail falls back to "don't delegate", and delegation must NEVER
 * crash the CLI. Plain sync code is the correct shape here (the Effect style law
 * exempts bootstrap) — the only Effect we touch is `discoverConfigPath`, a sync
 * Effect we run with `Effect.runSync`.
 */
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { Effect } from "effect";
import { discoverConfigPath } from "./config/load-recipe.js";

/** Decision produced by the pure helper: delegate to a CLI, or run ourselves. */
export type DelegationDecision =
  | { readonly delegate: true; readonly localCliPath: string }
  | { readonly delegate: false };

/**
 * Pure, total delegation decision. No filesystem, no process — given the path of
 * the currently running script, the resolved local CLI (or `undefined` when none
 * was found), and the raw value of the no-delegate env var, decide whether to
 * delegate. Bail out when: the env var is set non-empty (`[[ -n ]]` semantics);
 * no local CLI resolved; or the local CLI IS the running script (loop guard).
 */
export const decideDelegation = (inputs: {
  readonly selfPath: string;
  readonly localCliPath: string | undefined;
  readonly envValue: string | undefined;
}): DelegationDecision => {
  if (inputs.envValue !== undefined && inputs.envValue !== "") return { delegate: false };
  if (inputs.localCliPath === undefined) return { delegate: false };
  if (inputs.localCliPath === inputs.selfPath) return { delegate: false };
  return { delegate: true, localCliPath: inputs.localCliPath };
};

/**
 * Resolve the project-local CLI from a project root, or `undefined` when there is
 * no local install (or anything about the resolution throws). `createRequire`
 * anchored at the root resolves the package's own package.json; the CLI is
 * `dist/cli.js` next to it.
 */
const resolveLocalCli = (projectRoot: string): string | undefined => {
  try {
    const require = createRequire(join(projectRoot, "noop.js"));
    const pkgJson = require.resolve("@basaltbytes/odoo-agentic-dev/package.json");
    return join(dirname(pkgJson), "dist", "cli.js");
  } catch {
    return undefined;
  }
};

/** Real path of `p`, or `p` unchanged when it cannot be resolved (missing file). */
const realpathOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * Impure runner: cli.ts calls this synchronously before building the Command
 * program. When a project-local install is present and distinct from us, spawn
 * it with our argv and exit with its status — re-raising a killing signal on
 * ourselves so the parent shell observes the right disposition. When anything is
 * missing or throws, return so the current binary runs normally.
 */
export const delegateToLocalInstallIfPresent = (): void => {
  const envValue = process.env["ODOO_AGENTIC_DEV_NO_DELEGATE"];
  // cheap early-out before touching the filesystem
  if (envValue !== undefined && envValue !== "") return;

  const configPath = Effect.runSync(discoverConfigPath(process.cwd()));
  if (configPath === undefined) return;
  const projectRoot = dirname(configPath);

  const localCli = resolveLocalCli(projectRoot);
  // the running entry script (the cli.js node was launched with), NOT this
  // module — the loop guard compares the resolved local dist/cli.js against the
  // dist/cli.js we are currently executing. argv[1] is absent only in odd embed
  // cases; treat that as "no self" so we never delegate without a guard.
  const entryScript = process.argv[1];
  if (entryScript === undefined) return;
  const selfPath = realpathOr(entryScript);
  const localCliReal = localCli === undefined ? undefined : realpathOr(localCli);

  const decision = decideDelegation({ selfPath, localCliPath: localCliReal, envValue });
  if (!decision.delegate) return;

  const child = spawnSync(process.execPath, [decision.localCliPath, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  if (child.signal !== null) {
    process.kill(process.pid, child.signal);
    return;
  }
  process.exit(child.status ?? 0);
};
