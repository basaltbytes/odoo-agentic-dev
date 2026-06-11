# @basaltbytes/odoo-agentic-dev

`odoo-agentic-dev` (short alias: `oad`) is an agent-friendly local Odoo development runtime. From the current Git worktree it derives a deterministic database name, deterministic ports, and a namespaced Docker Compose project, then drives the full lifecycle around them: set up a fresh checkout, start Odoo and PostgreSQL, reset and re-initialize the database, update modules, run tests, and start optional companion apps such as a Vite PWA — each branch, agent session, or bug reproduction gets its own isolated stack that cannot collide with the others.

Projects describe themselves with one typed recipe file (`odoo-agentic-dev.config.ts`) instead of copied shell scripts and Compose files. The CLI is built for non-interactive use: flags replace prompts, output is deterministic, `info --json` exposes the whole resolved context to tooling, and destructive actions are guarded so a coding agent (or a tired human) cannot accidentally delete a shared database.

## Requirements

- Node.js 22.15 or newer (the state registry uses the built-in `node:sqlite` — no native dependency)
- [pnpm](https://pnpm.io)
- Docker (Docker Desktop on macOS, Docker Engine on Linux) — `info` works without it
- Windows: **WSL2 only**. Native PowerShell / `cmd.exe` execution is not supported in v1.

WSL2 guidance:

- clone repositories inside the WSL filesystem, not under `/mnt/c`
- install Node, package manager, Git, and Docker CLI inside WSL
- enable Docker Desktop WSL integration
- pass paths as Linux paths

## Quickstart

```bash
pnpm add -D @basaltbytes/odoo-agentic-dev
```

Create `odoo-agentic-dev.config.ts` at the project root (also accepted: `.mts`, `.js`, `.mjs` — `.ts` configs load directly, no precompilation needed). For an Odoo-only project:

```ts
import { defineConfig } from "@basaltbytes/odoo-agentic-dev";

export default defineConfig({
  project: {
    id: "billing-odoo",
    dbPrefix: "billing",
    sharedDatabase: "billing_dev",
    sharedBranches: ["main", "develop"]
  },

  odoo: {
    version: "18.0",
    dockerfile: "Dockerfile",
    configFile: "config/odoo.conf",
    addons: [
      { host: "addons", container: "/mnt/extra-addons/custom" }
    ]
  },

  database: {
    initialModules: ["billing_core"]
  }
});
```

For a KRISS LAURE-like monorepo with a frontend companion app:

```ts
import { defineConfig } from "@basaltbytes/odoo-agentic-dev";

export default defineConfig({
  project: {
    id: "kriss-laure",
    dbPrefix: "kl",
    sharedDatabase: "kl_e2e_demo",
    sharedBranches: ["main", "master", "dev", "develop", "development"]
  },

  ports: {
    odooBase: 18069,
    companionBase: 28028,
    range: 1000,
    hashAlgorithm: "posix-cksum"
  },

  odoo: {
    version: "18.0-20250606",
    serviceName: "odoo",
    databaseServiceName: "db",
    configFile: "config/odoo.worktree.conf",
    dockerfile: "Dockerfile.odoo",
    imageName: "krisslaure-odoo-agentic-dev",
    addons: [
      { host: "backend/addons/Custom", container: "/mnt/extra-addons/Custom" },
      { host: "backend/addons/OCA", container: "/mnt/extra-addons/OCA" }
    ]
  },

  database: {
    initialModules: ["KL_setup", "KL_payment_demo"],
    withoutDemo: "all",
    postInit: [
      { type: "odoo-shell-file", file: "scripts/odoo-agentic-dev/post-init.py" }
    ]
  },

  setup: {
    submodules: true,
    packageManagers: [
      { cwd: ".", command: "pnpm", args: ["install"] },
      { cwd: "frontend", command: "pnpm", args: ["install"] }
    ]
  },

  companionApps: [
    {
      name: "pwa",
      cwd: "frontend",
      command: "pnpm",
      args: ["dev", "--host", "0.0.0.0", "--strictPort"],
      portEnv: "PWA_PORT",
      urlEnv: "E2E_BASE_URL",
      env: {
        VITE_SERVICE_API_URL: "",
        VITE_ODOO_DATA_BASE_NAME: "$ODOO_DATABASE",
        VITE_E2E_PROXY_API_URL: "$ODOO_BASE_URL"
      }
    }
  ]
});
```

Ports are derived from a hash of the database name modulo `ports.range`. The default hash is FNV-1a 32-bit (`hashAlgorithm: "fnv1a32"`); set `hashAlgorithm: "posix-cksum"` to reproduce the POSIX `cksum` CRC so a project migrating from bash tooling that derives ports via `cksum <<< "$db"` keeps the exact same port per database.

Database names are derived from the branch: at most **one** leading type segment (`feature`, `feat`, `bugfix`, `bug`, `hotfix`, `fix`, `chore`, `task`) is stripped — `feature/fix/x` becomes `<dbPrefix>_fix_x` — then the remainder is sanitized and prefixed with `project.dbPrefix`. Set `project.stripBranchPrefixes` (for example `["release"]`) to replace the built-in list.

Then:

```bash
pnpm exec odoo-agentic-dev setup   # prepare the worktree (deps, image, database)
pnpm exec odoo-agentic-dev up      # start Odoo + companion apps
pnpm exec odoo-agentic-dev info    # inspect the derived context at any time
```

## Commands

Every command accepts `--config <path>` to point at an explicit recipe file; otherwise the recipe is discovered from the current working directory upward.

### `odoo-agentic-dev info`

Print the resolved worktree context (worktree name, database, Compose project, Odoo URL, companion URLs) without starting containers. Works without Docker running and is deterministic for the same branch and recipe.

| Flag | Meaning |
| --- | --- |
| `--json` | print machine-readable JSON |
| `--env` | print `KEY=value` env lines |
| `--config <path>` | explicit config file path |

### `odoo-agentic-dev setup`

Prepare a new worktree: initialize Git submodules (if the recipe asks for it), run the recipe's package manager install steps, ensure the Docker image builds, reset and initialize the current worktree database, run post-init hooks, and print URLs. It prints the resolved database before destructive work and never deletes a shared database by default. The database step honors the same template fast-reset semantics as `reset-db` (see below).

| Flag | Meaning |
| --- | --- |
| `--skip-install` | skip submodule + package manager steps |
| `--skip-db` | skip database reset/initialization |
| `--allow-shared` | permit acting on the shared database |
| `--no-template` | full init even when a template snapshot exists (template kept) |
| `--refresh-template` | full init and take a fresh template snapshot |
| `--json` | suppress decorative output; print one final JSON report line |
| `--config <path>` | explicit config file path |

### `odoo-agentic-dev up`

Start Odoo (and PostgreSQL) on the derived port, then the configured companion apps with context-derived env injected (`ODOO_DATABASE`, `ODOO_BASE_URL`, per-app ports). In attached mode, Ctrl-C stops all child processes and the first failing process is reported.

Before starting anything, `up` probes the derived Odoo port. If it is busy and the holder is not this worktree's own already-running stack (idempotent `up`), it fails fast with a `PortConflictError` naming the holder stack when the state registry knows it — set `ODOO_HTTP_PORT` to override, or `prune` stale environments.

| Flag | Meaning |
| --- | --- |
| `--odoo-only` | skip companion apps |
| `--no-build` | start containers without rebuilding the image |
| `--logs` | follow Odoo logs after start |
| `--detach` | start containers and return |
| `--json` | suppress decorative output; print one final JSON report line |
| `--config <path>` | explicit config file path |

### `odoo-agentic-dev down`

Stop the current worktree stack. Uses the derived Compose project name, so other worktrees are never affected. A plain `down` keeps the environment in the state registry (only refreshing its last-used time); `down --volumes` removes the registry row along with the volumes.

| Flag | Meaning |
| --- | --- |
| `--volumes` | also remove this worktree's volumes (guarded for shared databases) |
| `--allow-shared` | permit acting on the shared database |
| `--json` | suppress decorative output; print one final JSON report line |
| `--config <path>` | explicit config file path |

### `odoo-agentic-dev reset-db`

Delete and recreate the current worktree database and filestore, terminate active database sessions first, install the initial modules, and run post-init hooks. Refuses unsafe database names.

| Flag | Meaning |
| --- | --- |
| `--allow-shared` | permit resetting the shared database |
| `--modules <list>` | comma-separated module list (defaults to the recipe's `initialModules`) |
| `--without-demo <mode>` | demo-data mode passed straight to Odoo's `--without-demo` |
| `--no-template` | full init even when a template snapshot exists (template kept) |
| `--refresh-template` | full init and take a fresh template snapshot |
| `--json` | suppress decorative output; print one final JSON report line |
| `--config <path>` | explicit config file path |

Demo data is controlled at database initialization time, not per test run. The recipe's `database.withoutDemo` sets the default: a string mode (for example `"all"`) is passed to Odoo's `--without-demo`, while `withoutDemo: false` omits the flag entirely so Odoo installs demo data. The `--without-demo <mode>` flag overrides the recipe for one reset, passing the mode string straight through to Odoo.

#### Template fast reset

The first successful full init (from `setup` or `reset-db`) is snapshotted — after the post-init hooks — as a PostgreSQL template database named `<database>__tpl` plus a filestore copy. Subsequent `reset-db` runs restore from that template in seconds instead of re-running module installation; post-init hooks are **not** re-run on restore because their effects are baked into the snapshot.

Snapshots carry a key derived from `initialModules`, `withoutDemo`, `odoo.version`, and the `postInit` hooks. Changing any of these invalidates the template: the next `reset-db` automatically falls back to a full init and takes a fresh snapshot. One-off `--modules`/`--without-demo` overrides always force a full init without touching the stored template.

- `--no-template` forces a full init for one run, keeping the existing snapshot.
- `--refresh-template` forces a full init and replaces the snapshot.
- PostgreSQL is per-stack, so templates only accelerate resets within the same worktree.
- Database names are budgeted so `<database>__tpl` fits PostgreSQL's 63-char identifier limit (derived names are capped at 58 chars); an explicitly overridden name longer than 58 chars simply skips snapshotting.

### `odoo-agentic-dev update <modules>`

Update modules in the current worktree database. Starts PostgreSQL if needed, stops Odoo before the update when needed, and restarts Odoo after a successful update unless `--no-restart` is passed.

```bash
pnpm exec odoo-agentic-dev update KL_setup
pnpm exec odoo-agentic-dev update KL_base,KL_sale,KL_stock
```

| Flag | Meaning |
| --- | --- |
| `--no-restart` | do not restart Odoo after the update |
| `--json` | suppress decorative output; print one final JSON report line |
| `--config <path>` | explicit config file path |

### `odoo-agentic-dev test`

Run Odoo tests against the current worktree database. Options map to Odoo CLI flags, the exit code is non-zero on test failure, and recipes may define reusable test profiles (`test.profiles`) selected with `--profile`.

| Flag | Meaning |
| --- | --- |
| `--tags <tags>` | Odoo `--test-tags` value |
| `--file <path>` | Odoo `--test-file` value |
| `--module <name>` | restrict tests to a module |
| `--log-level <level>` | Odoo log level |
| `--profile <name>` | recipe-defined test profile (extra Odoo args) |
| `--include-demo` | accepted for compatibility; demo data is controlled at database init in v1 (see `reset-db`) |
| `--json` | suppress decorative output; print one final JSON report line (includes `exitCode`) |
| `--config <path>` | explicit config file path |

### `odoo-agentic-dev link-source`

Create or refresh a local Odoo source pointer such as `.odoo` (a symlink on macOS/Linux/WSL2). Resolution order: `--target`, then the recipe's `odoo.source` (unless it is `"docker-only"`), then a conventional `../odoo` sibling checkout. It refuses to overwrite anything that is not a symlink, and replaces an existing symlink only with `--force`. The runtime never requires this link; it exists for IDE navigation and direct source inspection.

| Flag | Meaning |
| --- | --- |
| `--target <path>` | explicit source checkout path (absolute or relative to the project root) |
| `--name <link-name>` | link name (default `.odoo`) |
| `--force` | replace an existing symlink |
| `--config <path>` | explicit config file path |

### `odoo-agentic-dev list`

List the environments this machine's state registry knows about, reconciled against Docker reality: status is `running`, `stopped`, or `vanished` (row exists, Docker stack is gone). Labeled Docker stacks that are missing from the registry are adopted into it on sight. Output columns: worktree, database, port, status, relative last-used time, and `shared`/`template` markers. Listing never modifies or removes environments.

| Flag | Meaning |
| --- | --- |
| `--all-projects` | every project in the registry (works without a config) |
| `--json` | print the full rows + status as JSON |
| `--config <path>` | explicit config file path |

### `odoo-agentic-dev prune`

Garbage-collect dead environments. By default only clearly-dead targets are candidates: `gone-branch` (root dir exists, is a repo, the recorded branch was deleted), `gone-rootdir` (the worktree directory no longer exists), and `vanished` (registry row with no Docker stack — row-only cleanup). Age alone never makes a candidate unless you pass `--older-than <days>`.

The safety contract:

- Without `--yes`, `prune` is a dry run: it prints the kill list (stack, database, age, reason) and exits 1 when candidates exist, 0 when there are none. Nothing is removed.
- With `--yes`, teardown is label-based (`docker rm -f` + `docker volume rm` by Compose project label), so it works even when the original compose file is gone; the registry row is removed last.
- Shared environments are always skipped unless `--allow-shared` is passed.
- The environment a command is currently running in is never an auto-clean candidate.

| Flag | Meaning |
| --- | --- |
| `--older-than <days>` | also prune environments unused for more than `<days>` |
| `--all-projects` | every project in the registry (works without a config) |
| `--yes` | actually remove (without it: dry run, exit 1 when candidates exist) |
| `--allow-shared` | permit pruning shared environments |
| `--json` | print the candidates/removals report as JSON |
| `--config <path>` | explicit config file path |

### `odoo-agentic-dev doctor`

Environment health report (`✓`/`✗` per check, or `--json`): Docker daemon responsive, Compose is v2, Node >= 22.15, config discovery + validation (soft when absent), context derivation, Odoo port free or its holder identified, port collisions among known stacks, state registry openable and writable, git on PATH, WSL2 detection with setup guidance, and the current prune-candidate count. Exits 1 if any hard check fails.

| Flag | Meaning |
| --- | --- |
| `--json` | print the checks array as JSON |
| `--config <path>` | explicit config file path |

### `odoo-agentic-dev logs [service]`

Stream `docker compose logs` for one service of the current worktree stack (default: the Odoo service).

| Flag | Meaning |
| --- | --- |
| `--follow` | follow log output |
| `--config <path>` | explicit config file path |

### `odoo-agentic-dev shell`

Open an interactive `odoo shell` against the current worktree database (`docker compose run --rm <odoo> odoo shell -d <database>`), with full TTY passthrough. The child's exit code becomes the command's exit code.

### `odoo-agentic-dev psql [-- <args>]`

Open `psql` inside the database container connected to the current worktree database. Extra `psql` arguments pass through after `--`:

```bash
pnpm exec odoo-agentic-dev psql -- -c 'SELECT count(*) FROM res_partner;'
```

## Machine-Readable Output (`--json`)

`info`, `list`, `doctor`, and `prune` have dedicated JSON shapes and keep stdout pure JSON (warnings go to stderr).

The lifecycle commands — `setup`, `up`, `down`, `reset-db`, `update`, `test` — accept `--json` too: decorative output is suppressed and one final single-line JSON object is printed to stdout:

```json
{ "ok": true, "command": "reset-db", "database": "kl_feature_x", "composeProject": "kl_kl_feature_x", "odooUrl": "http://127.0.0.1:18119/web?db=kl_feature_x", "actions": ["restore-from-template"], "durationMs": 4180, "exitCode": 0 }
```

`actions` records what the command did (for `reset-db`/`setup` it includes `restore-from-template` or `full-init` + `snapshot-template`, so tooling can tell which reset path ran); `exitCode` appears when the command ran a child to completion (`test`). Streamed child output (image builds, Odoo logs) may still precede the report, so parse the **last line** of stdout (`tail -n 1 | jq`). On failure the object is emitted with `"ok": false` before the error is rendered on stderr.

## State Registry

Every lifecycle command records its environment (compose project, database, root dir, branch, port, timestamps, template metadata) in a machine-global SQLite registry at `${XDG_DATA_HOME:-~/.local/share}/odoo-agentic-dev/state.db`, overridable via the `ODOO_AGENTIC_DEV_STATE_DB` environment variable. It needs no setup and no external dependency (built-in `node:sqlite`, hence Node >= 22.15).

The registry is an index — Docker is the truth. Generated compose files stamp `dev.basaltbytes.oad.*` identity labels on services and volumes so `list`/`prune`/`doctor` can reconcile rows against reality and re-adopt stacks whose rows were lost. Project-supplied compose files (recipe `compose.file`) are not labeled; those environments are tracked by their registry rows alone.

## Automatic Cleanup

```ts
cleanup: {
  maxAgeDays: 30,  // staleness threshold used by the auto/warn hook
  auto: false      // false (default): warn only; true: prune automatically
}
```

At the end of `up` and `setup`, the registry is checked for dead environments of the current project. With `auto: false` (the default) a one-line warning is printed when candidates exist (`N stale environment(s) — run odoo-agentic-dev prune`). With `auto: true` the prune routine runs immediately for gone/vanished environments and those unused for more than `maxAgeDays`, never touching shared environments or the environment the command is running in, and prints what it removed.

## Network Exposure

The generated Compose file binds Odoo to the loopback interface only (`127.0.0.1:<port>:8069`): another machine on your LAN can never reach a dev Odoo by default. To expose a stack deliberately, supply your own compose file via the recipe's `compose.file` with the port mapping you want (for example `"0.0.0.0:8069:8069"`) — deliberate exposure is a project decision, not a CLI flag.

## Environment Variables

| Variable | Meaning |
| --- | --- |
| `ODOO_DATABASE` | Current worktree Odoo database |
| `E2E_ODOO_DB` | Alias for test tooling |
| `ODOO_BASE_URL` | Odoo HTTP origin |
| `ODOO_HTTP_PORT` | Host port for Odoo |
| `ODOO_COMPOSE_PROJECT_NAME` | Docker Compose project |
| `ODOO_WORKTREE_NAME` | Override for derived worktree name |
| `ODOO_WORKTREE_CONFIG` | Config file path override |
| `ODOO_AGENTIC_DEV_STATE_DB` | State registry path override (default `${XDG_DATA_HOME:-~/.local/share}/odoo-agentic-dev/state.db`) |

Explicit env overrides win over derived values, but `E2E_ODOO_DB` and `ODOO_DATABASE` must not disagree.

Companion apps contribute their own variables to the context env: `portEnv` receives the allocated port and `urlEnv` receives `http://localhost:<port>`; both show up in `info --env` and `info --json`. Compatibility aliases for existing projects (for example `KL_WORKTREE_DB_NAME`) can be declared in the recipe via `envAliases`: an alias may target **any** assembled env key — canonical or companion-provided (`E2E_PWA_PORT: "PWA_PORT"` works) — and an alias targeting an unknown key fails validation listing the available keys.

## Safety Rules

- A shared database (the recipe's `project.sharedDatabase`, used by `project.sharedBranches`) is never deleted without `--allow-shared`.
- Database names outside the safe pattern `^[a-z][a-z0-9_]*$` (max 63 chars) are rejected.
- Destructive actions never run with an empty Compose project name.
- `link-source` never overwrites a non-symlink path.
- The resolved database and Compose project are printed before destructive work.
- Config validation failures fail closed: no command proceeds on an invalid recipe.
- Confirmations are flags-only — there are no interactive prompts, so non-interactive agents never hang waiting for input.
- `prune` is a dry run unless `--yes` is passed, skips shared environments unless `--allow-shared`, and only ages out environments when `--older-than` is given.
- `up` fails fast on a port conflict instead of silently probing for another port — same branch, same port, always.
- Generated stacks bind Odoo to `127.0.0.1` only; LAN exposure requires a deliberate project-supplied compose file.

## Post-Init Hooks

`database.postInit` hooks run after the initial modules are installed, in the order they are declared:

```ts
type PostInitHook =
  | { type: "odoo-shell-file"; file: string }       // run a Python file in `odoo shell`
  | { type: "odoo-shell-inline"; code: string }     // run inline Python in `odoo shell`
  | { type: "set-ir-config-parameter"; key: string; value: string }
  | { type: "command"; command: string; args: ReadonlyArray<string>; cwd?: string };
```

Hook files resolve relative to the project root. Only `set-ir-config-parameter` commits automatically (it runs `env.cr.commit()` for you); `odoo-shell-file` and `odoo-shell-inline` scripts must call `env.cr.commit()` themselves or their changes are rolled back when the shell exits. Prefer `odoo-shell-file` and `set-ir-config-parameter`; inline code is harder to review.

## Development

```bash
pnpm install
pnpm build         # compile to dist/
pnpm test          # unit + e2e tests (e2e runs against dist/cli.js when built)
pnpm typecheck     # tsc --noEmit over src + test
pnpm lint          # oxlint
pnpm format        # oxfmt --write
pnpm format:check  # oxfmt --check
```

The test suite never requires Docker, Git state, or a network connection — adapters are faked, and every state-touching test pins `ODOO_AGENTIC_DEV_STATE_DB` to a temp file so your real registry is never touched. `scripts/docker-integration.sh` is a separate minimal Docker integration check (compose file generation + validation against a real Docker) used by the Linux CI job; it is not part of `pnpm test`.

CI runs lint/typecheck/build/test on Linux, macOS, and Windows across Node 22 and 24 (the Windows job exercises the dry-run unit suite only — no Docker), plus the Docker integration job on Linux. A nightly workflow (`.github/workflows/nightly.yml`, also runnable via `workflow_dispatch`) exercises the real `odoo:18` + `postgres:16` lifecycle end to end: `setup` with a template snapshot, `reset-db` down the template restore path, `update base`, and a fully clean `down --volumes`.
