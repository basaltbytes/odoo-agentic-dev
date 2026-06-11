# Design: State Registry, GC, Fast Reset & Daily-Driver Commands

Date: 2026-06-11
Status: Approved design (brainstorm output, round 2)
Builds on: [`2026-06-10-odoo-agentic-dev-design.md`](./2026-06-10-odoo-agentic-dev-design.md) (v1, shipped)

## User Decisions

1. **State backend: `node:sqlite`** — zero dependencies; engines bump to `>=22.15`; the Node 22 `ExperimentalWarning` for SQLite is filtered in `cli.ts` (targeted `process.emitWarning` interception, nothing else suppressed); stable on Node 24.
2. **Auto-cleanup: opt-in** — recipe `cleanup: { maxAgeDays?: number; auto?: boolean }` (normalized defaults `{ maxAgeDays: 30, auto: false }`). Default behavior is warn-only.
3. **`prune` default target: gone branches/worktrees only.** Age-based pruning requires `--older-than`.
4. **Scope: full batch** — state + list/prune/auto-clean, template fast reset, doctor, logs/shell/psql, loopback bind, port-conflict failing fast, `--json` on lifecycle commands, nightly real-Odoo CI. Deferred: Odoo version adapters, npm publishing.

Style note (per owner preference): every fallible function returns `Effect.Effect<A, TaggedError>`; no thrown domain errors. All new modules follow this from the start.

## State Registry

**Location:** `${XDG_DATA_HOME:-~/.local/share}/odoo-agentic-dev/state.db`, overridable via `ODOO_AGENTIC_DEV_STATE_DB` (tests point it at temp files). Global — one DB indexes every project/worktree on the machine, which is what cross-worktree listing and GC require.

**Schema v1** (WAL mode; `schema_meta(version)` table for future migrations):

```sql
CREATE TABLE IF NOT EXISTS environments (
  compose_project TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  database_name   TEXT NOT NULL,
  root_dir        TEXT NOT NULL,
  worktree_name   TEXT NOT NULL,
  branch          TEXT,              -- NULL when detached / not a repo
  odoo_http_port  INTEGER NOT NULL,
  shared          INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,     -- ISO 8601 UTC
  last_used_at    TEXT NOT NULL,
  template_db     TEXT,              -- e.g. kl_feature_x__tpl
  template_key    TEXT               -- hash of (modules, withoutDemo, odoo.version)
);
```

Shared-branch note: shared branches map to one database name and therefore ONE compose project; the row records the most recent `root_dir`/`branch` that touched it and `shared = 1`.

**`StateStore` service** (`src/platform/state-store.ts`), new `StateError` tagged error:

```ts
export interface StateStoreApi {
  readonly upsert: (env: EnvironmentRow) => Effect.Effect<void, StateError>
  readonly touch: (composeProject: string) => Effect.Effect<void, StateError>
  readonly get: (composeProject: string) => Effect.Effect<EnvironmentRow | undefined, StateError>
  readonly list: (filter: { readonly projectId?: string | undefined }) => Effect.Effect<ReadonlyArray<EnvironmentRow>, StateError>
  readonly remove: (composeProject: string) => Effect.Effect<void, StateError>
  readonly setTemplate: (composeProject: string, meta: { readonly databaseName: string; readonly key: string } | null) => Effect.Effect<void, StateError>
}
```

Write points: `up`, `setup`, `reset-db`, `update`, `test` upsert + touch after context resolution; `down --volumes` removes the row (plain `down` only touches); `prune` removes rows with resources. Timestamps come from a `now()` injected via the service implementation (tests use a fixed clock).

**Drift-proofing (reconciliation).** The registry is an index, Docker is the truth:

