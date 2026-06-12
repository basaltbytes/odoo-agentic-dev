# Agent UX Gaps & `eject` — Implementation Plan

> **For agentic workers:** execute task-by-task with strict TDD (failing test → implement → pass → commit per task). Conventions, architecture, and verified Effect v4 beta facts: see `docs/superpowers/plans/2026-06-11-odoo-agentic-dev-v1.md` header + "Post-plan notes for the executor" (Effect.catch not catchAll, TaggedError message getters, `.js`-suffix relative imports, `pnpm` only).

**Goal:** Close the three agent-friendliness gaps found in the 2026-06-12 audit (blank subcommand help, no consumer agent doc, no `--json` on mutating commands) and add an `eject` command that hands projects ownership of the generated Dockerfile/compose file and points the config at the ejected copies.

**Style law (owner mandate):** every fallible function returns `Effect.Effect<A, TaggedError>`; no thrown domain errors; total pure helpers stay plain.

Gate before every commit: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm build && pnpm test` (run `pnpm format` first when needed).

---

## Phase A — Agent UX gaps

### Task A1: Subcommand descriptions in `--help`

**Problem:** root `--help` lists 17 subcommands; only `run`, `compose`, `worktree` have descriptions. `--help` is the first command an agent runs.

**Files:** every `src/commands/*.ts` missing `Command.withDescription`, plus a new e2e assertion.

- [ ] Failing e2e test (`test/e2e/`): run `dist/cli.js --help`, parse the SUBCOMMANDS block, assert **every** listed subcommand has a non-empty description.
- [ ] Add `Command.withDescription` to: `info` ("print the derived context: database, ports, URLs, env"), `setup` ("prepare the worktree: deps, image, database, template snapshot"), `up` ("start Odoo + companion apps on the derived ports"), `down` ("stop this worktree's stack (--volumes to also delete data)"), `reset-db` ("drop and re-initialize this worktree's database"), `update` ("run odoo -u for the given modules"), `test` ("run odoo tests against this worktree's database"), `link-source` ("symlink a local Odoo checkout for editor navigation"), `list` ("list registered environments and their Docker status"), `prune` ("remove environments whose branches are gone (dry-run by default)"), `doctor` ("environment health report; exits 1 on hard failures"), `logs` ("tail service logs from this worktree's stack"), `shell` ("open an odoo shell bound to this worktree's database"), `psql` ("open psql against this worktree's database").
- [ ] Keep each description ≤ 72 chars so the help table stays readable.

### Task A2: `--json` on mutating commands

**Problem:** `setup`/`reset-db`/`update`/`test`/`down`/`up --detach` report success as prose; orchestrators must parse English or trust exit codes alone.

**Design (decided):**
- New `--json` flag on those six commands. In JSON mode, **stdout carries exactly one JSON object** (final line); all human/progress output — including streamed compose/odoo logs — goes to stderr. Reuse the stdout→stderr stream-swap mechanism `worktree create --hook-json` already proved.
- Success payload (shared core + per-command extras), extending `src/commands/json-report.ts`:
  `{ "ok": true, "command": "reset-db", "database": "...", "composeProjectName": "...", "odooHttpPort": 18095, "durationMs": 81000, ... }`
  - `setup`/`reset-db` add `"mode": "template-restore" | "full-init"` and `"templateKey"`.
  - `test` adds `"exitCode"`, `"stdoutTail"`, `"stderrTail"` (and `ok` mirrors exitCode === 0).
  - `down` adds `"volumesRemoved": boolean`.
- Failure payload: errors keep rendering to stderr and exit 1, **and** in JSON mode stdout gets `{ "ok": false, "command": "...", "error": { "tag": "<TaggedError _tag>", "message": "..." } }` so a parser never sees an empty stdout.
- `up` attached mode (long-running) rejects `--json` with a clear error pointing at `--detach`.

**Files:** `src/commands/{setup,reset-db,update,test,down,up}.ts`, `src/commands/json-report.ts`, e2e tests.

- [ ] Failing e2e tests first (fake-adapter runs asserting stdout is parseable JSON with the documented keys, and that a guard refusal in JSON mode yields `ok:false` + exit 1).
- [ ] Implement; verify no streamed subprocess output can leak to stdout in JSON mode.
- [ ] README: document the payloads in the Machine-Readable Output section.

### Task A3: Paste-ready agent doc for consumers

**Files:** `README.md`, new `docs/AGENTS-SNIPPET.md`.

- [ ] Write `docs/AGENTS-SNIPPET.md`: a ~30-line block consumers paste into their `CLAUDE.md`/`AGENTS.md`. Content: the five daily commands (`info --json`, `setup`, `up --detach`, `test`, `reset-db --yes`), the env contract (`run -- <cmd>` injects `ODOO_DATABASE`/`ODOO_BASE_URL`/companion vars — never hand-assemble env), "never call docker compose directly; use `odoo-agentic-dev compose --`", worktree hooks already manage create/remove, every command exits non-zero on failure and `--json` gives machine-readable results.
- [ ] README: new "For coding agents" section that inlines the snippet and tells maintainers to paste it into their agent config.
- [ ] KRISS LAURE follow-up (separate repo commit): paste the snippet into its `CLAUDE.md` and `AGENTS.md` if present.

---

## Phase B — `eject`

**Intent:** one command that converts "generated infra" into "project-owned infra": write the Dockerfile and/or compose file into the repo as normal files and update the config so the CLI uses them via the existing escape hatches (`odoo.dockerfile`, `compose.file`). No new runtime concepts — eject just automates stepping onto escape hatches that already exist and are already tested.

### Design decisions (settle here, not during implementation)

1. **Portable render, not file copy.** `.odoo-agentic-dev/compose.generated.yml` has the *current worktree's* database/port/env baked as literals. An ejected file must work across worktrees, so eject renders the same model in a **portable mode** that emits compose interpolations instead of literals:
   - command: `--database=${ODOO_DATABASE:?}`; ports: `127.0.0.1:${ODOO_HTTP_PORT:?}:8069`
   - environment block: each context key as `KEY: "${KEY:?}"` (the CLI already exports the full context env to every compose subprocess, so interpolation always resolves)
   - labels: keep `dev.basaltbytes.oad: "1"`, `project-id` (static literal), `database: "${ODOO_DATABASE}"`; **omit** `root-dir`/`branch` (not part of the exported env; registry still records them — `list`/`prune` are unaffected, only lost-row adoption loses those two hints for ejected stacks).
   - Implementation: `buildComposeModel(recipe, ctx, { portable: true })` (or a sibling builder) in `src/core/compose-model.ts`; unit-tested to contain zero baked database/port literals.
2. **Dockerfile eject** renders `renderDockerfile(...)` with the header swapped to `# Ejected from odoo-agentic-dev v<version> — this file is yours now.` If the config has neither `build` nor `dockerfile` (stock image), `eject dockerfile` fails with a typed error explaining there is nothing to eject (suggest `odoo.build` first).
3. **Default paths:** `Dockerfile.odoo` and `docker-compose.worktree.yml` (matching the conventions consumers already recognize); `--dockerfile-out` / `--compose-out` override. **Never overwrite an existing file** without `--force` (same rule as `link-source`).
4. **Config update — two modes:**
   - Default: print a precise, ready-to-apply patch to stdout (the exact keys to add/replace: `compose: { file: "docker-compose.worktree.yml" }`, and for dockerfile ejects `dockerfile: "Dockerfile.odoo"` **replacing** the `build: {...}` block — they are mutually exclusive). Our primary users are agents; a printed patch is reliable automation and preserves the user's comments/formatting.
   - `--write-config`: load the config through the existing loader, apply the changes to the validated input object, and regenerate `odoo-agentic-dev.config.ts` through a deterministic serializer. **Comments and formatting are lost** — say so in the output and refuse without `--force` if the file contains `//` or `/*` comments.
5. **Selectors:** `eject all` (default), `eject dockerfile`, `eject compose`. Ejecting compose alone keeps the generated Dockerfile in play only if the ejected compose references it — the portable render points its `build.dockerfile` at the *ejected* Dockerfile path when both are ejected, and at the existing config value otherwise.
6. **JSON mode:** `eject --json` reports `{ ok, written: [paths], configPatch: "...", configWritten: boolean }` (consistent with Task A2).

### Task B1: Portable compose render

- [ ] Failing unit tests: portable model contains `${ODOO_DATABASE:?}` in command, no literal database/port anywhere, labels per decision 1; YAML round-trips.
- [ ] Implement portable mode in `src/core/compose-model.ts`.

### Task B2: `eject` command

**Files:** `src/commands/eject.ts`, `src/errors/errors.ts` (new `EjectError` if needed), `src/cli.ts`, tests (`test/commands/eject.test.ts`, e2e overwrite-refusal case).

- [ ] Failing tests: writes both files with portable content; refuses existing targets without `--force`; prints the config patch; `--write-config` regenerates a loadable config that validates and points at the ejected files; `dockerfile` selector without `build`/`dockerfile` config fails typed.
- [ ] Implement command + wire into the CLI tree (with description, per Task A1).
- [ ] README: "Ejecting" section — when to eject (custom services, exotic networking, team preference for visible infra), what you keep (derivation, env injection, lifecycle, safety guards all still work — `compose.file` consumers get the full context env), what you give up (automatic infra upgrades from config changes; `odoo.build`/generated compose improvements no longer apply).

### Task B3: Release & verification

- [ ] Bump `0.1.0-beta.3`, full gate, commit, push, tag.
- [ ] Live verification in KRISS LAURE (without committing the eject there — KL stays on generated infra): run `eject` in a scratch checkout or with `--dockerfile-out/--compose-out` into a temp dir, `docker compose config -q` the ejected file with the context env exported, diff ejected Dockerfile against the deleted `Dockerfile.odoo` from git history (should be functionally identical).
- [ ] User publishes to npm (OTP from /tmp); refresh KL lockfile if KL adopts beta.3.

---

## Out of scope (explicitly)

- Editing arbitrary user TS with comment preservation (AST round-trip) — the printed patch covers it; revisit only if `--write-config` adoption shows demand.
- Ejecting an odoo.conf (the CLI does not generate one; db wiring/addons-path/list_db are CLI-provided flags, which keep working with ejected files).
- `eject` for companion apps / `.codex` / Claude hooks (already plain files in the consumer repo).
