# @basaltbytes/odoo-agentic-dev

`odoo-agentic-dev` (short alias: `oad`) is an agent-friendly local Odoo development runtime. From the current Git worktree it derives a deterministic database name, deterministic ports, and a namespaced Docker Compose project, then drives the full lifecycle around them: set up a fresh checkout, start Odoo and PostgreSQL, reset and re-initialize the database, update modules, run tests, and start optional companion apps such as a Vite PWA — each branch, agent session, or bug reproduction gets its own isolated stack that cannot collide with the others.

Projects describe themselves with one typed recipe file (`odoo-agentic-dev.config.ts`) instead of copied shell scripts and Compose files. The CLI is built for non-interactive use: flags replace prompts, output is deterministic, `info --json` exposes the whole resolved context to tooling, and destructive actions are guarded so a coding agent (or a tired human) cannot accidentally delete a shared database.

## Requirements

- Node.js 22.22.2+ on the Node 22 line, or Node.js 24.15.0+ (the state registry uses the built-in `node:sqlite` — no native dependency)
- npm, pnpm, yarn, or another Node package manager
- Git
- Docker with Compose v2 (Docker Desktop on macOS, Docker Engine or Docker Desktop on Linux/WSL2) — `info` works without Docker running
- macOS, Linux, or Windows through WSL2

WSL2 guidance:

- clone repositories inside the WSL filesystem, not under `/mnt/c`
- install Node, package manager, Git, and Docker CLI inside WSL
- enable Docker Desktop WSL integration
- pass paths as Linux paths

## Installation

Install the global front door once:

```bash
npm install -g @basaltbytes/odoo-agentic-dev
oad --version
oad doctor
```

Then pin the package inside each Odoo project that uses it:

```bash
npm install -D @basaltbytes/odoo-agentic-dev
```

The global `oad` delegates to the project-local install when one is present, so day-to-day commands run the exact version recorded in the project's lockfile. Other package managers work too, for example `pnpm add -g`, `yarn global add`, or `bun add -g`.

## Quickstart

```bash
cd your-odoo-project
oad init        # scaffold odoo-agentic-dev.config.ts (project id from the folder name)
npm install -D @basaltbytes/odoo-agentic-dev  # pin the version: config types, hooks, delegation target
oad setup       # deps, image, database, optional template snapshot
oad up          # start Odoo (+ companion apps)
```

`init` derives the project id from the folder name and a database prefix from the id (`kriss-laure` → `kl`), detects an `addons/` directory, git-ignores the generated `.odoo-agentic-dev/`, and validates the result through the real config loader. Adjust `odoo.version` and the addon mounts, and you're running.

### Global install & local delegation

The global `oad` is a convenience front door, not a version authority: whenever it runs inside a project that has `@basaltbytes/odoo-agentic-dev` installed locally, it transparently re-executes the **project-local** CLI — so every repo runs exactly the version its lockfile pins, while you type `oad` everywhere. Outside a project, the global binary serves the cross-project commands (`init`, `list --all-projects`, `prune`, `doctor`). Set `ODOO_AGENTIC_DEV_NO_DELEGATE=1` to suppress delegation when debugging. Commands that operate on a stack (`up`, `down`, `reset-db`, …) require a config — without one they exit 1 and point you at `init`.

The config file is `odoo-agentic-dev.config.ts` at the project root (also accepted: `.mts`, `.js`, `.mjs` — `.ts` configs load directly, no precompilation needed). This is a complete config for an Odoo-only project:

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

## For Coding Agents

