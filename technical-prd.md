# Technical PRD: BasaltBytes Odoo Agentic Dev

Date: 2026-06-10  
Status: Draft for a new project/session  
Target package scope: `@basaltbytes`

## Naming Decision

Package name:

```text
@basaltbytes/odoo-agentic-dev
```

The worktree runtime is one module inside the package, not the whole product. The larger product is an agent-friendly local Odoo development toolkit: worktree isolation, project recipes, setup/reset/update/test commands, logs, companion apps, and safety checks.

Suggested binary names:

```text
odoo-agentic-dev
oad
```

Docs should use `odoo-agentic-dev` for clarity. `oad` can exist as a short daily-use alias.

## Problem Statement

Odoo projects often need multiple local development copies running at the same time: one per branch, one per agent session, one per bug reproduction, or one per feature worktree. Today that setup usually depends on project-local shell scripts, copied Docker Compose files, manually chosen database names, fixed ports, and ad hoc reset commands.

The KRISS LAURE workspace already has the useful pattern: derive a database name from the current Git worktree, derive ports from that name, namespace Docker Compose resources, run Odoo and PostgreSQL, install project modules, and optionally start a frontend. That worktree pattern should become one reusable module inside a broader BasaltBytes CLI for agentic Odoo development.

The reusable tool should support projects that look different:

- single-repo Odoo addon projects
- monorepos with frontend and backend folders
- Git submodule workspaces
- Odoo-only projects with no frontend
- projects using external Odoo source checkouts
- projects that run Odoo only through Docker

Windows support means WSL2 support. Native PowerShell and `cmd.exe` execution are not part of the first version, but the TypeScript core should avoid Bash assumptions so native Windows can be reconsidered later without a rewrite.

## Product Goal

Build a TypeScript CLI, using Effect v4, that gives Odoo projects an agent-friendly local development runtime:

- deterministic database names
- deterministic ports
- namespaced Docker Compose projects and volumes
- reset/install/update/test lifecycle commands
- typed project recipes
- optional companion apps such as a Vite PWA
- clear safety checks around shared databases and destructive actions
- future room for agent workflows such as project introspection, test profiles, issue reproduction, and per-task environments

The first implementation should be useful as a project-local CLI and later publishable as an npm package under `@basaltbytes`.

## Non-Goals

The tool will not manage production Odoo deployments.

The tool will not replace Odoo module scaffolding, migrations, manifest validation, or Odoo ORM testing frameworks.

The tool will not require a frontend. Companion apps are optional adapters.

The tool will not try to support native Windows shells in v1. It should run on macOS, Linux, and Windows through WSL2.

The tool will not assume one addon layout such as `addons/Custom` and `addons/OCA`.

The tool will not require a `.odoo` symlink. A source link command may exist, but the runtime should work from configured paths.

## Primary Users

1. Odoo developers who need one database per feature branch.
2. AI coding agents that create temporary worktrees and need isolated Odoo stacks.
3. Technical leads who want a shared local workflow across several Odoo projects.
4. QA or support engineers reproducing bugs in disposable local databases.
5. Developers working on a monorepo where Odoo is only one part of the stack.

## Supported Runtime Environments

V1 support matrix:

| Environment | Support |
| --- | --- |
| macOS + Docker Desktop | Supported |
| Linux + Docker Engine | Supported |
| Windows + WSL2 + Docker Desktop WSL integration | Supported |
| Windows PowerShell/cmd without WSL2 | Not supported in v1 |
| CI Linux runner | Supported |
| CI Windows runner | Dry-run tests only in v1 |

WSL2 guidance:

- clone repositories inside the WSL filesystem, not under `/mnt/c`
- install Node, package manager, Git, and Docker CLI inside WSL
- enable Docker Desktop WSL integration
- pass paths as Linux paths

## Technical Direction

Use TypeScript with Effect v4.

The tool should use Effect because this problem is mostly controlled side effects:

- process execution
- file reads and writes
- config loading
- long-running process supervision
- streaming logs
- user-facing failures
- resource cleanup

Effect services should model the external world. Project logic should stay testable without Docker, Git, or a real filesystem.

Expected Effect packages:

- `effect`
- `@effect/cli`
- `@effect/platform`
- `@effect/platform-node`

The implementation should use Effect platform command execution rather than shell strings. For example, Docker Compose should run as:

```ts
Command.make("docker", "compose", "-p", projectName, "-f", composeFile, "up", "-d", "--build", "odoo")
```

The tool should not run:

```ts
"ODOO_DATABASE=foo docker compose up -d"
```

Environment variables belong in the spawned process environment map.

## Package Shape

