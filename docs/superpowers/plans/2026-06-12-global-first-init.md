# Global-first install: local delegation, `init`, config gating — Implementation Plan

> **For agentic workers:** TDD per task (failing test → implement → pass). Conventions + verified Effect v4 facts: see the 2026-06-11 plan headers (Effect.catch not catchAll, TaggedError message getters, `.js`-suffix relative imports, pnpm only).

**Goal:** Make `pnpm add -g @basaltbytes/odoo-agentic-dev` the recommended install. The global `oad` delegates to a project-local installation when one exists (so per-project version pinning keeps working), `oad init` scaffolds a config in a fresh project, and config-requiring commands point at `init` when no config is found.

Gate before every commit: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm build && pnpm test`.

---

## Task D: local-install delegation

**Behavior:** At CLI startup, before argument parsing:
1. Skip entirely when `ODOO_AGENTIC_DEV_NO_DELEGATE=1` (shell `[[ -n ]]` semantics — empty string counts as unset).
2. Discover the project root via the existing `discoverConfigPath(cwd)` (config dir = project root). No config → no delegation.
3. From the project root, resolve `@basaltbytes/odoo-agentic-dev/package.json` with `createRequire` anchored at the root; local CLI = `dist/cli.js` next to it. Resolution failure → no delegation (run the current binary).
4. Compare `realpathSync` of the local CLI against the currently executing script — identical → we ARE the local install, run normally (this is the no-infinite-loop guard).
5. Otherwise `spawnSync(process.execPath, [localCli, ...process.argv.slice(2)], { stdio: "inherit" })`; mirror the child's exit code; if the child died from a signal, re-raise that signal on ourselves.

**Notes:**
- stdio inherit preserves stdout purity for `--json` / `--hook-json` flows.
- Delegation applies to every command including `--version` (a delegated `--version` reporting the LOCAL version is the correct, observable behavior).
- Bootstrap code path: a thin `src/delegate.ts` with a pure decision function (testable: given config path, resolved local path, self path → delegate or not) plus a small impure runner; cli.ts calls it first. The decision function is pure/total (plain); the runner deals with the OS.

**Files:** `src/delegate.ts` (new), `src/cli.ts` (call at top), `test/core/delegate.test.ts` (pure decision), `test/e2e/delegate.test.ts` (fixture: temp project with a config + a stub `node_modules/@basaltbytes/odoo-agentic-dev/{package.json,dist/cli.js}` that prints a marker and exits 7; assert the global dist/cli.js run with cwd in the fixture prints the marker and exits 7; assert `ODOO_AGENTIC_DEV_NO_DELEGATE=1` bypasses; assert no delegation outside a project).

## Task I: `oad init`

**Behavior:** `oad init [--id <id>] [--db-prefix <p>] [--odoo-version <v>] [--force] [--json]`
- Works without any existing config (it's a global command).
- Refuses when a config exists in cwd OR any ancestor (typed error naming the existing path) unless `--force` (force only overrides the *cwd* case; an ancestor config still refuses — nested configs are a footgun).
- Derivations (pure, unit-tested):
  - `projectId` from the folder name: lowercase, non-alphanumerics → `-`, collapse repeats, trim `-`; must start with a letter (prefix `odoo-` when it doesn't).
  - `dbPrefix` from the id: multi-word (`-`-separated) → initials (`kriss-laure` → `kl`); single word → the word truncated to 8 chars; must match `^[a-z][a-z0-9]*$`.
- Scaffold `odoo-agentic-dev.config.ts`: project { id, dbPrefix }, odoo { version (default "18.0" + "adjust" comment), addons: detect `./addons` dir, else emit `addons` placeholder with a comment to adjust }. Keep the file minimal — defaults are the product.
- Append `.odoo-agentic-dev/` to `.gitignore` (create if absent, skip if already listed).
- Print next steps: `pnpm add -D @basaltbytes/odoo-agentic-dev` (types for the config + hooks + delegation target), then `oad setup`.
- The generated config must pass the real loader (`loadRecipe`) — init proves it before reporting success.
- `--json`: `{ ok, command: "init", written: [paths], projectId, dbPrefix }`; failures `{ ok: false, command: "init", error: { tag, message } }` (same contract as eject).
- New `InitError` tagged error following errors.ts conventions.

**Files:** `src/commands/init.ts` (new), `src/core/init-template.ts` (pure derivations + renderer, new), `src/errors/errors.ts`, tests `test/core/init-template.test.ts` + `test/commands/init.test.ts`. Does NOT touch `src/cli.ts` (overseer wires).

## Task G (overseer): gating, wiring, README, release

- Wire `initCommand` into cli.ts with a description; e2e help test inherits it.
- No-config `ConfigLoadError` message gains: "Run `odoo-agentic-dev init` to create a config." (and `list`/`prune` keep mentioning `--all-projects`).
- README: Quickstart becomes global-first (`pnpm add -g`, `oad init`, `pnpm add -D` for types/hooks, `oad setup`); new "Global install & delegation" section (how delegation works, the no-delegate env var); Requirements unchanged.
- Bump `0.1.0-beta.4`, full gate, tag, push.
- Live verification: pack tarball, `pnpm add -g` it; inside KRISS LAURE `oad --version` must print the LOCAL beta.3 (delegation proof); outside any project it prints beta.4; `oad init` in a temp dir then `oad info` works on the scaffolded config.
