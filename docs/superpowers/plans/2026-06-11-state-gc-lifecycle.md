# State Registry, GC, Fast Reset & Daily-Driver Commands — Implementation Plan

> **For agentic workers:** execute task-by-task with strict TDD (failing test → implement → pass → commit per task). Spec: `docs/superpowers/specs/2026-06-11-state-gc-lifecycle-design.md` — where this plan and the spec disagree, the spec wins. Conventions, architecture, and verified Effect v4 beta facts: see `docs/superpowers/plans/2026-06-11-odoo-agentic-dev-v1.md` header + "Post-plan notes for the executor" (Effect.catch not catchAll, honest fake-layer typing, TaggedError message getters, `.js`-suffix relative imports, `pnpm` only).

**Goal:** Global SQLite state registry with list/prune/auto-clean, template-based fast reset, doctor, logs/shell/psql passthroughs, loopback binding, port-conflict fail-fast, `--json` on lifecycle commands, nightly real-Odoo CI.

**Style law (owner mandate):** every fallible function returns `Effect.Effect<A, TaggedError>`; no thrown domain errors; total pure helpers stay plain.

**New v4 fact verified for this round:** `ChildProcess` `CommandOptions` accept `stdin/stdout/stderr: "inherit"` (`CommandInput`/`CommandOutput` unions) — `runInteractive` needs no fallback.