Proposed repo layout:

```text
packages/odoo-agentic-dev/
  package.json
  tsconfig.json
  src/
    cli.ts
    commands/
      info.ts
      setup.ts
      up.ts
      down.ts
      reset-db.ts
      update.ts
      test.ts
      link-source.ts
    core/
      worktree-context.ts
      project-recipe.ts
      project-layout.ts
      port-allocator.ts
      database-name.ts
      compose-project.ts
    platform/
      docker-compose.ts
      git.ts
      file-system.ts
      process-supervisor.ts
      odoo-shell.ts
    config/
      load-recipe.ts
      schema.ts
    errors/
      runtime-error.ts
      config-error.ts
      docker-error.ts
      odoo-error.ts
    testing/
      fixtures.ts
      fake-adapters.ts
```

Published package:

```text
@basaltbytes/odoo-agentic-dev
```

Binary:

```json
{
  "bin": {
    "odoo-agentic-dev": "./dist/cli.js",
    "oad": "./dist/cli.js"
  }
}
```

Short alias `oad` is useful for daily use; docs should prefer the long name until the tool is widely recognized.

Filename convention:

- source files use kebab-case
- directories use kebab-case or plain lowercase
- exported TypeScript types and classes may use PascalCase
- command names use kebab-case
- config filenames use `odoo-agentic-dev.config.ts` by default

## Project Tooling

The project should be created and maintained with pnpm.

Required tools:

- `pnpm` for package management and scripts
- `oxlint` for fast linting
- `oxfmt` for formatting
- TypeScript strict mode
- Vitest or Effect's test tooling for unit tests

Baseline scripts:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "oxlint .",
    "format": "oxfmt --write .",
    "format:check": "oxfmt --check .",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

The repository should not require npm or yarn in docs unless explaining compatibility. All primary examples should use pnpm.

Initial package setup:

```bash
pnpm add effect @effect/cli @effect/platform @effect/platform-node jiti
pnpm add -D typescript oxlint oxfmt vitest @types/node
```

`jiti` is listed as the default config loader candidate because it can load `.ts` config files directly from a compiled JavaScript CLI. `tsx` is also acceptable if it fits better after implementation testing, but config loading should stay internal to the package.

Before implementation, confirm the final Oxc formatter package name and binary name. The requirement is that the project uses the Oxc formatter exposed as `oxfmt`; the install command above assumes that package name is available.

## Project Recipe

Each Odoo project should define one recipe file at its root:

```text
odoo-agentic-dev.config.ts
```

The config should be TypeScript because project hooks often need light logic. The CLI should load `.ts` config files directly, without asking the user to precompile them. Acceptable config extensions for v1:

- `odoo-agentic-dev.config.ts`
- `odoo-agentic-dev.config.mts`
- `odoo-agentic-dev.config.js`
- `odoo-agentic-dev.config.mjs`

Direct `.ts` loading can be implemented with a runtime loader such as `jiti` or `tsx` as an internal dependency of the CLI. The user should not have to install or invoke `tsx` manually.

The exported value should still remain mostly declarative.

The package must export config helper functions and config types so users can write typed config files without importing internal modules:

```ts
import {
  defineOdooAgenticDevConfig,
  type OdooAgenticDevConfig,
  type OdooAgenticDevConfigInput,
  type OdooProjectConfig,
  type OdooRuntimeConfig,
  type OdooDatabaseConfig,
  type OdooAddonMount,
  type CompanionAppConfig,
  type PostInitHook
} from "@basaltbytes/odoo-agentic-dev";
```

Required public exports:

- `defineOdooAgenticDevConfig(config)` preserves literal types and validates the shape at runtime when loaded by the CLI
- `OdooAgenticDevConfigInput` describes author-facing config before defaults
- `OdooAgenticDevConfig` describes normalized config after defaults
- individual section types support shared config fragments across repos
- hook types are exported so project teams can build typed helper arrays

The config loader should accept a direct `.ts` path:

```bash
odoo-agentic-dev info --config ./odoo-agentic-dev.config.ts
```

It should also discover `odoo-agentic-dev.config.ts` automatically from the current working directory or nearest parent project root.

Example for KRISS LAURE-like project:

```ts
import { defineOdooAgenticDevConfig } from "@basaltbytes/odoo-agentic-dev";

export default defineOdooAgenticDevConfig({
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

Example for an Odoo-only project:

```ts
import { defineOdooAgenticDevConfig } from "@basaltbytes/odoo-agentic-dev";

