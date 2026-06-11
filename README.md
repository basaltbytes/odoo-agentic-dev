# @basaltbytes/odoo-agentic-dev

`odoo-agentic-dev` (short alias: `oad`) is an agent-friendly local Odoo development runtime. From the current Git worktree it derives a deterministic database name, deterministic ports, and a namespaced Docker Compose project, then drives the full lifecycle around them: set up a fresh checkout, start Odoo and PostgreSQL, reset and re-initialize the database, update modules, run tests, and start optional companion apps such as a Vite PWA — each branch, agent session, or bug reproduction gets its own isolated stack that cannot collide with the others.

Projects describe themselves with one typed recipe file (`odoo-agentic-dev.config.ts`) instead of copied shell scripts and Compose files. The CLI is built for non-interactive use: flags replace prompts, output is deterministic, `info --json` exposes the whole resolved context to tooling, and destructive actions are guarded so a coding agent (or a tired human) cannot accidentally delete a shared database.

## Requirements

- Node.js 20 or newer
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
    range: 1000
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
      env: {
        VITE_SERVICE_API_URL: "",
        VITE_ODOO_DATA_BASE_NAME: "$ODOO_DATABASE",
        VITE_E2E_PROXY_API_URL: "$ODOO_BASE_URL"
      }
    }
  ]
});
```

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

Prepare a new worktree: initialize Git submodules (if the recipe asks for it), run the recipe's package manager install steps, ensure the Docker image builds, reset and initialize the current worktree database, run post-init hooks, and print URLs. It prints the resolved database before destructive work and never deletes a shared database by default.

| Flag | Meaning |
| --- | --- |
| `--skip-install` | skip submodule + package manager steps |
| `--skip-db` | skip database reset/initialization |
| `--allow-shared` | permit acting on the shared database |
| `--config <path>` | explicit config file path |

### `odoo-agentic-dev up`

Start Odoo (and PostgreSQL) on the derived port, then the configured companion apps with context-derived env injected (`ODOO_DATABASE`, `ODOO_BASE_URL`, per-app ports). In attached mode, Ctrl-C stops all child processes and the first failing process is reported.

| Flag | Meaning |
| --- | --- |
| `--odoo-only` | skip companion apps |
| `--no-build` | start containers without rebuilding the image |
| `--logs` | follow Odoo logs after start |
| `--detach` | start containers and return |
| `--config <path>` | explicit config file path |

### `odoo-agentic-dev down`

Stop the current worktree stack. Uses the derived Compose project name, so other worktrees are never affected.

| Flag | Meaning |
| --- | --- |
| `--volumes` | also remove this worktree's volumes (guarded for shared databases) |
| `--allow-shared` | permit acting on the shared database |
| `--config <path>` | explicit config file path |

### `odoo-agentic-dev reset-db`

Delete and recreate the current worktree database and filestore, terminate active database sessions first, install the initial modules, and run post-init hooks. Refuses unsafe database names.

| Flag | Meaning |
| --- | --- |
| `--allow-shared` | permit resetting the shared database |
| `--modules <list>` | comma-separated module list (defaults to the recipe's `initialModules`) |
| `--without-demo <mode>` | demo-data mode passed straight to Odoo's `--without-demo` |
| `--config <path>` | explicit config file path |

Demo data is controlled at database initialization time, not per test run. The recipe's `database.withoutDemo` sets the default: a string mode (for example `"all"`) is passed to Odoo's `--without-demo`, while `withoutDemo: false` omits the flag entirely so Odoo installs demo data. The `--without-demo <mode>` flag overrides the recipe for one reset, passing the mode string straight through to Odoo.

### `odoo-agentic-dev update <modules>`

Update modules in the current worktree database. Starts PostgreSQL if needed, stops Odoo before the update when needed, and restarts Odoo after a successful update unless `--no-restart` is passed.

```bash
pnpm exec odoo-agentic-dev update KL_setup
pnpm exec odoo-agentic-dev update KL_base,KL_sale,KL_stock
```

| Flag | Meaning |
| --- | --- |
| `--no-restart` | do not restart Odoo after the update |
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
| `--config <path>` | explicit config file path |

### `odoo-agentic-dev link-source`

Create or refresh a local Odoo source pointer such as `.odoo` (a symlink on macOS/Linux/WSL2). Resolution order: `--target`, then the recipe's `odoo.source` (unless it is `"docker-only"`), then a conventional `../odoo` sibling checkout. It refuses to overwrite anything that is not a symlink, and replaces an existing symlink only with `--force`. The runtime never requires this link; it exists for IDE navigation and direct source inspection.

| Flag | Meaning |
| --- | --- |
| `--target <path>` | explicit source checkout path (absolute or relative to the project root) |
| `--name <link-name>` | link name (default `.odoo`) |
| `--force` | replace an existing symlink |
| `--config <path>` | explicit config file path |

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

Explicit env overrides win over derived values, but `E2E_ODOO_DB` and `ODOO_DATABASE` must not disagree. Compatibility aliases for existing projects (for example `KL_WORKTREE_DB_NAME`) can be declared in the recipe via `envAliases`.

## Safety Rules

- A shared database (the recipe's `project.sharedDatabase`, used by `project.sharedBranches`) is never deleted without `--allow-shared`.
- Database names outside the safe pattern `^[a-z][a-z0-9_]*$` (max 63 chars) are rejected.
- Destructive actions never run with an empty Compose project name.
- `link-source` never overwrites a non-symlink path.
- The resolved database and Compose project are printed before destructive work.
- Config validation failures fail closed: no command proceeds on an invalid recipe.
- Confirmations are flags-only — there are no interactive prompts, so non-interactive agents never hang waiting for input.

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

The test suite never requires Docker, Git state, or a network connection — adapters are faked. `scripts/docker-integration.sh` is a separate minimal Docker integration check (compose file generation + validation against a real Docker) used by the Linux CI job; it is not part of `pnpm test`. The full Odoo image lifecycle is intentionally out of scope for CI v1 — the Odoo image pull is gigabytes.

CI runs lint/typecheck/build/test on Linux, macOS, and Windows (the Windows job exercises the dry-run unit suite only — no Docker), plus the Docker integration job on Linux.