The CLI is designed to be driven by coding agents: deterministic derivation, no interactive prompts, meaningful exit codes, `--json` everywhere, and guard rails on destructive actions. To make your agents use it well, paste the block in [docs/AGENTS-SNIPPET.md](docs/AGENTS-SNIPPET.md) into your project's `CLAUDE.md` / `AGENTS.md` — it covers the daily commands, the env contract (`run -- <cmd>` instead of hand-assembled variables), and the rule that Docker Compose is only reached through `oad compose --`.

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
      aptPackages: ["tesseract-ocr"], //   (FROM odoo:<version>, apt layer, pip layer, then COPYs)
      pipRequirements: ["backend/requirements.txt"],
      pipPackages: ["requests"],
      copy: [{ from: "backend/sql-script", to: "/opt/acme/sql-script" }],
      run: ["playwright install --with-deps chromium-headless-shell"], // raw RUN escape hatch (as root)
    },
    dockerfile: "Dockerfile.odoo",    // default: none — hand-written escape hatch, mutually
                                      //   exclusive with `build`; without either, the stock
                                      //   `odoo:<version>` image runs as-is
    imageName: "acme-odoo:dev",       // default: none — tag for a built image, or a
                                      //   prebuilt image to run when no build/dockerfile is set
    dev: "xml,reload",                // default — `--dev=` flags for the served Odoo; false disables
    baseAddonsPath:                   // default — in-image addons dir, prepended to every
      "/usr/lib/python3/dist-packages/odoo/addons", //   --addons-path the CLI passes
    configFile: "config/odoo.conf",   // default: none — mounted read-only at /etc/odoo/odoo.conf
                                      //   (rarely needed: db connection, db_name/--database, --addons-path,
                                      //   and --no-database-list are all handled by the CLI)
    source: "../odoo",                // default: none — local Odoo checkout for `link-source`
    addons: [                         // required, at least one mount (host path relative to repo root)
      { host: "addons", container: "/mnt/extra-addons/custom" },
      // { host: "/abs/elsewhere", container: "/mnt/x", allowOutsideRepo: true },
    ],
  },

  database: {
    initialModules: ["acme_core"],    // default: [] — installed on first setup / reset-db
    withoutDemo: "all",               // default — `false` requests Odoo demo data
                                      //   (Odoo 19+ receives `--with-demo`)
    template: true,                   // default — set false to always full-init and
                                      //   skip `<database>__tpl` restore/snapshot caching
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
      { cwd: ".", command: "npm", args: ["install"] },
      { cwd: "frontend", command: "npm", args: ["install"] },
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

### Docker build context and cache

Generated Odoo images build with the project root as Docker context. Add a project `.dockerignore` so Docker does not rescan or upload irrelevant files on every build:

```dockerignore
.git
node_modules
dist
coverage
.venv
__pycache__
.pytest_cache
.odoo-agentic-dev/logs
*.log
```

Do not ignore files referenced by `odoo.build.pipRequirements` or `odoo.build.copy`; Docker must see those paths. The generated Dockerfile keeps expensive dependency layers cacheable by installing apt packages first, copying requirements files just before `pip install`, and copying arbitrary project assets after the pip layer.

## Commands

Every command accepts `--config <path>` to point at an explicit recipe file; otherwise the recipe is discovered from the current working directory upward.

### `oad init`

Scaffold `odoo-agentic-dev.config.ts` in the current directory: project id derived from the folder name, database prefix from the id (`kriss-laure` → `kl`), `./addons` auto-detected, `.odoo-agentic-dev/` added to `.gitignore`, and the result validated through the real config loader before success is reported. Refuses over an existing config (`--force` for the cwd case; a config in an ancestor directory always refuses — nested configs are a footgun).

| Flag | Meaning |
| --- | --- |
| `--id <id>` | project id (default: derived from the folder name) |
| `--db-prefix <p>` | database prefix (default: derived from the id) |
| `--odoo-version <v>` | Odoo version for the scaffold (default `18.0`) |
| `--force` | overwrite an existing config in the current directory |
| `--json` | print machine-readable JSON |

### `oad info`

Print the resolved worktree context (worktree name, database, Compose project, Odoo URL, companion URLs) without starting containers. Works without Docker running and is deterministic for the same branch and recipe.

| Flag | Meaning |
| --- | --- |
| `--json` | print machine-readable JSON |
| `--env` | print `KEY=value` env lines |
| `--config <path>` | explicit config file path |

### `oad setup`

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

### `oad up`

Start Odoo (and PostgreSQL) on the derived port, then the configured companion apps with context-derived env injected (`ODOO_DATABASE`, `ODOO_BASE_URL`, per-app ports). In attached mode, Ctrl-C stops all child processes and the first failing process is reported.

`up` rebuilds the Odoo image by default, but Docker reuses cached layers when image inputs did not change. Use `--no-build` for a faster start when you know the image is current; the CLI warns when tracked image inputs no longer match the last recorded successful build.

Before starting anything, `up` probes the derived Odoo port. If it is busy and the holder is not this worktree's own already-running stack (idempotent `up`), it fails fast with a `PortConflictError` naming the holder stack when the state registry knows it — set `ODOO_HTTP_PORT` to override, or `prune` stale environments.

| Flag | Meaning |
| --- | --- |
| `--odoo-only` | skip companion apps |
| `--no-build` | start containers without rebuilding the image |
| `--logs` | follow Odoo logs after start |
| `--detach` | start containers and return |
| `--json` | suppress decorative output; print one final JSON report line |
| `--config <path>` | explicit config file path |

### `oad restart`

Restart the Odoo service for the current worktree without touching the database, volumes, or companion apps. This is the fast "Odoo is hung, kick the process" command.

```bash
oad restart
oad restart --logs
oad restart --rebuild
```

Plain `restart` uses the existing image and runs `docker compose restart <odoo-service>` after ensuring PostgreSQL is up. `--rebuild` rebuilds the Odoo image, removes the Odoo container, and recreates it; use it after changing `odoo.build`, `odoo.dockerfile`, or files copied into the image. `--logs` follows Odoo logs after restart and cannot be combined with `--json`.

| Flag | Meaning |
| --- | --- |
| `--rebuild` | rebuild the image, remove the Odoo container, and recreate it |
| `--logs` | follow Odoo logs after restart |
| `--json` | suppress decorative output; print one final JSON report line |
| `--config <path>` | explicit config file path |

### `oad down`

Stop the current worktree stack. Uses the derived Compose project name, so other worktrees are never affected. `down` passes `--remove-orphans` so old containers from earlier recipe shapes are removed too. A plain `down` keeps the environment in the state registry (only refreshing its last-used time); `down --volumes` removes the registry row along with the volumes.

| Flag | Meaning |
| --- | --- |
| `--volumes` | also remove this worktree's volumes (guarded for shared databases) |
| `--allow-shared` | permit acting on the shared database |
| `--json` | suppress decorative output; print one final JSON report line |
| `--config <path>` | explicit config file path |

### `oad reset-db`

Delete and recreate the current worktree database and filestore, terminate active database sessions first, install the initial modules, and run post-init hooks. Refuses unsafe database names.

| Flag | Meaning |
| --- | --- |
| `--allow-shared` | permit resetting the shared database |
| `--build` | rebuild the Odoo image before running reset/restore containers |
| `--modules <list>` | comma-separated module list (defaults to the recipe's `initialModules`) |
| `--without-demo <mode>` | demo-data mode passed straight to Odoo's `--without-demo` |
| `--no-template` | full init even when a template snapshot exists (template kept) |
| `--refresh-template` | full init and take a fresh template snapshot |
| `--json` | suppress decorative output; print one final JSON report line |
| `--config <path>` | explicit config file path |

Demo data is controlled at database initialization time, not per test run. The recipe's `database.withoutDemo` sets the default: a string mode (for example `"all"`) is passed to Odoo's `--without-demo`, while `withoutDemo: false` requests demo data. For Odoo 19 and newer that emits `--with-demo`; for older versions it preserves the legacy behavior of omitting `--without-demo`. The `--without-demo <mode>` flag overrides the recipe for one reset, passing the mode string straight through to Odoo.

#### Template fast reset

The first successful full init (from `setup` or `reset-db`) is snapshotted — after the post-init hooks — as a PostgreSQL template database named `<database>__tpl` plus a filestore copy. Subsequent `reset-db` runs restore from that template in seconds instead of re-running module installation; post-init hooks are **not** re-run on restore because their effects are baked into the snapshot.

Snapshots carry a key derived from the database-shaping recipe inputs: `initialModules`, `withoutDemo`, `odoo.version`, `postInit`, the Odoo addons path configuration, `odoo.configFile`, the declared Odoo image inputs (`odoo.build`, `odoo.dockerfile`, `odoo.imageName`, plus the contents of declared requirements/copy/config files), and database-shaping files under mounted addon roots: manifests, `security`, `views`, `data`, `demo`, `i18n`, and test config files. Changing any of these invalidates the template: the next `reset-db` automatically falls back to a full init and takes a fresh snapshot. One-off `--modules`/`--without-demo` overrides always force a full init without touching the stored template.

- `database.template: false` disables restore and snapshot caching for the recipe. `setup` and `reset-db` run a full init and do not create `<database>__tpl`.
- `--no-template` forces a full init for one run, keeping the existing snapshot.
- `--refresh-template` forces a full init and replaces the snapshot.
- `--build` rebuilds the Odoo image before a reset or restore. Use it after editing `odoo.build`, a hand-written `odoo.dockerfile`, or files copied into the image. Template invalidation chooses the database reset path; it does not by itself rebuild the image.
- PostgreSQL is per-stack, so templates only accelerate resets within the same worktree.
- Database names are budgeted so `<database>__tpl` fits PostgreSQL's 63-char identifier limit (derived names are capped at 58 chars); an explicitly overridden name longer than 58 chars simply skips snapshotting.

#### Image freshness

For recipes with `odoo.build` or `odoo.dockerfile`, the state registry records an image key after a successful build. `up`, `setup`, `restart --rebuild`, and `--build` lifecycle commands refresh it. Commands that run without building warn when the current image inputs differ from the recorded key, or when no successful build is known yet.

### `oad update <modules>`

Update modules in the current worktree database. Starts PostgreSQL if needed, stops Odoo before the update when needed, and restarts Odoo after a successful update unless `--no-restart` is passed. It does not rebuild the image unless `--build` is passed.

```bash
oad update KL_setup
oad update KL_base,KL_sale,KL_stock
```

| Flag | Meaning |
| --- | --- |
| `--no-restart` | do not restart Odoo after the update |
| `--build` | rebuild the Odoo image before running the update container |
| `--json` | suppress decorative output; print one final JSON report line |
| `--config <path>` | explicit config file path |

### `oad test`

Run Odoo tests against the current worktree database. Options map to Odoo CLI flags, the exit code is non-zero on test failure, and recipes may define reusable test profiles (`test.profiles`) selected with `--profile`. It does not rebuild the image unless `--build` is passed.

Browser-based Odoo suites can be skipped by Odoo itself when the image is missing required Python/browser dependencies. `oad test` treats known browser infrastructure skips (`websocket-client`, missing Chrome/Chromium, Chrome DevTools/headless startup failures) as failures and prints the fix. Partial Hoot/browser skips are reported as warnings; a Hoot run with skipped tests and zero passed tests is treated as a failure.

| Flag | Meaning |
| --- | --- |
| `--tags <tags>` | Odoo `--test-tags` value |
| `--file <path>` | Odoo `--test-file` value |
| `--module <name>` | restrict tests to a module |
| `--log-level <level>` | Odoo log level |
| `--profile <name>` | recipe-defined test profile (extra Odoo args) |
| `--build` | rebuild the Odoo image before running the test container |
| `--include-demo` | accepted for compatibility; demo data is controlled at database init in v1 (see `reset-db`) |
| `--json` | suppress decorative output; print one final JSON report line (includes `exitCode`) |
| `--config <path>` | explicit config file path |

### `oad link-source`

Create or refresh a local Odoo source pointer such as `.odoo` (a symlink on macOS/Linux/WSL2). Resolution order: `--target`, then the recipe's `odoo.source` (unless it is `"docker-only"`) — both used as-is without validation — then discovery: the conventional `../odoo` sibling checkout, then `<dirname>/odoo` next to every git worktree of the project. A discovered candidate counts only if it looks like an Odoo source checkout (contains `odoo-bin`, `odoo/` and `addons/`); when none qualifies the error lists every candidate checked. It refuses to overwrite anything that is not a symlink, and replaces an existing symlink only with `--force`. The runtime never requires this link; it exists for IDE navigation and direct source inspection.

| Flag | Meaning |
| --- | --- |
| `--target <path>` | explicit source checkout path (absolute or relative to the project root) |
| `--name <link-name>` | link name (default `.odoo`) |
| `--force` | replace an existing symlink |
| `--config <path>` | explicit config file path |

### `oad list`

List the environments this machine's state registry knows about, reconciled against Docker reality: status is `running`, `stopped`, or `vanished` (row exists, Docker stack is gone). Labeled Docker stacks that are missing from the registry are adopted into it on sight. Output columns: worktree, database, port, status, relative last-used time, and `shared`/`template` markers. Listing never modifies or removes environments.

| Flag | Meaning |
| --- | --- |
| `--all-projects` | every project in the registry (works without a config) |
| `--json` | print the full rows + status as JSON |
| `--config <path>` | explicit config file path |

### `oad prune`

Garbage-collect dead environments. By default only clearly-dead targets are candidates: `gone-branch` (root dir exists, is a repo, the recorded branch was deleted), `gone-rootdir` (the worktree directory no longer exists), and `vanished` (registry row with no Docker stack — row-only cleanup). Age alone never makes a candidate unless you pass `--older-than <days>`.

The safety contract:

- Without `--yes`, `prune` is a dry run: it prints the kill list (stack, database, age, reason) and exits 1 when candidates exist, 0 when there are none. Nothing is removed.
- With `--yes`, teardown is label-based (`docker rm -f`, `docker volume rm`, and `docker network rm` by Compose project label), so it works even when the original compose file is gone; the registry row is removed last.
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

### `oad doctor`

Environment health report (`✓`/`✗` per check, or `--json`): Docker daemon responsive, Compose is v2, Node satisfies the package engine range, config discovery + validation (soft when absent), context derivation, Odoo port free or its holder identified, port collisions among known stacks, state registry path/openability/writability, image input/freshness checks, template snapshot freshness, git on PATH, WSL2 detection with setup guidance, and the current prune-candidate count. Exits 1 if any hard check fails.

| Flag | Meaning |
| --- | --- |
| `--deep` | run slower container probes such as template database existence and browser-test dependency checks |
| `--json` | print the checks array as JSON |
| `--config <path>` | explicit config file path |

### `oad logs [service]`

Stream `docker compose logs` for one service of the current worktree stack (default: the Odoo service).

| Flag | Meaning |
| --- | --- |
| `--follow` | follow log output |
| `--config <path>` | explicit config file path |

### `oad shell`

Open an interactive `odoo shell` against the current worktree database (`docker compose run --rm <odoo> odoo shell -d <database>`), with full TTY passthrough. The child's exit code becomes the command's exit code.

### `oad psql [-- <args>]`

Open `psql` inside the database container connected to the current worktree database. Extra `psql` arguments pass through after `--`:

```bash
oad psql -- -c 'SELECT count(*) FROM res_partner;'
```

### `oad run [--env-file <path>]... -- <command> [args...]`

Execute any host command with the worktree environment injected — the assembled context env (`ODOO_DATABASE`, `ODOO_HTTP_PORT`, companion ports/URLs, aliases) layered over the parent environment. Each `--env-file` (repeatable) is a dotenv-style file (`KEY=value` lines, `#` comments, optional surrounding quotes stripped) whose pairs are explicit overrides: parent env < context env < env files, later files win. The child runs with full TTY passthrough and its exit code becomes the command's exit code.

```bash
oad run -- npm run test:e2e
oad run --env-file .env.e2e -- playwright test
```

| Flag | Meaning |
| --- | --- |
| `--env-file <path>` | dotenv-style overrides, repeatable (later files win; missing file = error) |
| `--config <path>` | explicit config file path |

### `oad compose -- <compose-args...>`

`docker compose` passthrough scoped to this worktree's stack: the canonical preamble (`-p <project>`, `-f <compose-file>`, `--project-directory`, context env) is prepended and the trailing arguments land verbatim, with full stdio inheritance — `logs -f` streams, interactive `exec` works. The child's exit code becomes the command's exit code.

```bash
oad compose -- ps
oad compose -- logs -f --tail 100 odoo
oad compose -- exec db bash
```

### `oad worktree create <name>`

Create a git worktree and run the full `setup` flow inside it: best-effort `git fetch origin`; base ref from `--base`, else `ODOO_WORKTREE_BASE_REF`, else origin's HEAD, else `HEAD`; `git worktree add -b <branchPrefix><name> <path> <base>`; copy the recipe's `worktree.copyFiles` that exist in the project root; then deps + image + database against the worktree as project root. Prints the worktree path when done.

With `--hook-json` (the Claude Code WorktreeCreate hook contract) the `{worktree_name, worktree_path}` payload is read from stdin, all human output goes to stderr, and stdout carries exactly one line — the final worktree path. If setup fails in hook mode the half-made worktree is force-removed and the command exits non-zero so the hook aborts the creation.

| Flag | Meaning |
| --- | --- |
| `--path <path>` | worktree directory (default: sibling `<repo-basename>-<name>`) |
| `--base <ref>` | base ref for the new branch |
| `--hook-json` | Claude Code hook mode (payload on stdin, path-only stdout) |
| `--config <path>` | explicit config file path |

### `oad worktree remove <path>`

Tear down a worktree's environment. When the directory still has a discoverable config, its own context is resolved and the stack goes down with volumes (`down --volumes` semantics) before the registry row is removed; a shared database is never torn down without `--allow-shared` (logged and skipped instead). When the directory is already gone, the registry is checked for a row whose `rootDir` matches the removed path and that recorded Compose project is torn down by label; only if no row exists does the command fall back to rebuilding identity from the directory name against the current project root. The directory itself is not deleted (git owns that).

With `--hook-json` (the WorktreeRemove hook contract) the `{worktree_path}` payload is read from stdin and the command **always exits 0** — a removal hook cannot block — logging each step to `--log-file` (directory created) when given, stderr otherwise.

| Flag | Meaning |
| --- | --- |
| `--hook-json` | Claude Code hook mode (payload on stdin, always exit 0) |
| `--allow-shared` | permit tearing down the shared database |
| `--log-file <path>` | append step logs to this file |
| `--config <path>` | explicit config file path |

### `oad eject [all|dockerfile|compose]`

Write the generated Dockerfile and/or Compose file into the repo as files you own and print the exact config patch to apply (`--write-config` rewrites the config for you, losing comments). See [Ejecting](#ejecting).

| Flag | Meaning |
| --- | --- |
| `--dockerfile-out <path>` | ejected Dockerfile path (default `Dockerfile.odoo`) |
| `--compose-out <path>` | ejected compose path (default `docker-compose.worktree.yml`) |
| `--force` | overwrite existing files / a commented config with `--write-config` |
| `--write-config` | rewrite the config in place instead of printing the patch |
| `--json` | print machine-readable JSON |
| `--config <path>` | explicit config file path |

## Machine-Readable Output (`--json`)

`info`, `list`, `doctor`, and `prune` have dedicated JSON shapes and keep stdout pure JSON (warnings go to stderr).

The mutating lifecycle commands — `setup`, `reset-db`, `update`, `test`, `down`, and `up --detach` — accept `--json` too. In JSON mode **stdout carries exactly one JSON object** (a single final line) and **everything else — decorative progress, streamed compose/Odoo subprocess output, the test tail — goes to stderr**, so a parser can always read the report with `tail -n 1 | jq` (no other line ever reaches stdout).

Every report shares this core:

```json
{ "ok": true, "command": "reset-db", "database": "kl_feature_x", "composeProjectName": "kl_kl_feature_x", "odooHttpPort": 18119, "durationMs": 4180, "actions": ["restore-from-template"] }
```

- `ok` — `true` on success; `false` on failure or (for `test`) a non-zero child exit.
- `composeProject` is kept as a back-compat alias of `composeProjectName`.
- `odooUrl` is the derived `/web` URL to open in a browser; `odooExplicitDbUrl` keeps the older `?db=` selector form available for tooling that wants it.
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

Every lifecycle command records its environment (compose project, database, root dir, branch, port, timestamps, template metadata) in a shared SQLite registry so `list`, `prune`, port holder detection, and cleanup can see sibling worktrees. The default shared path is `${XDG_DATA_HOME:-~/.local/share}/odoo-agentic-dev/state.db`. If that location cannot be created or written (for example inside a restricted Codex sandbox), the CLI falls back to `.odoo-agentic-dev/state.db` under the nearest `odoo-agentic-dev.config.*` root, or under the current working directory when no config is discoverable. `ODOO_AGENTIC_DEV_STATE_DB` remains an absolute override for CI, tests, or an explicitly chosen repo-local registry. The registry needs no setup and no external dependency beyond the supported Node runtime.

The registry is an index — Docker is the truth. Generated compose files stamp `dev.basaltbytes.oad.*` identity labels on services, volumes, and networks so `list`/`prune`/`doctor` can reconcile rows against reality and re-adopt stacks whose rows were lost. Project-supplied compose files (recipe `compose.file`) are not stamped with OAD labels; those environments are tracked by their registry rows and cleaned by their Docker Compose project label while the row exists.

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

Every compose subprocess runs with the full context env exported (the same variables `info --env` prints, merged over the parent environment), so a project-supplied compose file can interpolate `${ODOO_DATABASE:?}` or `${ODOO_HTTP_PORT:?}` directly. When `compose.file` is set together with `odoo.build`, the CLI still writes `.odoo-agentic-dev/Dockerfile.generated`; your compose file can point a service build at that generated Dockerfile while owning the rest of the stack.

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
| `ODOO_AGENTIC_DEV_STATE_DB` | State registry path override (default shared state DB, with worktree-local fallback when the shared location is not writable) |

Explicit env overrides win over derived values, but `E2E_ODOO_DB` and `ODOO_DATABASE` must not disagree.

Companion apps contribute their own variables to the context env: `portEnv` receives the allocated port and `urlEnv` receives `http://localhost:<port>`; both show up in `info --env` and `info --json`. Compatibility aliases for existing projects (for example `KL_WORKTREE_DB_NAME`) can be declared in the recipe via `envAliases`: an alias may target **any** assembled env key — canonical or companion-provided (`E2E_PWA_PORT: "PWA_PORT"` works) — and an alias targeting an unknown key fails validation listing the available keys.

## Safety Rules

- An existing shared database (the recipe's `project.sharedDatabase`, used by `project.sharedBranches`) is never deleted without `--allow-shared`; first creation is allowed when the database is absent.
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
oad eject            # all (Dockerfile + compose), prints the config patch
oad eject compose    # just the compose file
oad eject dockerfile # just the Dockerfile (needs an odoo.build block)
oad eject --write-config   # also rewrite the config in place
```

`eject` converts generated infra into project-owned files: it writes the Dockerfile (`Dockerfile.odoo`) and/or the compose file (`docker-compose.worktree.yml`) into the repo as plain, editable files and points the config at them via the existing `odoo.dockerfile` / `compose.file` escape hatches. There are no new runtime concepts — eject just automates stepping onto hatches the CLI already supports.

**When to eject:** you need custom services the generated compose does not model (extra containers, exotic networking), deliberate LAN exposure, or your team simply prefers infra it can see and edit in the repo.

**What you keep.** Everything that makes the CLI worth using still works against an ejected stack: database/port derivation, the full context env injection (`compose.file` consumers run with the same variables `info --env` prints, so the ejected compose's `${ODOO_DATABASE:?}` / `${ODOO_HTTP_PORT:?}` interpolations always resolve), the worktree lifecycle (`setup`/`up`/`down`/`reset-db`), and the safety guards (shared-database protection, loopback-only binding, unsafe-name rejection). The ejected files are **portable**: the compose render emits interpolations instead of the current worktree's baked literals, so one file serves every worktree.

**What you give up.** Config-driven infra upgrades. Once ejected, changes to `odoo.build` no longer regenerate your Dockerfile, and improvements to the generated compose file in future CLI releases no longer reach you — those files are yours to maintain.

By default eject prints a ready-to-apply config patch and changes nothing else; pass a path to override the destination (`--dockerfile-out` / `--compose-out`), `--force` to overwrite an existing file, and `--json` for a machine-readable `{ ok, written, configPatch, configWritten }` object. `--write-config` rewrites the config in place and discards comments, so it refuses a commented file without `--force`. `eject dockerfile` refuses a stock-image config — there is nothing to eject; add an `odoo.build` block first, or eject only the compose file.

## Troubleshooting

### pnpm 11 blocks install on `msgpackr-extract`

`@effect/platform-node` may pull `msgpackr-extract`, which has a native build script. pnpm 11 requires an explicit build-script decision in non-interactive installs. If a consumer repo fails install before `oad` can run, record the denial once:

```bash
pnpm approve-builds '!msgpackr-extract'
```

This writes the package-manager policy to the consumer repo so future installs do not hang or fail.

### Odoo browser tests skipped

If Odoo reports a browser or Hoot suite as skipped because `websocket-client` is missing, add it to the image:

```ts
odoo: {
  build: {
    pipPackages: ["websocket-client"],
  },
}
```

Then rebuild and rerun with `oad test --build ...`, `oad restart --rebuild`, or `oad setup`. `oad test` fails known browser infrastructure skip patterns instead of reporting a misleading green exit. For deeper local diagnosis, run `oad doctor --deep` to check whether `websocket-client` imports inside the Odoo image.

## Releasing

Releases are published by CI via [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) — no npm token exists anywhere. The repository and package are public, so npm generates provenance attestations for trusted-publishing releases. Bump the version in `package.json`, commit, tag `v<version>`, and push the tag; `.github/workflows/release.yml` runs the full gate (`prepublishOnly`), including a packed npm install smoke test, publishes with provenance, and creates a GitHub Release with generated notes. The tag must match `package.json` or the workflow refuses.

The npm tarball intentionally contains only the compiled CLI/library output, `README.md`, `LICENSE`, `package.json`, and `docs/AGENTS-SNIPPET.md`. It does not ship repository tests, source TypeScript, or CI-only scripts.

## Development

```bash
pnpm install
pnpm build         # compile to dist/
pnpm test          # unit + e2e tests (e2e runs against dist/cli.js when built)
pnpm package:smoke # pack, install into a temp project, and smoke-test oad
pnpm typecheck     # tsc --noEmit over src + test
pnpm lint          # oxlint
pnpm format        # oxfmt --write
pnpm format:check  # oxfmt --check
```

The test suite never requires Docker, Git state, or a network connection — adapters are faked, and every state-touching test pins `ODOO_AGENTIC_DEV_STATE_DB` to a temp file so your real registry is never touched. `scripts/docker-integration.sh` is a separate minimal Docker integration check (compose file generation + validation against a real Docker) used by the Linux CI job; it is not part of `pnpm test`. `pnpm package:smoke` installs the packed tarball with npm in a temporary project, so it may need registry access to resolve runtime dependencies.

CI runs lint/typecheck/build/test on Linux, macOS, and Windows across Node 22 and 24 (the Windows job exercises the dry-run unit suite only — no Docker), plus Docker integration and packed npm install smoke jobs on Linux. A nightly workflow (`.github/workflows/nightly.yml`, also runnable via `workflow_dispatch`) exercises the real `odoo:18` + `postgres:16` lifecycle end to end: `setup` with a template snapshot, `reset-db` down the template restore path, `update base`, and a fully clean `down --volumes`.