- Generated compose stamps labels on both services and volumes: `dev.basaltbytes.oad=1`, `dev.basaltbytes.oad.project-id`, `.database`, `.root-dir`, `.branch`. Project-supplied compose files don't get labels; those environments are tracked by state rows alone (documented).
- `list`/`prune`/`doctor` reconcile: rows with no live compose project and no labeled volumes → status `vanished` (listed; `prune` offers row cleanup); labeled Docker stacks with no row → adopted into state on sight.
- Docker-side discovery: `docker compose ls -a --format json` for stack status; `docker volume ls --filter label=dev.basaltbytes.oad=1 --format json` for orphan volumes.

## Commands

### `list`

`odoo-agentic-dev list [--all-projects] [--json] [--config <path>]`

Default scope: the discovered project's `project.id`; `--all-projects` lists everything in state. Columns: branch/worktree, database, Odoo port, status (`running` / `stopped` / `vanished`), last-used (relative), shared marker, template marker. `--json` emits the full row + status array. Works without a config when `--all-projects` is passed.

### `prune`

`odoo-agentic-dev prune [--older-than <days>] [--all-projects] [--yes] [--allow-shared] [--json] [--config <path>]`

Pure decision function `classifyEnvironments(rows, dockerStacks, gitProbe)` returns per-row: `keep | gone-branch | gone-rootdir | vanished | stale`. Targets:

- default: `gone-branch` (root dir exists, is a repo, branch deleted — verified with `git -C rootDir rev-parse --verify --quiet refs/heads/<branch>`), `gone-rootdir` (root dir no longer exists), `vanished` (row-only cleanup)
- `--older-than <days>`: adds `stale` (last_used_at older than N days)

Execution: always print the kill list (stack, database, age, reason); act only with `--yes` (flags-only charter — without `--yes` it behaves as a dry run and exits 1 if candidates exist, 0 otherwise). Shared rows are skipped unless `--allow-shared`. Teardown is label-based so it works without the original compose file: `docker ps -aq --filter label=com.docker.compose.project=<name>` → `docker rm -f`, then `docker volume ls -q --filter label=com.docker.compose.project=<name>` → `docker volume rm`, then state row removal.

**Auto-cleanup hook:** at the end of `up` and `setup`: with `cleanup.auto = false` (default) print a one-line warning when candidates exist ("N stale environments — run `odoo-agentic-dev prune`"); with `auto = true`, run the prune routine for `gone-*`/`vanished` plus `stale > maxAgeDays`, never touching shared rows, printing what it removed.

### Template fast reset

Goal: repeat `reset-db` in seconds instead of minutes, for agent loops.

