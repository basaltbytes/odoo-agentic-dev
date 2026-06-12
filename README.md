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

Create `odoo-agentic-dev.config.ts` at the project root (also accepted: `.mts`, `.js`, `.mjs` — `.ts` configs load directly, no precompilation needed). This is a complete config for an Odoo-only project:

```ts
import { defineConfig } from "@basaltbytes/odoo-agentic-dev";

export default defineConfig({
  project: { id: "billing-odoo", dbPrefix: "billing" },
  odoo: {
    version: "18.0",
    addons: [{ host: "addons", container: "/mnt/extra-addons/custom" }]
  }
});
```

Everything else has a sensible default: the stock `odoo:<version>` image, `postgres:16`, services named `odoo`/`db`, Odoo on port `18069 + hash(db) % 1000` bound to loopback, demo data disabled. Add config only where your project actually deviates — the [Configuration Reference](#configuration-reference) below shows every field and its default.

Then:

```bash
pnpm exec odoo-agentic-dev setup   # prepare the worktree (deps, image, database)
pnpm exec odoo-agentic-dev up      # start Odoo + companion apps
pnpm exec odoo-agentic-dev info    # inspect the derived context at any time
```

## Configuration Reference

Every field, with defaults shown in comments. Only `project.id`, `project.dbPrefix`, `odoo.version`, and `odoo.addons` are required — a good config states only what deviates from the defaults.

```ts
import { defineConfig } from "@basaltbytes/odoo-agentic-dev";

export default defineConfig({
  project: {
    id: "acme",                       // required — namespaces compose projects, labels, the registry
    dbPrefix: "acme",                 // required — derived DBs are `<dbPrefix>_<branch-slug>`
    sharedDatabase: "acme_dev",       // default: none — one DB reused by long-lived branches,
                                      //   protected from deletion (needs --allow-shared)
    sharedBranches: ["main", "master"], // default when sharedDatabase is set
    stripBranchPrefixes:              // default: ["feature","feat","bugfix","bug","hotfix","fix","chore","task"]
      ["feature", "fix"],             //   at most ONE leading branch segment is stripped before slugging
  },

  ports: {
    odooBase: 18069,                  // default — Odoo port = odooBase + hash(db) % range
    companionBase: 28000,             // default — same formula per companion app
    range: 1000,                      // default
    hashAlgorithm: "fnv1a32",         // default — "posix-cksum" reproduces bash `cksum` tooling
                                      //   so a migrated project keeps its exact ports
  },

  odoo: {
    version: "18.0",                  // required — image tag, and part of the DB template cache key
    serviceName: "odoo",              // default — compose service to exec/log against
    databaseServiceName: "db",        // default
    postgresImage: "postgres:16",     // default
    build: {                          // default: none — the CLI GENERATES a Dockerfile from this
      aptPackages: ["tesseract-ocr"], //   (FROM odoo:<version>, one apt layer, one pip layer, COPYs)
      pipRequirements: ["backend/requirements.txt"],
      pipPackages: ["requests"],
      copy: [{ from: "backend/sql-script", to: "/opt/acme/sql-script" }],
    },
    dockerfile: "Dockerfile.odoo",    // default: none — hand-written escape hatch, mutually
                                      //   exclusive with `build`; without either, the stock
                                      //   `odoo:<version>` image runs as-is
    imageName: "acme-odoo:dev",       // default: none — tag for the built image
    dev: "xml,reload",                // default — `--dev=` flags for the served Odoo; false disables
    baseAddonsPath:                   // default — in-image addons dir, prepended to every
      "/usr/lib/python3/dist-packages/odoo/addons", //   --addons-path the CLI passes
    configFile: "config/odoo.conf",   // default: none — mounted read-only at /etc/odoo/odoo.conf
                                      //   (rarely needed: db connection, --database, --addons-path,
                                      //   and --no-database-list are all handled by the CLI)
    source: "../odoo",                // default: none — local Odoo checkout for `link-source`
    addons: [                         // required, at least one mount (host path relative to repo root)
      { host: "addons", container: "/mnt/extra-addons/custom" },
      // { host: "/abs/elsewhere", container: "/mnt/x", allowOutsideRepo: true },
    ],
  },

  database: {
    initialModules: ["acme_core"],    // default: [] — installed on first setup / reset-db
    withoutDemo: "all",               // default — `false` keeps Odoo demo data
    postInit: [                       // default: [] — run after EVERY database init or reset,
                                      //   and folded into the template-snapshot cache key
      { type: "odoo-shell-file", file: "scripts/post-init.py" },
      { type: "set-ir-config-parameter", key: "app.mobile.url", value: "$E2E_BASE_URL" },
      // also: { type: "odoo-shell-inline", code: "..." }
      //       { type: "command", command: "pnpm", args: ["seed"], cwd: "tools" }
    ],
  },

  setup: {                            // host-side workspace bootstrap — runs ONCE per worktree,
    submodules: true,                 //   default: false — git submodule update --init --recursive
    packageManagers: [                //   default: []
      { cwd: ".", command: "pnpm", args: ["install"] },
      { cwd: "frontend", command: "pnpm", args: ["install"] },
    ],
  },

  compose: {
    file: "docker-compose.worktree.yml", // default: none — escape hatch replacing the generated
                                         //   compose file; it can interpolate ${ODOO_DATABASE:?} etc.
                                         //   Rarely needed: the generated file already builds the
                                         //   image, serves only the derived DB, sets --addons-path,
                                         //   dev mode, restart policies, and injects the context env.
  },

  worktree: {
    copyFiles: [".env", ".env.e2e"],  // default: [] — root files copied into fresh worktrees when present
    branchPrefix: "worktree-",        // default — branch name prefix for `worktree create <name>`
  },

  test: {
    profiles: {                       // default: {} — `test --profile payment` appends these args
      payment: ["--test-tags", "payment"],
    },
  },

  envAliases: {                       // default: {} — compatibility names for existing tooling;
    KL_WORKTREE_DB_NAME: "ODOO_DATABASE", //   an alias may target any assembled env key,
    E2E_PWA_PORT: "PWA_PORT",         //   including companion portEnv/urlEnv keys
  },

  companionApps: [                    // default: [] — processes `up` starts alongside Odoo
    {
      name: "pwa",                    // lowercase kebab, unique
      cwd: "frontend",
      command: "sh",                  // args are NOT token-substituted — read env vars via the
      args: ["-lc", 'pnpm dev --port "$PWA_PORT" --strictPort'], // shell (or the tool's own env support)
      portEnv: "PWA_PORT",            // optional — env var receiving the allocated port
      urlEnv: "E2E_BASE_URL",         // optional — env var receiving http://localhost:<port>
      env: {                          // optional extra env; $VARS here ARE substituted from the context
        VITE_API_URL: "$ODOO_BASE_URL",
      },
    },
  ],

  cleanup: {
    maxAgeDays: 30,                   // default — age threshold for prune --older-than candidates
    auto: false,                      // default — opt in to automatic pruning of gone-branch stacks
  },
});
```

Database names are derived from the branch: at most **one** leading type segment from `stripBranchPrefixes` is stripped — `feature/fix/x` becomes `<dbPrefix>_fix_x` — then the remainder is sanitized, prefixed, and capped at 58 chars (longer names keep a stable hash suffix). Ports are a hash of that database name modulo `ports.range`, so the same branch always gets the same ports on every machine.

### `setup` vs `database.postInit`

They run at different times against different things. `setup` is host-side workspace bootstrap — submodules and dependency installs — executed once when a worktree is prepared, before any database exists. `database.postInit` runs against Odoo after **every** database initialization or reset (and is part of the template cache key, so editing a hook correctly invalidates cached snapshots). Rule of thumb: filesystem state → `setup`; database state → `database.postInit`.

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

Create or refresh a local Odoo source pointer such as `.odoo` (a symlink on macOS/Linux/WSL2). Resolution order: `--target`, then the recipe's `odoo.source` (unless it is `"docker-only"`) — both used as-is without validation — then discovery: the conventional `../odoo` sibling checkout, then `<dirname>/odoo` next to every git worktree of the project. A discovered candidate counts only if it looks like an Odoo source checkout (contains `odoo-bin`, `odoo/` and `addons/`); when none qualifies the error lists every candidate checked. It refuses to overwrite anything that is not a symlink, and replaces an existing symlink only with `--force`. The runtime never requires this link; it exists for IDE navigation and direct source inspection.

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

### `odoo-agentic-dev run [--env-file <path>]... -- <command> [args...]`

Execute any host command with the worktree environment injected — the assembled context env (`ODOO_DATABASE`, `ODOO_HTTP_PORT`, companion ports/URLs, aliases) layered over the parent environment. Each `--env-file` (repeatable) is a dotenv-style file (`KEY=value` lines, `#` comments, optional surrounding quotes stripped) whose pairs are explicit overrides: parent env < context env < env files, later files win. The child runs with full TTY passthrough and its exit code becomes the command's exit code.

```bash
pnpm exec odoo-agentic-dev run -- pnpm test:e2e
pnpm exec odoo-agentic-dev run --env-file .env.e2e -- playwright test
```

| Flag | Meaning |
| --- | --- |
| `--env-file <path>` | dotenv-style overrides, repeatable (later files win; missing file = error) |
| `--config <path>` | explicit config file path |

### `odoo-agentic-dev compose -- <compose-args...>`

`docker compose` passthrough scoped to this worktree's stack: the canonical preamble (`-p <project>`, `-f <compose-file>`, `--project-directory`, context env) is prepended and the trailing arguments land verbatim, with full stdio inheritance — `logs -f` streams, interactive `exec` works. The child's exit code becomes the command's exit code.

```bash
pnpm exec odoo-agentic-dev compose -- ps
pnpm exec odoo-agentic-dev compose -- logs -f --tail 100 odoo
pnpm exec odoo-agentic-dev compose -- exec db bash
```

### `odoo-agentic-dev worktree create <name>`

Create a git worktree and run the full `setup` flow inside it: best-effort `git fetch origin`; base ref from `--base`, else `ODOO_WORKTREE_BASE_REF`, else origin's HEAD, else `HEAD`; `git worktree add -b <branchPrefix><name> <path> <base>`; copy the recipe's `worktree.copyFiles` that exist in the project root; then deps + image + database against the worktree as project root. Prints the worktree path when done.

With `--hook-json` (the Claude Code WorktreeCreate hook contract) the `{worktree_name, worktree_path}` payload is read from stdin, all human output goes to stderr, and stdout carries exactly one line — the final worktree path. If setup fails in hook mode the half-made worktree is force-removed and the command exits non-zero so the hook aborts the creation.

| Flag | Meaning |
| --- | --- |
| `--path <path>` | worktree directory (default: sibling `<repo-basename>-<name>`) |
| `--base <ref>` | base ref for the new branch |
| `--hook-json` | Claude Code hook mode (payload on stdin, path-only stdout) |
| `--config <path>` | explicit config file path |

### `odoo-agentic-dev worktree remove <path>`

Tear down a worktree's environment. When the directory still has a discoverable config, its own context is resolved and the stack goes down with volumes (`down --volumes` semantics) before the registry row is removed; a shared database is never torn down without `--allow-shared` (logged and skipped instead). When the directory is already gone, the identity is rebuilt from the directory name against the current project root and the teardown is label-based — the same machinery `prune` uses, no compose file needed. The directory itself is not deleted (git owns that).

With `--hook-json` (the WorktreeRemove hook contract) the `{worktree_path}` payload is read from stdin and the command **always exits 0** — a removal hook cannot block — logging each step to `--log-file` (directory created) when given, stderr otherwise.

| Flag | Meaning |
| --- | --- |
| `--hook-json` | Claude Code hook mode (payload on stdin, always exit 0) |
| `--allow-shared` | permit tearing down the shared database |
| `--log-file <path>` | append step logs to this file |
| `--config <path>` | explicit config file path |

## Machine-Readable Output (`--json`)

`info`, `list`, `doctor`, and `prune` have dedicated JSON shapes and keep stdout pure JSON (warnings go to stderr).

The mutating lifecycle commands — `setup`, `reset-db`, `update`, `test`, `down`, and `up --detach` — accept `--json` too. In JSON mode **stdout carries exactly one JSON object** (a single final line) and **everything else — decorative progress, streamed compose/Odoo subprocess output, the test tail — goes to stderr**, so a parser can always read the report with `tail -n 1 | jq` (no other line ever reaches stdout).

Every report shares this core:

```json
{ "ok": true, "command": "reset-db", "database": "kl_feature_x", "composeProjectName": "kl_kl_feature_x", "odooHttpPort": 18119, "durationMs": 4180, "actions": ["restore-from-template"] }
```

- `ok` — `true` on success; `false` on failure or (for `test`) a non-zero child exit.
- `composeProject` and `odooUrl` are kept as back-compat aliases of `composeProjectName` / the derived web URL.
- `actions` records what the command did, so tooling can tell which path ran.

Per-command extras merged into the core:

- **`setup` / `reset-db`** add `"mode": "template-restore" | "full-init"` and `"templateKey": "<recipe template hash>"`.
- **`test`** adds `"exitCode"`, `"stdoutTail"`, and `"stderrTail"` (the last 200 lines of the Odoo run); `ok` mirrors `exitCode === 0`.
- **`down`** adds `"volumesRemoved": boolean`.

On failure the command still renders the error on stderr and exits 1, **and** stdout gets a final `ok:false` object carrying the typed error, so a parser never sees an empty stdout:

```json
{ "ok": false, "command": "reset-db", "database": "kl_e2e_demo", "composeProjectName": "kl_kl_e2e_demo", "odooHttpPort": 18119, "durationMs": 12, "actions": [], "error": { "tag": "SharedDatabaseProtectionError", "message": "refusing to touch shared database \"kl_e2e_demo\" (re-run reset-db with --allow-shared)" } }
```

`error.tag` is the underlying `TaggedError` `_tag`. Identity fields (`database`, `composeProjectName`, `odooHttpPort`) are `null` when the command fails before the context resolves.

Attached `up` (without `--detach`) streams forever and never reaches a final line, so **`up --json` requires `--detach`** — it is rejected up front with a `ConfigValidationError` pointing at `--detach`. `up --detach --json` works.

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

Every compose subprocess runs with the full context env exported (the same variables `info --env` prints, merged over the parent environment), so a project-supplied compose file can interpolate `${ODOO_DATABASE:?}` or `${ODOO_HTTP_PORT:?}` directly.

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

## Ejecting

```bash
odoo-agentic-dev eject            # all (Dockerfile + compose), prints the config patch
odoo-agentic-dev eject compose    # just the compose file
odoo-agentic-dev eject dockerfile # just the Dockerfile (needs an odoo.build block)
odoo-agentic-dev eject --write-config   # also rewrite the config in place
```

`eject` converts generated infra into project-owned files: it writes the Dockerfile (`Dockerfile.odoo`) and/or the compose file (`docker-compose.worktree.yml`) into the repo as plain, editable files and points the config at them via the existing `odoo.dockerfile` / `compose.file` escape hatches. There are no new runtime concepts — eject just automates stepping onto hatches the CLI already supports.

**When to eject:** you need custom services the generated compose does not model (extra containers, exotic networking), deliberate LAN exposure, or your team simply prefers infra it can see and edit in the repo.

**What you keep.** Everything that makes the CLI worth using still works against an ejected stack: database/port derivation, the full context env injection (`compose.file` consumers run with the same variables `info --env` prints, so the ejected compose's `${ODOO_DATABASE:?}` / `${ODOO_HTTP_PORT:?}` interpolations always resolve), the worktree lifecycle (`setup`/`up`/`down`/`reset-db`), and the safety guards (shared-database protection, loopback-only binding, unsafe-name rejection). The ejected files are **portable**: the compose render emits interpolations instead of the current worktree's baked literals, so one file serves every worktree.

**What you give up.** Config-driven infra upgrades. Once ejected, changes to `odoo.build` no longer regenerate your Dockerfile, and improvements to the generated compose file in future CLI releases no longer reach you — those files are yours to maintain.

By default eject prints a ready-to-apply config patch and changes nothing else; pass a path to override the destination (`--dockerfile-out` / `--compose-out`), `--force` to overwrite an existing file, and `--json` for a machine-readable `{ ok, written, configPatch, configWritten }` object. `--write-config` rewrites the config in place and discards comments, so it refuses a commented file without `--force`. `eject dockerfile` refuses a stock-image config — there is nothing to eject; add an `odoo.build` block first, or eject only the compose file.

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