Gate before every commit: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm build && pnpm test` (run `pnpm format` first when needed).

---

### Task 1: Engines bump, warning filter, new errors, template name headroom

**Files:** `package.json`, `.github/workflows/ci.yml`, `src/cli.ts`, `src/errors/errors.ts`, `src/core/database-name.ts` + tests.

1. `package.json`: `engines.node` → `">=22.15"`. CI `checks` matrix gains `node: [22, 24]` (combine with the 3-OS matrix; pass `node-version: ${{ matrix.node }}`).
2. `src/cli.ts` (very top, before anything imports `node:sqlite` transitively): filter ONLY the SQLite ExperimentalWarning —
   ```ts
   const originalEmitWarning = process.emitWarning.bind(process)
   process.emitWarning = ((warning: string | Error, ...rest: ReadonlyArray<never>) => {
     const text = typeof warning === "string" ? warning : warning.message
     if (text.includes("SQLite is an experimental feature")) return
     return (originalEmitWarning as (...args: ReadonlyArray<unknown>) => void)(warning, ...rest)
   }) as typeof process.emitWarning
   ```
3. `src/errors/errors.ts`: add `StateError { reason: string }` and `PortConflictError { port: number; holder: string | null }` — tagged classes with `message` getters, `renderError` cases (PortConflict next-action: name the holder stack when non-null; suggest `ODOO_HTTP_PORT` override or `odoo-agentic-dev prune`), add to `RuntimeError` union + `RUNTIME_ERROR_TAGS`.
4. `src/core/database-name.ts`: derived-name truncation now targets **58** chars (slice 49 + `_` + 8-char hash) so `__tpl` (5 chars) fits within PostgreSQL's 63. Export `TEMPLATE_SUFFIX = "__tpl"` from `src/core/environment.ts` (Task 2) — here just change the truncate budget and update `test/core/database-name.test.ts` length expectations (63 → 58, slice boundary 54 → 49). Explicit env-override names stay validated at ≤63 (template logic will skip names > 58 — Task 6).
5. TDD where applicable (error rendering tests, truncation tests first). Commit: `feat: engines >=22.15, sqlite warning filter, StateError/PortConflictError, template name headroom`.

### Task 2: `src/core/environment.ts` (pure)

**Files:** `src/core/environment.ts`, `test/core/environment.test.ts`.

Exports (all pure/total except none — no IO here):
- `type EnvironmentRow` mirroring the spec's SQL schema (camelCase fields, `branch: string | null`, `templateDb/templateKey: string | null`, ISO string timestamps).
- `TEMPLATE_SUFFIX = "__tpl"`, `templateDbName(db: string): string`.
- `computeTemplateKey(recipe: OdooAgenticDevConfig): string` — sha256-8 of `JSON.stringify([initialModules, withoutDemo, odoo.version, postInit])`.
- `type EnvStatus = "running" | "stopped" | "vanished"` and `type PruneReason = "keep" | "gone-branch" | "gone-rootdir" | "vanished" | "stale" | "shared-skipped"`.
- `classifyEnvironments(input: { rows; dockerProjects: ReadonlyArray<{ name: string; running: boolean }>; probes: ReadonlyMap<string, { rootDirExists: boolean; branchExists: boolean | null }>; olderThanDays: number | null; allowShared: boolean; now: string })` → per-row `{ row; status: EnvStatus; reason: PruneReason }`. Rules: docker project present → running/stopped; absent → vanished. Prune reasons in priority order: shared && !allowShared → `shared-skipped`; vanished → `vanished`; !rootDirExists → `gone-rootdir`; branchExists === false → `gone-branch`; olderThanDays set && lastUsedAt older → `stale`; else `keep`. (`branchExists: null` = not a repo / detached row → only prunable via rootdir/stale rules.)
- `decideResetPath(input: { row: EnvironmentRow | undefined; expectedKey: string; databaseName: string; noTemplate: boolean; refreshTemplate: boolean; hasOverrides: boolean })` → `"restore" | "full" | "full-then-snapshot"`. Rules: overrides → `full`; refreshTemplate → `full-then-snapshot`; noTemplate → `full`; row?.templateDb set && row.templateKey === expectedKey && databaseName length ≤ 58 → `restore`; otherwise `full-then-snapshot` (snapshot skipped at runtime when name > 58 — return `full` in that case).
- Exhaustive table-driven tests (PRD-style: every branch of both decision functions).

Commit: `feat: environment classification and reset-path decision core`.

### Task 3: `StateStore` service over node:sqlite

**Files:** `src/platform/state-store.ts`, `src/testing/fake-adapters.ts` (add `makeFakeStateStore` backed by an in-memory Map), `test/platform/state-store.test.ts`.

- Service `StateStore = Context.Service<StateStoreApi>("odoo-agentic-dev/StateStore")` with the spec's API (`upsert`, `touch`, `get`, `list({projectId?})`, `remove`, `setTemplate`). All methods `Effect.Effect<_, StateError>`.
- `StateStoreLive = Layer.effect(StateStore, ...)`: resolve path `process.env.ODOO_AGENTIC_DEV_STATE_DB ?? join(XDG_DATA_HOME ?? ~/.local/share, "odoo-agentic-dev/state.db")`; mkdir -p parent; `new DatabaseSync(path)`; `PRAGMA journal_mode=WAL`; create `schema_meta` + `environments` per the spec SQL; seed `schema_meta` version 1. Every sqlite call wrapped in `Effect.try` → `StateError`. Timestamps: live layer uses `new Date().toISOString()` internally for `touch`/`upsert` default `lastUsedAt` — accept an optional `now` field on upsert input so tests inject fixed clocks (document: callers normally omit it).
- Import via `import { DatabaseSync } from "node:sqlite"` (works unflagged on 22.15+; warning filtered in cli.ts; tests run under vitest where the warning is harmless noise).
- Tests against real temp sqlite files (`ODOO_AGENTIC_DEV_STATE_DB` per-test tmp path): schema creation idempotence, upsert/get round-trip, touch bumps lastUsedAt only, list project filter + all, remove, setTemplate(null) clears, two sequential layers over the same file see each other's writes (WAL persistence), corrupt-path failure surfaces StateError.

Commit: `feat: SQLite-backed StateStore service with WAL and env-overridable path`.

### Task 4: Compose labels, loopback bind, PortProbe

**Files:** `src/core/compose-model.ts`, `src/platform/port-probe.ts`, fake in `src/testing/fake-adapters.ts` (`makeFakePortProbe(busyPorts: Set<number>)`), tests.

1. `compose-model.ts`: `buildComposeModel` adds to BOTH services and BOTH volumes: labels `dev.basaltbytes.oad: "1"`, `dev.basaltbytes.oad.project-id`, `dev.basaltbytes.oad.database`, `dev.basaltbytes.oad.root-dir`, `dev.basaltbytes.oad.branch` (empty string when no branch). Needs `branch` available → extend the function signature to `buildComposeModel(recipe, ctx, meta: { branch: string | null })` and thread from callers (prepareComposeFile gains the same param; callers pass git state via ctx... NOTE: `WorktreeContext` does not carry branch — add `readonly branch: string | null` to `WorktreeContext` in `src/core/worktree-context.ts` (set from git state; `ODOO_WORKTREE_NAME` override does NOT count as a branch) and update its tests; then compose-model reads `ctx.branch` and no signature change is needed. Choose this.)
2. Port mapping becomes `"127.0.0.1:${ctx.odooHttpPort}:8069"`. Update compose tests (labels present on services+volumes, loopback mapping, YAML round-trip still parses).
3. `src/platform/port-probe.ts`: `PortProbe = Context.Service<PortProbeApi>` with `isFree(port: number): Effect.Effect<boolean>` (never fails — bind errors mean "not free"). Live: `node:net` createServer, listen on `127.0.0.1:port`, close; wrap in `Effect.async`. Test with a real ephemeral listener: grab a port via listen(0), assert isFree=false while held, true after close.

Commit: `feat: compose labels + loopback binding and PortProbe service`.

### Task 5: State integration into lifecycle commands + auto-clean hook

**Files:** `src/config/schema.ts` (+types in `project-recipe.ts`), `src/commands/state-hooks.ts` (new), `src/commands/{up,setup,down,reset-db,update,test}.ts`, `src/cli.ts` (StateStoreLive + PortProbeLive in layers), tests (`test/commands/state-hooks.test.ts` + extend existing command tests with fake state store).

1. Recipe: `cleanup?: { maxAgeDays?: number; auto?: boolean }` → normalized `{ maxAgeDays: 30, auto: false }`. Schema + normalize + tests.
2. `src/commands/state-hooks.ts`:
   - `rowFromContext(recipe, ctx): EnvironmentRow` (pure; `shared` = isSharedDatabase; `branch` = ctx.branch).
   - `recordEnvironment(recipe, ctx): Effect<_, StateError, StateStore>` — upsert (insert-or-touch semantics: preserve createdAt/template on existing rows; implement via StateStore.upsert doing `ON CONFLICT ... UPDATE last_used_at/root_dir/branch/port` — adjust Task 3 SQL accordingly if not already).
   - `warnOrAutoClean(recipe, ctx): Effect<...>` — list rows for project, classify (probes built from `existsSync` + `Git.branchExists` — see Task 7 item 1; until Task 7 lands, implement with rootDir existence only and a TODO-free reduced rule set: vanished/stale/gone-rootdir), then per `cleanup.auto`: warn line or invoke prune routine (Task 7 exports it; in THIS task only the warn path is wired — auto path is completed in Task 7 and tested there. Structure the function so Task 7 fills one branch.)
3. Command wiring: `up` — after resolveContext: port check (`PortProbe.isFree`; if busy: query docker compose ls for our own project name (via DockerCompose — add `listProjects(): Effect<Array<{name, running}>, ComposeCommandError>` wrapping `docker compose ls -a --format json`, recording-runner tested); ours running → proceed; else fail `PortConflictError` with holder = state row matching that port, if any); then `recordEnvironment`; after successful up: `warnOrAutoClean`. `setup`: recordEnvironment + warnOrAutoClean at end. `reset-db`/`update`/`test`: `recordEnvironment` (touch semantics). `down`: plain → touch; `--volumes` → `StateStore.remove` after successful teardown.
4. Existing command tests gain `makeFakeStateStore` + `makeFakePortProbe` layers; new assertions: up records row; down --volumes removes; port conflict fails with holder name; conflict with own running stack proceeds.

Commit: `feat: lifecycle commands record state; port-conflict fail-fast; cleanup config`.

### Task 6: Template fast reset

**Files:** `src/core/command-plan.ts`, `src/platform/odoo-lifecycle.ts`, `src/commands/reset-db.ts`, `src/commands/setup.ts`, tests.

1. `command-plan.ts` (pure + tests): `createFromTemplateSql(db, tpl)` → `CREATE DATABASE "db" TEMPLATE "tpl"`; `copyFilestoreArgs(odooService, from, to)` → `["run","--rm","--no-deps","--entrypoint","/bin/sh",svc,"-c","rm -rf /var/lib/odoo/filestore/<to> && if [ -d /var/lib/odoo/filestore/<from> ]; then cp -a /var/lib/odoo/filestore/<from> /var/lib/odoo/filestore/<to>; fi"]`.
2. `odoo-lifecycle.ts` two new methods (docker-only; no state access — commands orchestrate state):
   - `snapshotTemplate(recipe, ctx)`: ensure db service ready → terminate sessions on `<db>` → drop `<tpl>` → `CREATE ... TEMPLATE <db>` → filestore copy db→tpl. Fails `OdooCommandError`/`ComposeCommandError`.
   - `restoreFromTemplate(recipe, ctx)`: ensure ready → terminate on `<db>` → drop `<db>` → create from template → filestore copy tpl→db.
   - Recording-runner tests assert exact SQL/argv sequences for both.
3. `reset-db.ts`: flags `--no-template`, `--refresh-template`. Flow: guard → `StateStore.get(composeProject)` → `decideResetPath({row, expectedKey: computeTemplateKey(recipe), databaseName, noTemplate, refreshTemplate, hasOverrides: modules/withoutDemo flags present})` →
   - `restore`: `lifecycle.restoreFromTemplate` (hooks NOT re-run), print "restored from template".
   - `full`: existing full path (reset + hooks); template row untouched.
   - `full-then-snapshot`: full path, then `lifecycle.snapshotTemplate` + `StateStore.setTemplate(project, {databaseName: tplName, key})`.
4. `setup.ts`: same flags, same decision for its reset-db step.
5. Tests: command-level with fakes — each path's service-call sequence; state setTemplate written only on snapshot path; overrides force `full`; key mismatch forces `full-then-snapshot`; restore skips hooks.

Commit: `feat: template-based fast database reset with keyed invalidation`.

### Task 7: `list`, `prune`, `doctor`

**Files:** `src/platform/git.ts` (+`branchExists`), `src/platform/docker-compose.ts` (+`listProjects` if not in Task 5, +`removeByLabel(projectName)` teardown), `src/commands/{list,prune,doctor}.ts`, `src/commands/state-hooks.ts` (complete auto-clean), `src/cli.ts`, tests.

1. `Git.branchExists(rootDir, branch): Effect<boolean, GitError>` — `git -C rootDir rev-parse --verify --quiet refs/heads/<branch>`, exit 0 → true, exit 1 → false, other → GitError. FakeGit extended.
2. `DockerCompose.removeByLabel(composeProject)`: `docker ps -aq --filter label=com.docker.compose.project=<p>` → if ids: `docker rm -f <ids>`; `docker volume ls -q --filter label=com.docker.compose.project=<p>` → if names: `docker volume rm <names>`. Recording tests with scripted id outputs.
3. `list.ts`: `--all-projects`, `--json`, `--config`. Resolve project id from config when present (без config + no --all-projects → ConfigLoadError as usual). Rows from state + `listProjects()` reconciliation → status; adoption: labeled docker projects absent from state get inserted (best-effort fields from labels via `docker ps --filter label=dev.basaltbytes.oad=1 --format json` — add `DockerCompose.listLabeledContainers()`; keep adoption simple: project name, database, root-dir, branch labels). Text table (plain padded columns, no dep) + `--json` (rows with status). Touches nothing.
4. `prune.ts`: flags per spec (`--older-than <days>` integer Flag, `--all-projects`, `--yes`, `--allow-shared`, `--json`, `--config`). Build probes per row (rootDir existsSync wrapped in Effect; branchExists via Git when rootDir exists and branch non-null). `classifyEnvironments` → candidates (reason ≠ keep/shared-skipped). Print kill list with reasons; exit 1 without `--yes` when candidates exist (0 when none); with `--yes`: per candidate — vanished → row delete only; others → `removeByLabel` + row delete; report summary. Export the core routine as `runPrune(options): Effect<PruneReport, ...>` for reuse by auto-clean.
5. Complete `warnOrAutoClean` (Task 5 stub): auto=true → `runPrune({olderThanDays: cleanup.maxAgeDays, yes: true, allowShared: false, projectId})`, print report.
6. `doctor.ts`: checks per spec, each `{ name, ok, hard, detail }`: docker daemon (`docker version` exit), compose v2 (`docker compose version` stdout contains "v2"), node ≥ 22.15 (process.versions), config discovery+validation (soft), context derivation (soft, when config), port free / holder (PortProbe + state), state DB open+write (StateStore.list), git present, WSL detection (`/proc/version` read, soft, prints PRD guidance), prune-candidate count (soft). Text ✓/✗ + `--json`; exit 1 if any hard check fails. Tests with fakes for each failure mode + e2e smoke in Task 9.
7. Register all three commands; cli layers gain nothing new beyond Task 5's additions.

Commit: `feat: list, prune, and doctor commands with docker reconciliation`.

### Task 8: Interactive passthroughs

**Files:** `src/platform/command-runner.ts` (+`runInteractive`), `src/testing/fake-adapters.ts`, `src/commands/{logs,shell,psql}.ts`, `src/cli.ts`, tests.

1. `CommandRunnerApi.runInteractive(spec: ExecSpec): Effect<number, CommandFailedError>` — `ChildProcess.make(cmd, args, { cwd, env, extendEnv: true, stdin: "inherit", stdout: "inherit", stderr: "inherit" })`, await exitCode. Live test: `node -e "process.exit(7)"` returns 7 (stdio inherit works headless). Fake runner records and returns scripted exit code.
2. `logs.ts`: optional service argument (default odoo service), `--follow`; via `compose.stream(ref, ["logs", ...(follow?["-f"]:[]), svc])`.
3. `shell.ts`: `runInteractive` with argv `docker compose -p .. -f .. --project-directory .. run --rm <odoo> odoo shell -d <db>` (compose run allocates a TTY when attached). `psql.ts`: `... exec <dbService> psql -U odoo -d <database>` + passthrough args after `--` if the cli library supports trailing args (check `Argument` variadic in effect/unstable/cli; if awkward, ship without passthrough args this round and note it). Exit code propagated to process.exitCode.
4. Both record/touch state (`recordEnvironment`). Tests: argv construction via fakes; exit-code propagation.

Commit: `feat: logs, shell, and psql passthrough commands with interactive runner`.

### Task 9: `--json` on lifecycle commands, docs, nightly CI, acceptance

**Files:** `src/commands/json-report.ts` (new), all lifecycle commands, `README.md`, `.github/workflows/nightly.yml`, `test/e2e/cli.test.ts`, `scripts/docker-integration.sh` (extend lightly).

1. `json-report.ts`: tiny helper — commands collect `actions: string[]` and on `--json` print a single `{ ok, command, database, composeProject, odooUrl, actions, durationMs }` to stdout (durations via `Date.now()` at command start/end), decorative `Console.log` suppressed (pass a `say(line)` that either logs or records into actions). Apply to setup/up/down/reset-db/update/test (reset-db's actions must include `"restore-from-template"` or `"full-init"`+`"snapshot-template"` — nightly asserts this). Streamed child output goes to stderr when `--json` (CommandRunner spec gains `stderrOnly?: boolean` for runInherited, or simpler: commands pass prefix-less inherited streams as-is and we document stdout-purity only for the final object — choose the SIMPLE option: in `--json` mode use captured `run` instead of `stream` for compose calls where feasible, else document. Keep pragmatic; e2e asserts `info/list/doctor/prune --json` purity, lifecycle `--json` asserts last-line-is-JSON.)
2. e2e additions: `list --json` (after an `up`-less `info` the state is empty → `[]`; then assert shape), `doctor --json` (runs, has checks array — docker may be absent on runner: doctor must still exit per hard-check semantics; assert structure not success), bare `prune` exits 0 with no candidates.
3. README: new commands section (list/prune/doctor/logs/shell/psql), cleanup config, template reset semantics + `--no-template`/`--refresh-template`, loopback note (+ how to expose deliberately), state file location + override env, engines >=22.15, prune safety contract.
4. `nightly.yml`: cron `0 3 * * *` + workflow_dispatch; ubuntu; pnpm install + build; fixture (odoo:18, postgres:16, dbPrefix `nt`, initialModules `["base"]`); `setup --json` → assert actions include snapshot-template; psql-in-container assert `nt_..__tpl` exists; `reset-db --json` → assert actions include restore-from-template; `update base`; `down --volumes`; assert `docker ps -aq --filter label=dev.basaltbytes.oad=1` empty and labeled volumes gone; 25-min timeout.
5. Acceptance sweep against the spec's sections — each feature: evidence (test name or e2e). Fix gaps. Full gate. Commit: `feat: json reports, docs, nightly real-Odoo workflow`.

---

## Execution notes

- Batches: A = Tasks 1–3, B = 4–6, C = 7–8, D = 9. Full gate between batches; orchestrator reviews diffs + suite.
- The recording CommandRunner fake gains `runInteractive` in Task 8 — until then no command calls it.
- `docker compose ls -a --format json` shape: array of `{ Name, Status, ConfigFiles }` (Status like "running(2)"/"exited(2)") — parse leniently (`running` prefix check), recording tests script the JSON.
- Don't touch `technical-prd.md` or prior spec/plan docs.