- Snapshot point: end of a successful full `reset-db`/`setup` **after post-init hooks**, so a restore reproduces the complete state with no hook re-runs.
- Snapshot: terminate sessions on `<db>`; `DROP DATABASE IF EXISTS "<db>__tpl"`; `CREATE DATABASE "<db>__tpl" TEMPLATE "<db>"`; filestore copy `cp -a /var/lib/odoo/filestore/<db> /var/lib/odoo/filestore/<db>__tpl` (guarded — filestore may not exist). `template_key = sha256-8(modules ‖ withoutDemo ‖ odoo.version ‖ JSON(postInit hooks))` recorded in state — hooks are baked into the snapshot, so changing them must invalidate it.
- Restore path (default when row has a template and the key matches): terminate sessions, drop `<db>`, `CREATE DATABASE "<db>" TEMPLATE "<db>__tpl"`, filestore copy back. Post-init hooks are NOT re-run (already baked in).
- Flags on `reset-db` (and honored by `setup`): `--no-template` (full init, keep template), `--refresh-template` (full init + new snapshot). Key mismatch → automatic full init + re-snapshot. `--modules`/`--without-demo` overrides imply the full-init path (the template wouldn't match).
- Limitation (documented): postgres is per-stack, so templates only accelerate resets within the same worktree.
- Template names always end in `__tpl`; `assertSafeDatabaseName` length budget accounts for the suffix (base name capped accordingly).

### `doctor`

`odoo-agentic-dev doctor [--json] [--config <path>]` — ✓/✗ report; exit non-zero if any hard check fails. Checks: docker CLI + daemon responsive; `docker compose version` is v2; Node >= 22.15; config discovery + validation (soft when absent); git available; context derivation (when config present); Odoo port free or holder identified (known stack from state vs unknown process); state DB openable + writable; WSL2 detection (`/proc/version` contains `microsoft`) with the PRD's guidance lines; count of prune candidates.

### Passthroughs

- `logs [service] [--follow]` → `compose logs [-f] <service|odoo>` (streamed).
- `shell` → `compose run --rm <odoo> odoo shell -d <db>` — interactive.
- `psql [-- <args>]` → `compose exec <db> psql -U odoo -d <database> <args>` — interactive.

Interactivity requires a third `CommandRunner` mode: `runInteractive(spec)` with full stdio inheritance (TTY passthrough), exit code returned. Implementation: `effect/unstable/process` if its options support stdio inherit; otherwise a thin `node:child_process.spawn(..., { stdio: "inherit" })` wrapped in `Effect.async` — chosen at implementation time, behavior pinned by tests (non-TTY: in/out passthrough + exit code).

## Hardening

- **Loopback bind:** generated compose port mapping becomes `"127.0.0.1:<port>:8069"`. README notes how to expose on LAN deliberately (project-supplied compose or future option).
- **Port conflict fail-fast (no silent probing — determinism is a feature):** before `up`'s compose call, a `PortProbe` service (`net.createServer` bind test on 127.0.0.1) checks the derived port. Busy + our stack already running → proceed (idempotent up). Busy otherwise → fail with new `PortConflictError` naming the holder when state knows it, suggesting `ODOO_HTTP_PORT` override or `prune`. `doctor` additionally reports port collisions among known stacks (two rows, same port).
- **New tagged errors:** `StateError`, `PortConflictError` — join `RuntimeError`, get `message` getters and `renderError` cases with next-actions.

## `--json` on lifecycle commands

`setup`, `up`, `down`, `reset-db`, `update`, `test` accept `--json`: suppress decorative output, emit one final JSON object `{ ok, command, database, composeProject, odooUrl, actions: string[], durationMs, exitCode? }`. `list`/`doctor`/`prune`/`info` have richer dedicated JSON shapes. Streaming child output still goes to stderr in json mode so the JSON on stdout stays parseable.

## Nightly real-Odoo CI

`.github/workflows/nightly.yml` — cron (daily) + `workflow_dispatch`, ubuntu, ~20 min budget: fixture project with `odoo:18` + `postgres:16`; `setup` (real `-i base` init); assert template snapshot exists (psql query); `reset-db` (must take the template path — assert via `--json` `actions`); `update base`; `down --volumes`; assert no leftover labeled containers/volumes. This is the first CI exercising real Odoo + the template machinery end to end.

Regular CI: `node-version` matrix `[22, 24]` (engines floor and current LTS).

## Packaging changes

`engines.node >= 22.15`. No new runtime dependencies (`node:sqlite`). New files: `src/platform/state-store.ts`, `src/platform/port-probe.ts`, `src/core/environment.ts` (row types + `classifyEnvironments` + template key), `src/commands/{list,prune,doctor,logs,shell,psql}.ts`; modified: compose-model (labels, loopback), odoo-lifecycle (template paths), command-runner (`runInteractive`), all lifecycle commands (state writes, `--json`), cli.ts (registration + warning filter), schema (cleanup config), README, CI.

## Testing

Same regime as v1: pure logic (classification, template keys, label generation, JSON shapes) unit-tested directly; `StateStore` tested against real temp SQLite files; command orchestration through the recording runner asserting exact docker argv sequences (label-based prune teardown, template snapshot/restore SQL); `PortProbe` tested with a real ephemeral listener; e2e: `list --json` and `doctor --json` against the built CLI; nightly covers the real-Odoo paths.

## Out of Scope (this round)

Odoo version adapters, npm publishing/changesets, LAN exposure options, cross-worktree template sharing, interactive prompts (still flags-only).