export default defineOdooAgenticDevConfig({
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

## Core Concepts

### Worktree Context

The Worktree Context resolves everything that must be stable for the current checkout:

- Git branch or fallback worktree name
- database name
- Compose project name
- Odoo HTTP port
- optional companion app ports
- Odoo base URL
- environment variables for child processes

Inputs:

- root directory
- recipe
- process environment
- Git state

Outputs:

```ts
type WorktreeContext = {
  readonly rootDir: string;
  readonly worktreeName: string;
  readonly databaseName: string;
  readonly composeProjectName: string;
  readonly odooHttpPort: number;
  readonly odooBaseUrl: string;
  readonly companionPorts: ReadonlyMap<string, number>;
  readonly env: Record<string, string>;
};
```

Rules:

- explicit env overrides win
- `E2E_ODOO_DB` and `ODOO_DATABASE` must not disagree
- shared branches use the shared database
- feature branches get isolated databases
- detached worktrees get deterministic fallback names
- database names must match PostgreSQL-safe Odoo database rules
- derived names should stay under PostgreSQL identifier limits

### Project Recipe

The recipe describes the project. It should not run work by itself.

The runtime reads the recipe, validates it, and chooses adapters. Validation should catch:

- duplicate addon container mount paths
- missing required fields
- invalid db prefix
- invalid port ranges
- unsupported hook types
- companion app names with unsafe characters
- addon paths outside the repo unless explicitly allowed

### Docker Compose Runtime

The runtime should own Compose execution:

- build
- up
- down
- logs
- exec
- run
- wait for database readiness

It should allow two compose strategies:

1. project-supplied compose file
2. generated compose file from the recipe

V1 should start with generated compose for the standard Odoo/Postgres stack, plus an escape hatch for a project-supplied file.

Generated compose should include:

- PostgreSQL service
- Odoo service
- named volumes
- derived Odoo port
- configured addon mounts
- configured Odoo config mount
- project-specific image name
- optional Dockerfile path

### Odoo Database Lifecycle

The database module owns:

- reset current worktree database
- remove filestore
- install initial modules
- update selected modules
- run test tags
- run an Odoo shell script
- set `ir.config_parameter` values through a safe hook

Destructive operations must include guardrails:

- refuse to reset the shared database unless `--allow-shared` or an env override is present
- print the resolved database before deletion
- fail if database name is unsafe
- fail if the Compose project name is empty

### Companion Apps

Companion apps are optional child processes.

Examples:

- React PWA
- payment mock server
- webhook relay
- docs site

The app runner should:

- start Odoo first unless told otherwise
- inject context-derived env
- allocate ports
- stream logs with app prefixes
- stop child processes on Ctrl-C
- report which process failed first

Odoo-only projects do not configure companion apps.

### Odoo Source Resolver

Some workflows need a local Odoo source checkout for direct inspection, tests, or IDE navigation.

The resolver should support:

- configured absolute path
- configured relative path
- conventional sibling path such as `../odoo`
- optional worktree sibling lookup
- Docker-only mode with no local source path

The resolver should not require a symlink. A separate command can create one:

```bash
odoo-agentic-dev link-source
```

On WSL/macOS/Linux it may create `.odoo` as a symlink. On native Windows later, it may use a directory junction. The runtime should not depend on the link.

## CLI Commands

### `odoo-agentic-dev info`

Print the resolved context without starting containers.

Required output:

```text
Worktree: feature/KL-123-payment-flow
Database: kl_123_payment_flow
Compose project: kriss_laure_kl_123_payment_flow
Odoo URL: http://127.0.0.1:18442/web?db=kl_123_payment_flow
PWA URL: http://localhost:28401
```

Options:

- `--json`
- `--env`
- `--config <path>`

Acceptance:

- works without Docker running
- works without dependencies installed in companion apps
- has deterministic output for the same branch and recipe

### `odoo-agentic-dev setup`

Prepare a new worktree.

Default behavior:

- initialize Git submodules if recipe asks for it
- run package manager install commands from the recipe
- ensure Docker image can build
- reset and initialize the current database
- run post-init hooks
- print URLs

Options:

- `--skip-install`
- `--skip-db`
- `--allow-shared`
- `--config <path>`

Acceptance:

- does not delete shared databases by default
- exits with a clear message when Docker is missing
- prints the resolved database before destructive work

### `odoo-agentic-dev up`

Start Odoo and configured companion apps.

Options:

- `--odoo-only`
- `--no-build`
- `--logs`
- `--detach`

Acceptance:

- starts Odoo on the derived port
- starts companion apps only when configured
- injects `ODOO_DATABASE`, `ODOO_BASE_URL`, and companion env values
- stops child processes on Ctrl-C in attached mode

### `odoo-agentic-dev down`

Stop the current worktree stack.

Options:

- `--volumes`
- `--allow-shared`

Acceptance:

- uses the derived Compose project name
- does not affect other worktrees

### `odoo-agentic-dev reset-db`

Delete and recreate the current worktree database and filestore.

Options:

- `--allow-shared`
- `--modules <list>`
- `--without-demo <mode>`

Acceptance:

- refuses unsafe database names
- terminates active database sessions before deletion
- runs configured initial modules
- runs post-init hooks

### `odoo-agentic-dev update <modules>`

Update modules in the current worktree database.

Examples:

```bash
odoo-agentic-dev update KL_setup
odoo-agentic-dev update KL_base,KL_sale,KL_stock
```

Acceptance:

- starts PostgreSQL if needed
- stops Odoo before module update when needed
- restarts Odoo after a successful update unless `--no-restart` is passed

### `odoo-agentic-dev test`

Run Odoo tests against the current database.

Options:

- `--tags <tags>`
- `--file <path>`
- `--module <name>`
- `--log-level <level>`
- `--include-demo`

Acceptance:

- maps options to Odoo CLI flags
- returns a non-zero exit code on test failure
- supports recipe-provided test profiles

### `odoo-agentic-dev link-source`

Create or refresh a local source pointer such as `.odoo`.

Options:

- `--target <path>`
- `--name <link-name>`
- `--force`

Acceptance:

- refuses to overwrite a real directory
- prints the resolved source path
- works in WSL/macOS/Linux with symlinks

## Recipe Hook Types

V1 hook types:

```ts
type PostInitHook =
  | { type: "odoo-shell-file"; file: string }
  | { type: "odoo-shell-inline"; code: string }
  | { type: "set-ir-config-parameter"; key: string; value: string }
  | { type: "command"; command: string; args: ReadonlyArray<string>; cwd?: string };
```

Preferred hooks:

- `odoo-shell-file`
- `set-ir-config-parameter`

Inline code is convenient but harder to review. Use it sparingly.

All hook files should resolve relative to the project root unless explicitly marked as package resources.

## Error Model

Errors should be typed and rendered for humans.

Suggested error groups:

```ts
type RuntimeError =
  | ConfigLoadError
  | ConfigValidationError
  | GitError
  | UnsafeDatabaseNameError
  | SharedDatabaseProtectionError
  | DockerUnavailableError
  | ComposeCommandError
  | OdooCommandError
  | CompanionProcessError
  | SourceResolverError;
```

CLI rendering should include:

- what failed
- command attempted, when safe to show
- working directory
- exit code
- next action

Do not dump huge logs by default. Write logs to a file or show a short tail.

## Environment Variables

Core env:

| Variable | Meaning |
| --- | --- |
| `ODOO_DATABASE` | Current worktree Odoo database |
| `E2E_ODOO_DB` | Alias for test tooling |
| `ODOO_BASE_URL` | Odoo HTTP origin |
| `ODOO_HTTP_PORT` | Host port for Odoo |
| `ODOO_COMPOSE_PROJECT_NAME` | Docker Compose project |
| `ODOO_WORKTREE_NAME` | Override for derived worktree name |
| `ODOO_WORKTREE_CONFIG` | Config file path override |

Compatibility env for existing projects may be supported through recipe aliases. For KRISS LAURE that includes `KL_WORKTREE_DB_NAME`, `PWA_PORT`, and `E2E_BASE_URL`.

## Safety Rules

The CLI must avoid accidental data loss.

Rules:

- never delete a shared database without explicit confirmation or `--allow-shared`
- never accept database names outside the safe pattern
- never run destructive actions when the Compose project name is empty
- never overwrite a non-symlink `.odoo` path
- print resolved context before destructive work
- fail closed when config validation fails

For non-interactive agent use, flags should replace prompts. Agents should not get stuck waiting for input.

## Testing Strategy

Tests should focus on module interfaces, not implementation details.

Unit tests:

- branch name to database name
- long branch truncation and hash suffix
- shared branch handling
- port derivation stability
- env override precedence
- config validation
- generated Compose model
- command argument construction
- unsafe database protection
- hook expansion

Adapter tests:

- fake Git adapter returns expected branch/worktree data
- fake CommandExecutor records Docker calls
- fake filesystem resolves config and hook files

Integration tests:

- `info --json` on Linux/macOS/Windows CI
- dry-run setup produces expected command sequence
- generated compose file validates as YAML
- Docker integration test on Linux runner

WSL2 should be documented and manually tested before declaring support. Native Windows dry-runs can run later because the TypeScript core should not depend on Bash.

## Build and Distribution

Build output:

```text
dist/
  cli.js
  index.js
  index.d.ts
```

Runtime expectations:

- ESM package
- compiled JavaScript checked by TypeScript
- no user-installed `tsx` or precompiled config file needed for project config loading
- no shell needed for core commands

For repo-local use before publishing:

```json
{
  "scripts": {
    "odoo:info": "odoo-agentic-dev info",
    "dev:info": "odoo-agentic-dev info",
    "dev:setup": "odoo-agentic-dev setup",
    "dev": "odoo-agentic-dev up",
    "odoo:u": "odoo-agentic-dev update",
    "odoo:down": "odoo-agentic-dev down"
  },
  "devDependencies": {
    "@basaltbytes/odoo-agentic-dev": "workspace:*"
  }
}
```

For projects that need setup before dependencies are installed, keep a tiny bootstrap script:

```bash
#!/usr/bin/env bash
set -euo pipefail
corepack enable pnpm >/dev/null 2>&1 || true
pnpm install
pnpm exec odoo-agentic-dev setup
```

That script is acceptable for macOS/Linux/WSL2. It should stay small and contain no project logic.

## Migration Plan From KRISS LAURE Scripts

Phase 1: Context parity.

- port database naming, compose project naming, and port derivation to TypeScript
- add `odoo-agentic-dev.config.ts`
- make `odoo-agentic-dev info` match current `pnpm dev:info`
- keep existing scripts

Phase 2: Compose parity.

- implement Docker Compose adapter
- support existing `docker-compose.worktree.yml`
- add generated compose support behind a flag
- replace `scripts/compose.sh` with a wrapper around the CLI

Phase 3: Database lifecycle.

- implement reset/install/update/test flows
- move KRISS LAURE post-init Python into a hook file
- keep safety behavior for shared database deletion

Phase 4: Companion apps.

- model the PWA as a companion app
- replace `scripts/dev.sh` and `scripts/pwa-dev.sh`
- support Odoo-only mode

Phase 5: Package extraction.

- move reusable code into `@basaltbytes/odoo-agentic-dev`
- keep KRISS LAURE recipe in the KRISS LAURE repo
- publish docs with examples for single repo, monorepo, and submodule layouts

## Acceptance Criteria

V1 is ready when:

- a new Odoo-only project can configure the tool with one recipe file
- a KRISS LAURE-like monorepo can run Odoo and a PWA through companion apps
- `info` works without Docker
- `setup` can recreate a worktree database
- `update` can update selected Odoo modules
- `down --volumes` removes only the current worktree stack
- shared databases cannot be deleted accidentally
- macOS, Linux, and WSL2 instructions are documented
- unit tests cover context derivation and command construction
- CI runs dry-run tests without Docker
- one Linux CI job runs a minimal Docker integration test

## Open Questions

1. Should the package generate Docker Compose YAML, or should every project supply its own compose file?
2. Should recipes be TypeScript only, or should JSON/YAML recipes be supported for simpler Odoo-only projects?
3. Should the CLI include project scaffolding, or should setup stay manual in v1?
4. Should `link-source` create `.odoo` by default, or should it require an explicit flag?
5. Should docs mention npm/yarn compatibility at all, or keep the official path pnpm-only?
6. How much native Windows support should be tested if WSL2 is the official Windows path?
7. Should test profiles live in the recipe, for example `payment`, `invoice`, `http`, or stay as raw CLI flags?
8. Should post-init hooks run before or after `ir.config_parameter` hooks?
9. Should destructive commands support interactive confirmation, or should they require flags only?
10. Should the CLI support remote Docker contexts in v1?

## Suggested First Slice

Build only this:

```bash
odoo-agentic-dev info --json
```

It should load a recipe, inspect Git, derive the database name, derive the Compose project, derive ports, and print stable JSON.

That slice proves the config shape, Effect runtime wiring, Git adapter, validation, naming rules, and test setup without touching Docker or Odoo. Once that is solid, the remaining commands are mostly adapters around the same context.

## Notes For The Next Session

Start the new project outside KRISS LAURE. Treat KRISS LAURE as an example recipe, not the home of the reusable runtime.

Recommended first project name:

```text
@basaltbytes/odoo-agentic-dev
```

Recommended first command:

```bash
pnpm init
pnpm add effect @effect/cli @effect/platform @effect/platform-node jiti
pnpm add -D typescript oxlint oxfmt vitest @types/node
```

Before coding Docker behavior, write tests for the context module. Most bugs in this tool will come from wrong names, wrong paths, wrong ports, or unsafe deletion logic. Those are cheap to test without containers.
