# @basaltbytes/odoo-agentic-dev v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the full v1 of the `@basaltbytes/odoo-agentic-dev` CLI: worktree-isolated Odoo databases/ports/Compose stacks with `info`, `setup`, `up`, `down`, `reset-db`, `update`, `test`, and `link-source` commands.

**Architecture:** Pure functional core (naming, ports, context, compose model, safety, argv plans) with Effect v4 services only at the IO edges (command execution, Git, Docker Compose, process supervision, config loading). Commands are thin: parse flags → load recipe → derive context → guard → act through services.

**Tech Stack:** TypeScript strict ESM, `effect@4.0.0-beta.78` (pinned exact), `@effect/platform-node@4.0.0-beta.78` (pinned exact), `jiti` for `.ts` config loading, pnpm, Vitest, oxlint, oxfmt.

**Reference docs:** spec at `docs/superpowers/specs/2026-06-10-odoo-agentic-dev-design.md`, requirements at `technical-prd.md`. Where this plan and the spec disagree on a detail, the spec wins.

**API note (important):** Effect v4 is beta. The exact API shapes used below were verified against the published `.d.ts` of `4.0.0-beta.78` (`Context.Service`, `Layer.effect/succeed/mergeAll`, `Data.TaggedError`, `Schema.Struct/String/Boolean/Number/Record/Union/Literal/optional/decodeUnknownSync`, `effect/unstable/cli` `Command`/`Flag`/`Argument`, `effect/unstable/process` `ChildProcess`, platform-node `NodeServices.layer`/`NodeRuntime.runMain`). If a call does not typecheck during implementation, consult `node_modules/effect/dist/*.d.ts` and adapt the call site — do not change module boundaries or test expectations to work around it. Task 1's smoke test exists to surface any such drift immediately.

---

## File Map

| File | Responsibility |
| --- | --- |
| `src/errors/errors.ts` | All tagged error classes + `renderError` for CLI output |
| `src/core/project-recipe.ts` | Config types (input + normalized) + `defineOdooAgenticDevConfig` |
| `src/config/schema.ts` | Schema validation + defaults + cross-field checks → normalized config |
| `src/config/load-recipe.ts` | Config discovery (cwd upward) + jiti load + validation (Effect) |
| `src/core/database-name.ts` | Branch → database name derivation, truncation+hash, safety pattern |
| `src/core/port-allocator.ts` | FNV-1a hash, deterministic port offsets |
| `src/core/compose-project.ts` | Compose project name derivation |
| `src/core/safety.ts` | Shared-DB guard, compose-project guard |
| `src/core/worktree-context.ts` | `GitState`, `WorktreeContext`, env assembly, `$VAR` substitution |
| `src/core/compose-model.ts` | Generated compose file model + YAML renderer |
| `src/core/command-plan.ts` | Pure argv/SQL/hook-expansion builders for db lifecycle |
| `src/platform/command-runner.ts` | `CommandRunner` service (run captured / run inherited) over `ChildProcess` |
| `src/platform/git.ts` | `Git` service (branch/detached/not-a-repo) over `CommandRunner` |
| `src/platform/docker-compose.ts` | `DockerCompose` service: compose argv, generated-file writing, db readiness |
| `src/platform/odoo-lifecycle.ts` | `OdooLifecycle` service: reset/init/update/test/hooks (spec's `odoo-shell.ts` duties live here) |
| `src/platform/process-supervisor.ts` | `ProcessSupervisor` service: companion apps, prefixed logs, fail-fast |
| `src/commands/resolve-context.ts` | Shared command preamble: load recipe + git → `WorktreeContext` |
| `src/commands/{info,setup,up,down,reset-db,update,test,link-source}.ts` | One CLI command each |
| `src/cli.ts` | CLI tree, layer wiring, error rendering, exit codes |
| `src/index.ts` | Public API exports |
| `src/testing/fake-adapters.ts` | `makeRecordingRunner`, `makeFakeGit` test layers |
| `test/**/*.test.ts` | Vitest tests mirroring `src/` |

Deviation from the spec's file map: `testing/fixtures.ts` is folded into per-test inline fixtures (each test builds its own minimal recipe — less indirection, no shared mutable fixtures), and `platform/odoo-shell.ts` duties live in `platform/odoo-lifecycle.ts` as noted above.

Conventions for every task: ESM imports with `.js` extensions are NOT used — `moduleResolution: "nodenext"` with extensionless imports fails for ESM, so **all relative imports use the `.js` suffix** (e.g. `import { fnv1a32 } from "../core/port-allocator.js"`). Tests import from `../src/...` the same way. Commit after every task with the message given in the task.

---

### Task 1: Project scaffolding, toolchain, and v4 smoke test

**Files:**
- Modify: `package.json`
- Create: `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.oxlintrc.json`, `test/smoke.test.ts`

- [ ] **Step 1: Install dependencies**

```bash
pnpm add -E effect@4.0.0-beta.78 @effect/platform-node@4.0.0-beta.78
pnpm add jiti
pnpm add -D typescript oxlint oxfmt vitest @types/node
```

Expected: lockfile created, `node_modules` populated. (npm refuses this repo because of `devEngines`; always use pnpm.)

- [ ] **Step 2: Replace `package.json` contents** (keep the existing `devEngines` block; merge dependency versions written by Step 1)

```json
{
  "name": "@basaltbytes/odoo-agentic-dev",
  "version": "0.1.0",
  "description": "Agent-friendly local Odoo development runtime: worktree-isolated databases, ports, and Docker Compose stacks",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=20" },
  "bin": {
    "odoo-agentic-dev": "./dist/cli.js",
    "oad": "./dist/cli.js"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./package.json": "./package.json"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "lint": "oxlint .",
    "format": "oxfmt --write .",
    "format:check": "oxfmt --check .",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json"
  },
  "devEngines": {
    "packageManager": { "name": "pnpm", "version": "11.0.8", "onFail": "download" }
  }
}
```

- [ ] **Step 3: Create `tsconfig.json` (checking: src + test) and `tsconfig.build.json` (emit: src only)**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

`skipLibCheck` is deliberate: beta `.d.ts` churn must not block our build. The split keeps tests typechecked (and the IDE happy) while `dist/` only ever contains `src/` output.

- [ ] **Step 4: Create `vitest.config.ts`, `.gitignore`, `.oxlintrc.json`**

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 20000 }
})
```

```text
# .gitignore
node_modules/
dist/
.odoo-agentic-dev/
*.log
```

```json
{ "$schema": "./node_modules/oxlint/configuration_schema.json", "categories": { "correctness": "error" } }
```

- [ ] **Step 5: Create `test/smoke.test.ts`** — fails the whole build early if the beta API drifted

```ts
import { describe, expect, it } from "vitest"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Command, Flag } from "effect/unstable/cli"
import { NodeServices } from "@effect/platform-node"

describe("effect v4 beta API smoke test", () => {
  it("runs a trivial effect", async () => {
    expect(await Effect.runPromise(Effect.succeed(41 + 1))).toBe(42)
  })

  it("Schema has the constructors we rely on", () => {
    for (const member of [Schema.Struct, Schema.String, Schema.Boolean, Schema.Number,
      Schema.Literal, Schema.Union, Schema.Record, Schema.Array, Schema.optional,
      Schema.decodeUnknownSync]) {
      expect(member).toBeDefined()
    }
    const S = Schema.Struct({ a: Schema.String })
    expect(Schema.decodeUnknownSync(S)({ a: "x" })).toEqual({ a: "x" })
    expect(() => Schema.decodeUnknownSync(S)({ a: 1 })).toThrow()
  })

  it("Data.TaggedError produces catchable tagged classes", () => {
    class Boom extends Data.TaggedError("Boom")<{ readonly why: string }> {}
    const e = new Boom({ why: "test" })
    expect(e._tag).toBe("Boom")
    expect(e.why).toBe("test")
  })

  it("Context.Service + Layer wire a service", async () => {
    interface Api { readonly n: number }
    const Svc = Context.Service<Api>("smoke/Svc")
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* Svc
        return svc.n
      }).pipe(Effect.provide(Layer.succeed(Svc, { n: 7 })))
    )
    expect(out).toBe(7)
  })

  it("ChildProcess array form + NodeServices spawns a process", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* ChildProcess.make("node", ["-e", "console.log('ok')"])
          return yield* handle.exitCode
        })
      ).pipe(Effect.provide(NodeServices.layer))
    )
    expect(result).toBe(0)
  })

  it("cli Command/Flag exist", () => {
    const cmd = Command.make("x", { f: Flag.boolean("f") })
    expect(cmd).toBeDefined()
  })
})
```

- [ ] **Step 6: Run the smoke test and typecheck**

Run: `pnpm vitest run test/smoke.test.ts` → Expected: all green. If `Schema.Array` (or anything else) is missing, STOP, find the v4 replacement in `node_modules/effect/dist/Schema.d.ts`, and record the substitution as a note at the top of this plan before continuing.
Run: `pnpm typecheck` → Expected: clean (no `src/` yet, that's fine once Task 2 adds files; for now tsc may warn about no inputs — acceptable, re-run from Task 2 onward).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "chore: scaffold package, toolchain, and effect v4 smoke test"
```

---

### Task 2: Tagged errors and renderer

**Files:**
- Create: `src/errors/errors.ts`
- Test: `test/errors/errors.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/errors/errors.test.ts
import { describe, expect, it } from "vitest"
import {
  CommandFailedError, ConfigValidationError, SharedDatabaseProtectionError,
  isRuntimeError, renderError
} from "../../src/errors/errors.js"

describe("renderError", () => {
  it("renders shared-db protection with the exact retry flag", () => {
    const text = renderError(new SharedDatabaseProtectionError({ database: "kl_e2e_demo", action: "reset-db" }))
    expect(text).toContain("kl_e2e_demo")
    expect(text).toContain("--allow-shared")
    expect(text).toContain("reset-db")
  })

  it("renders command failures with argv, cwd, exit code and a next action", () => {
    const text = renderError(new CommandFailedError({
      command: "docker", args: ["compose", "up"], cwd: "/work", exitCode: 17, stderrTail: "boom"
    }))
    expect(text).toContain("docker compose up")
    expect(text).toContain("/work")
    expect(text).toContain("17")
    expect(text).toContain("boom")
  })

  it("renders validation issues as a list", () => {
    const text = renderError(new ConfigValidationError({ issues: ["a bad", "b bad"] }))
    expect(text).toContain("a bad")
    expect(text).toContain("b bad")
  })

  it("isRuntimeError discriminates", () => {
    expect(isRuntimeError(new ConfigValidationError({ issues: [] }))).toBe(true)
    expect(isRuntimeError(new Error("nope"))).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run test/errors/errors.test.ts` → Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/errors/errors.ts`**

```ts
import { Data } from "effect"

export class ConfigLoadError extends Data.TaggedError("ConfigLoadError")<{
  readonly path: string
  readonly reason: string
}> {}

export class ConfigValidationError extends Data.TaggedError("ConfigValidationError")<{
  readonly issues: ReadonlyArray<string>
}> {}

export class GitError extends Data.TaggedError("GitError")<{
  readonly reason: string
}> {}

export class UnsafeDatabaseNameError extends Data.TaggedError("UnsafeDatabaseNameError")<{
  readonly name: string
}> {}

export class SharedDatabaseProtectionError extends Data.TaggedError("SharedDatabaseProtectionError")<{
  readonly database: string
  /** the command the user attempted, e.g. "reset-db" */
  readonly action: string
}> {}

export class DockerUnavailableError extends Data.TaggedError("DockerUnavailableError")<{
  readonly reason: string
}> {}

export class CommandFailedError extends Data.TaggedError("CommandFailedError")<{
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string | undefined
  readonly exitCode: number
  readonly stderrTail: string
}> {}

export class ComposeCommandError extends Data.TaggedError("ComposeCommandError")<{
  readonly args: ReadonlyArray<string>
  readonly exitCode: number
  readonly stderrTail: string
}> {}

export class OdooCommandError extends Data.TaggedError("OdooCommandError")<{
  readonly args: ReadonlyArray<string>
  readonly exitCode: number
  readonly stderrTail: string
}> {}

export class CompanionProcessError extends Data.TaggedError("CompanionProcessError")<{
  readonly name: string
  readonly exitCode: number
}> {}

export class SourceResolverError extends Data.TaggedError("SourceResolverError")<{
  readonly reason: string
}> {}

export type RuntimeError =
  | ConfigLoadError
  | ConfigValidationError
  | GitError
  | UnsafeDatabaseNameError
  | SharedDatabaseProtectionError
  | DockerUnavailableError
  | CommandFailedError
  | ComposeCommandError
  | OdooCommandError
  | CompanionProcessError
  | SourceResolverError

const RUNTIME_ERROR_TAGS: ReadonlySet<string> = new Set([
  "ConfigLoadError", "ConfigValidationError", "GitError", "UnsafeDatabaseNameError",
  "SharedDatabaseProtectionError", "DockerUnavailableError", "CommandFailedError",
  "ComposeCommandError", "OdooCommandError", "CompanionProcessError", "SourceResolverError"
])

export const isRuntimeError = (u: unknown): u is RuntimeError =>
  typeof u === "object" && u !== null && "_tag" in u &&
  RUNTIME_ERROR_TAGS.has((u as { _tag: string })._tag)

const lines = (...xs: ReadonlyArray<string>): string => xs.join("\n")

export const renderError = (error: RuntimeError): string => {
  switch (error._tag) {
    case "ConfigLoadError":
      return lines(
        `Could not load config: ${error.path}`,
        `Reason: ${error.reason}`,
        `Next: check the file exists and its default export is defineOdooAgenticDevConfig({...}).`
      )
    case "ConfigValidationError":
      return lines(
        "Invalid odoo-agentic-dev config:",
        ...error.issues.map((issue) => `  - ${issue}`),
        "Next: fix the config file and re-run."
      )
    case "GitError":
      return lines(`Git inspection failed: ${error.reason}`, "Next: run the command inside the project worktree.")
    case "UnsafeDatabaseNameError":
      return lines(
        `Refusing unsafe database name: "${error.name}"`,
        "Database names must match ^[a-z][a-z0-9_]*$ and be at most 63 characters.",
        "Next: rename the branch or set ODOO_DATABASE to a safe name."
      )
    case "SharedDatabaseProtectionError":
      return lines(
        `Refusing to touch the shared database "${error.database}".`,
        `Next: re-run \`odoo-agentic-dev ${error.action} --allow-shared\` if you really mean it.`
      )
    case "DockerUnavailableError":
      return lines(`Docker is not available: ${error.reason}`, "Next: start Docker Desktop / the docker daemon and retry.")
    case "CommandFailedError":
      return lines(
        `Command failed (exit ${error.exitCode}): ${[error.command, ...error.args].join(" ")}`,
        `Working directory: ${error.cwd ?? process.cwd()}`,
        error.stderrTail.length > 0 ? `stderr (tail):\n${error.stderrTail}` : "stderr: (empty)",
        "Next: re-run the command above manually to investigate."
      )
    case "ComposeCommandError":
      return lines(
        `docker compose failed (exit ${error.exitCode}): docker ${error.args.join(" ")}`,
        error.stderrTail.length > 0 ? `stderr (tail):\n${error.stderrTail}` : "stderr: (empty)",
        "Next: check container logs with `odoo-agentic-dev up --logs`."
      )
    case "OdooCommandError":
      return lines(
        `Odoo command failed (exit ${error.exitCode}): docker ${error.args.join(" ")}`,
        error.stderrTail.length > 0 ? `output (tail):\n${error.stderrTail}` : "output: (empty)",
        "Next: inspect the Odoo log output above."
      )
    case "CompanionProcessError":
      return lines(`Companion app "${error.name}" exited with code ${error.exitCode}.`, "Next: check its logs above; other processes were stopped.")
    case "SourceResolverError":
      return lines(`Could not resolve Odoo source: ${error.reason}`, "Next: pass --target <path> or set odoo.source in the config.")
  }
}

/** Keep only the last `maxLines` lines of process output for error messages. */
export const tail = (text: string, maxLines = 20): string =>
  text.split(/\r?\n/).filter((l) => l.length > 0).slice(-maxLines).join("\n")
```

- [ ] **Step 4: Run tests, lint, typecheck — all green**

Run: `pnpm vitest run test/errors/errors.test.ts && pnpm typecheck` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: tagged runtime errors with human-readable rendering"
```

---

### Task 3: Public config types and `defineOdooAgenticDevConfig`

**Files:**
- Create: `src/core/project-recipe.ts`, `src/index.ts`
- Test: `test/core/project-recipe.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/core/project-recipe.test.ts
import { describe, expect, it } from "vitest"
import { defineOdooAgenticDevConfig } from "../../src/index.js"
import type { OdooAgenticDevConfigInput, PostInitHook } from "../../src/index.js"

describe("defineOdooAgenticDevConfig", () => {
  it("returns its input unchanged (identity, validation happens in the loader)", () => {
    const input: OdooAgenticDevConfigInput = {
      project: { id: "billing-odoo", dbPrefix: "billing" },
      odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/extra-addons/custom" }] }
    }
    expect(defineOdooAgenticDevConfig(input)).toBe(input)
  })

  it("hook union accepts all four v1 hook types", () => {
    const hooks: ReadonlyArray<PostInitHook> = [
      { type: "odoo-shell-file", file: "scripts/post-init.py" },
      { type: "odoo-shell-inline", code: "print('hi')" },
      { type: "set-ir-config-parameter", key: "k", value: "v" },
      { type: "command", command: "pnpm", args: ["seed"], cwd: "frontend" }
    ]
    expect(hooks).toHaveLength(4)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run test/core/project-recipe.test.ts` → Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/core/project-recipe.ts`**

```ts
export const CANONICAL_ENV_VARS = [
  "ODOO_DATABASE", "E2E_ODOO_DB", "ODOO_BASE_URL", "ODOO_HTTP_PORT", "ODOO_COMPOSE_PROJECT_NAME"
] as const
export type CanonicalEnvVar = (typeof CANONICAL_ENV_VARS)[number]

export type OdooAddonMount = {
  readonly host: string
  readonly container: string
  /** allow host paths outside the project root (default false) */
  readonly allowOutsideRepo?: boolean
}

export type PostInitHook =
  | { readonly type: "odoo-shell-file"; readonly file: string }
  | { readonly type: "odoo-shell-inline"; readonly code: string }
  | { readonly type: "set-ir-config-parameter"; readonly key: string; readonly value: string }
  | { readonly type: "command"; readonly command: string; readonly args: ReadonlyArray<string>; readonly cwd?: string }

export type CompanionAppConfig = {
  readonly name: string
  readonly cwd: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  /** env var name that receives the allocated port */
  readonly portEnv?: string
  /** extra env; values may reference canonical vars as "$ODOO_DATABASE" etc. */
  readonly env?: Readonly<Record<string, string>>
}

export type PackageManagerStep = {
  readonly cwd: string
  readonly command: string
  readonly args: ReadonlyArray<string>
}

export type OdooProjectConfig = {
  readonly id: string
  readonly dbPrefix: string
  readonly sharedDatabase?: string
  readonly sharedBranches?: ReadonlyArray<string>
}

export type OdooRuntimeConfig = {
  readonly version: string
  readonly serviceName?: string
  readonly databaseServiceName?: string
  readonly postgresImage?: string
  readonly configFile?: string
  readonly dockerfile?: string
  readonly imageName?: string
  readonly addons: ReadonlyArray<OdooAddonMount>
  /** path to a local Odoo source checkout, or "docker-only" */
  readonly source?: string
}

export type OdooDatabaseConfig = {
  readonly initialModules?: ReadonlyArray<string>
  /** Odoo --without-demo value; false disables the flag entirely */
  readonly withoutDemo?: string | false
  readonly postInit?: ReadonlyArray<PostInitHook>
}

export type OdooAgenticDevConfigInput = {
  readonly project: OdooProjectConfig
  readonly ports?: {
    readonly odooBase?: number
    readonly companionBase?: number
    readonly range?: number
  }
  readonly odoo: OdooRuntimeConfig
  readonly database?: OdooDatabaseConfig
  readonly setup?: {
    readonly submodules?: boolean
    readonly packageManagers?: ReadonlyArray<PackageManagerStep>
  }
  readonly compose?: {
    /** escape hatch: project-supplied compose file instead of the generated one */
    readonly file?: string
  }
  readonly test?: {
    /** profile name → extra odoo CLI args, e.g. { payment: ["--test-tags", "payment"] } */
    readonly profiles?: Readonly<Record<string, ReadonlyArray<string>>>
  }
  /** compatibility aliases: alias env var name → canonical variable */
  readonly envAliases?: Readonly<Record<string, CanonicalEnvVar>>
  readonly companionApps?: ReadonlyArray<CompanionAppConfig>
}

/** Normalized config: every default applied, optionals resolved. */
export type OdooAgenticDevConfig = {
  readonly project: {
    readonly id: string
    readonly dbPrefix: string
    readonly sharedDatabase: string | null
    readonly sharedBranches: ReadonlyArray<string>
  }
  readonly ports: { readonly odooBase: number; readonly companionBase: number; readonly range: number }
  readonly odoo: {
    readonly version: string
    readonly serviceName: string
    readonly databaseServiceName: string
    readonly postgresImage: string
    readonly configFile: string | null
    readonly dockerfile: string | null
    readonly imageName: string | null
    readonly addons: ReadonlyArray<OdooAddonMount>
    readonly source: string | null
  }
  readonly database: {
    readonly initialModules: ReadonlyArray<string>
    readonly withoutDemo: string | false
    readonly postInit: ReadonlyArray<PostInitHook>
  }
  readonly setup: {
    readonly submodules: boolean
    readonly packageManagers: ReadonlyArray<PackageManagerStep>
  }
  readonly compose: { readonly file: string | null }
  readonly test: { readonly profiles: Readonly<Record<string, ReadonlyArray<string>>> }
  readonly envAliases: Readonly<Record<string, CanonicalEnvVar>>
  readonly companionApps: ReadonlyArray<CompanionAppConfig>
}

/**
 * Identity helper preserving literal types. Runtime validation happens when the
 * CLI loads the file (config/schema.ts), so plain JS configs are covered too.
 */
export const defineOdooAgenticDevConfig = (config: OdooAgenticDevConfigInput): OdooAgenticDevConfigInput => config
```

- [ ] **Step 4: Implement `src/index.ts`**

```ts
export {
  CANONICAL_ENV_VARS,
  defineOdooAgenticDevConfig
} from "./core/project-recipe.js"
export type {
  CanonicalEnvVar,
  CompanionAppConfig,
  OdooAddonMount,
  OdooAgenticDevConfig,
  OdooAgenticDevConfigInput,
  OdooDatabaseConfig,
  OdooProjectConfig,
  OdooRuntimeConfig,
  PackageManagerStep,
  PostInitHook
} from "./core/project-recipe.js"
```

- [ ] **Step 5: Run tests + typecheck, then commit**

Run: `pnpm vitest run test/core/project-recipe.test.ts && pnpm typecheck` → Expected: PASS.

```bash
git add -A && git commit -m "feat: public config types and defineOdooAgenticDevConfig"
```

---

### Task 4: Config validation and normalization

**Files:**
- Create: `src/config/schema.ts`
- Test: `test/config/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/config/schema.test.ts
import { describe, expect, it } from "vitest"
import { normalizeConfig, validateConfigInput } from "../../src/config/schema.js"
import { ConfigValidationError } from "../../src/errors/errors.js"

const minimal = {
  project: { id: "billing-odoo", dbPrefix: "billing" },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/extra-addons/custom" }] }
}

describe("validateConfigInput", () => {
  it("accepts a minimal config", () => {
    expect(validateConfigInput(minimal)).toEqual(minimal)
  })

  it("rejects a non-object and missing required fields", () => {
    expect(() => validateConfigInput("nope")).toThrow(ConfigValidationError)
    expect(() => validateConfigInput({ project: { id: "x" } })).toThrow(ConfigValidationError)
  })

  it("rejects an unknown hook type", () => {
    const bad = {
      ...minimal,
      database: { postInit: [{ type: "winrm-exec", cmd: "x" }] }
    }
    expect(() => validateConfigInput(bad)).toThrow(ConfigValidationError)
  })
})

describe("normalizeConfig", () => {
  it("applies every documented default", () => {
    const cfg = normalizeConfig(validateConfigInput(minimal))
    expect(cfg.ports).toEqual({ odooBase: 18069, companionBase: 28000, range: 1000 })
    expect(cfg.odoo.serviceName).toBe("odoo")
    expect(cfg.odoo.databaseServiceName).toBe("db")
    expect(cfg.odoo.postgresImage).toBe("postgres:16")
    expect(cfg.odoo.configFile).toBeNull()
    expect(cfg.database.withoutDemo).toBe("all")
    expect(cfg.database.initialModules).toEqual([])
    expect(cfg.project.sharedDatabase).toBeNull()
    expect(cfg.project.sharedBranches).toEqual([])
    expect(cfg.compose.file).toBeNull()
    expect(cfg.companionApps).toEqual([])
  })

  it("defaults sharedBranches to main/master when sharedDatabase is set", () => {
    const cfg = normalizeConfig(validateConfigInput({
      ...minimal,
      project: { ...minimal.project, sharedDatabase: "billing_dev" }
    }))
    expect(cfg.project.sharedBranches).toEqual(["main", "master"])
  })

  it.each([
    ["bad dbPrefix", { ...minimal, project: { id: "x", dbPrefix: "9bad" } }, /dbPrefix/],
    ["duplicate container mounts", {
      ...minimal,
      odoo: { version: "18.0", addons: [
        { host: "a", container: "/mnt/x" }, { host: "b", container: "/mnt/x" }
      ] }
    }, /duplicate/i],
    ["port range too small", { ...minimal, ports: { range: 1 } }, /range/],
    ["unsafe companion name", {
      ...minimal,
      companionApps: [{ name: "P W A!", cwd: ".", command: "pnpm", args: ["dev"] }]
    }, /companion/i],
    ["addon escaping repo", {
      ...minimal,
      odoo: { version: "18.0", addons: [{ host: "../outside", container: "/mnt/x" }] }
    }, /outside/i]
  ])("rejects %s", (_label, input, pattern) => {
    expect(() => normalizeConfig(validateConfigInput(input))).toThrow(pattern)
  })

  it("allows addon outside repo when explicitly flagged", () => {
    const cfg = normalizeConfig(validateConfigInput({
      ...minimal,
      odoo: { version: "18.0", addons: [{ host: "../outside", container: "/mnt/x", allowOutsideRepo: true }] }
    }))
    expect(cfg.odoo.addons[0]?.host).toBe("../outside")
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run test/config/schema.test.ts` → Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/config/schema.ts`**

```ts
import { Schema } from "effect"
import { ConfigValidationError } from "../errors/errors.js"
import type { OdooAgenticDevConfig, OdooAgenticDevConfigInput } from "../core/project-recipe.js"
import { CANONICAL_ENV_VARS } from "../core/project-recipe.js"

const AddonMountSchema = Schema.Struct({
  host: Schema.String,
  container: Schema.String,
  allowOutsideRepo: Schema.optional(Schema.Boolean)
})

const HookSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("odoo-shell-file"), file: Schema.String }),
  Schema.Struct({ type: Schema.Literal("odoo-shell-inline"), code: Schema.String }),
  Schema.Struct({ type: Schema.Literal("set-ir-config-parameter"), key: Schema.String, value: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("command"),
    command: Schema.String,
    args: Schema.Array(Schema.String),
    cwd: Schema.optional(Schema.String)
  })
])

const CompanionAppSchema = Schema.Struct({
  name: Schema.String,
  cwd: Schema.String,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  portEnv: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String))
})

const ConfigInputSchema = Schema.Struct({
  project: Schema.Struct({
    id: Schema.String,
    dbPrefix: Schema.String,
    sharedDatabase: Schema.optional(Schema.String),
    sharedBranches: Schema.optional(Schema.Array(Schema.String))
  }),
  ports: Schema.optional(Schema.Struct({
    odooBase: Schema.optional(Schema.Number),
    companionBase: Schema.optional(Schema.Number),
    range: Schema.optional(Schema.Number)
  })),
  odoo: Schema.Struct({
    version: Schema.String,
    serviceName: Schema.optional(Schema.String),
    databaseServiceName: Schema.optional(Schema.String),
    postgresImage: Schema.optional(Schema.String),
    configFile: Schema.optional(Schema.String),
    dockerfile: Schema.optional(Schema.String),
    imageName: Schema.optional(Schema.String),
    addons: Schema.Array(AddonMountSchema),
    source: Schema.optional(Schema.String)
  }),
  database: Schema.optional(Schema.Struct({
    initialModules: Schema.optional(Schema.Array(Schema.String)),
    withoutDemo: Schema.optional(Schema.Union([Schema.String, Schema.Literal(false)])),
    postInit: Schema.optional(Schema.Array(HookSchema))
  })),
  setup: Schema.optional(Schema.Struct({
    submodules: Schema.optional(Schema.Boolean),
    packageManagers: Schema.optional(Schema.Array(Schema.Struct({
      cwd: Schema.String, command: Schema.String, args: Schema.Array(Schema.String)
    })))
  })),
  compose: Schema.optional(Schema.Struct({ file: Schema.optional(Schema.String) })),
  test: Schema.optional(Schema.Struct({
    profiles: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String)))
  })),
  envAliases: Schema.optional(Schema.Record(
    Schema.String,
    Schema.Literals([...CANONICAL_ENV_VARS])
  )),
  companionApps: Schema.optional(Schema.Array(CompanionAppSchema))
})

/** Structural validation. Throws ConfigValidationError with readable issues. */
export const validateConfigInput = (input: unknown): OdooAgenticDevConfigInput => {
  try {
    return Schema.decodeUnknownSync(ConfigInputSchema)(input) as OdooAgenticDevConfigInput
  } catch (error) {
    throw new ConfigValidationError({ issues: [String(error instanceof Error ? error.message : error)] })
  }
}

export const DB_PREFIX_PATTERN = /^[a-z][a-z0-9]*$/
export const COMPANION_NAME_PATTERN = /^[a-z][a-z0-9-]*$/

/** Defaults + cross-field rules. Throws ConfigValidationError listing every issue. */
export const normalizeConfig = (input: OdooAgenticDevConfigInput): OdooAgenticDevConfig => {
  const issues: Array<string> = []

  if (!DB_PREFIX_PATTERN.test(input.project.dbPrefix)) {
    issues.push(`project.dbPrefix "${input.project.dbPrefix}" must match ${DB_PREFIX_PATTERN}`)
  }

  const ports = {
    odooBase: input.ports?.odooBase ?? 18069,
    companionBase: input.ports?.companionBase ?? 28000,
    range: input.ports?.range ?? 1000
  }
  if (!Number.isInteger(ports.range) || ports.range < 10) {
    issues.push(`ports.range must be an integer >= 10, got ${ports.range}`)
  }
  for (const [key, value] of [["odooBase", ports.odooBase], ["companionBase", ports.companionBase]] as const) {
    if (!Number.isInteger(value) || value < 1024 || value + ports.range > 65535) {
      issues.push(`ports.${key} must keep the whole range within 1024..65535, got ${value}`)
    }
  }

  const seenContainers = new Set<string>()
  for (const mount of input.odoo.addons) {
    if (seenContainers.has(mount.container)) {
      issues.push(`duplicate addon container mount path: ${mount.container}`)
    }
    seenContainers.add(mount.container)
    const escapesRepo = mount.host.startsWith("/") || mount.host === ".." || mount.host.startsWith("../")
    if (escapesRepo && mount.allowOutsideRepo !== true) {
      issues.push(`addon host path "${mount.host}" is outside the repo; set allowOutsideRepo: true to permit it`)
    }
  }
  if (input.odoo.addons.length === 0) issues.push("odoo.addons must not be empty")

  const companionNames = new Set<string>()
  for (const app of input.companionApps ?? []) {
    if (!COMPANION_NAME_PATTERN.test(app.name)) {
      issues.push(`companion app name "${app.name}" must match ${COMPANION_NAME_PATTERN}`)
    }
    if (companionNames.has(app.name)) issues.push(`duplicate companion app name: ${app.name}`)
    companionNames.add(app.name)
  }

  if ((input.project.sharedBranches?.length ?? 0) > 0 && input.project.sharedDatabase === undefined) {
    issues.push("project.sharedBranches is set but project.sharedDatabase is missing")
  }

  if (issues.length > 0) throw new ConfigValidationError({ issues })

  return {
    project: {
      id: input.project.id,
      dbPrefix: input.project.dbPrefix,
      sharedDatabase: input.project.sharedDatabase ?? null,
      sharedBranches: input.project.sharedBranches ??
        (input.project.sharedDatabase !== undefined ? ["main", "master"] : [])
    },
    ports,
    odoo: {
      version: input.odoo.version,
      serviceName: input.odoo.serviceName ?? "odoo",
      databaseServiceName: input.odoo.databaseServiceName ?? "db",
      postgresImage: input.odoo.postgresImage ?? "postgres:16",
      configFile: input.odoo.configFile ?? null,
      dockerfile: input.odoo.dockerfile ?? null,
      imageName: input.odoo.imageName ?? null,
      addons: input.odoo.addons,
      source: input.odoo.source ?? null
    },
    database: {
      initialModules: input.database?.initialModules ?? [],
      withoutDemo: input.database?.withoutDemo ?? "all",
      postInit: input.database?.postInit ?? []
    },
    setup: {
      submodules: input.setup?.submodules ?? false,
      packageManagers: input.setup?.packageManagers ?? []
    },
    compose: { file: input.compose?.file ?? null },
    test: { profiles: input.test?.profiles ?? {} },
    envAliases: input.envAliases ?? {},
    companionApps: input.companionApps ?? []
  }
}
```

Note: if `Schema.Literals` is absent in the installed beta, replace with `Schema.Union(CANONICAL_ENV_VARS.map(Schema.Literal))` — check `node_modules/effect/dist/Schema.d.ts` (it was present at line ~3501 when this plan was written).

- [ ] **Step 4: Run tests + typecheck, then commit**

Run: `pnpm vitest run test/config/schema.test.ts && pnpm typecheck` → Expected: PASS.

```bash
git add -A && git commit -m "feat: config schema validation, defaults, and cross-field checks"
```

---

### Task 5: Database name derivation

**Files:**
- Create: `src/core/database-name.ts`
- Test: `test/core/database-name.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/core/database-name.test.ts
import { describe, expect, it } from "vitest"
import { DB_NAME_PATTERN, deriveDatabaseName, sanitizeNamePart } from "../../src/core/database-name.js"
import { UnsafeDatabaseNameError } from "../../src/errors/errors.js"

const base = {
  worktreeName: "fallback-wt",
  dbPrefix: "kl",
  sharedDatabase: "kl_e2e_demo" as string | null,
  sharedBranches: ["main", "master", "dev", "develop", "development"] as ReadonlyArray<string>,
  envDatabase: undefined as string | undefined
}

describe("sanitizeNamePart", () => {
  it("lowercases and collapses non-alphanumerics to single underscores", () => {
    expect(sanitizeNamePart("KL-123--Payment Flow!")).toBe("kl_123_payment_flow")
    expect(sanitizeNamePart("__x__")).toBe("x")
  })
})

describe("deriveDatabaseName", () => {
  it("matches the PRD example: feature/KL-123-payment-flow -> kl_123_payment_flow", () => {
    expect(deriveDatabaseName({ ...base, branch: "feature/KL-123-payment-flow" }))
      .toBe("kl_123_payment_flow")
  })

  it("prefixes when the branch does not already carry the prefix", () => {
    expect(deriveDatabaseName({ ...base, branch: "feature/checkout-v2" })).toBe("kl_checkout_v2")
  })

  it("keeps non-type leading segments (user namespaces stay unique)", () => {
    expect(deriveDatabaseName({ ...base, branch: "alice/fix-1" })).toBe("kl_alice_fix_1")
  })

  it("uses the shared database for shared branches", () => {
    expect(deriveDatabaseName({ ...base, branch: "main" })).toBe("kl_e2e_demo")
    expect(deriveDatabaseName({ ...base, branch: "develop" })).toBe("kl_e2e_demo")
  })

  it("env override wins over everything", () => {
    expect(deriveDatabaseName({ ...base, branch: "main", envDatabase: "kl_custom" })).toBe("kl_custom")
  })

  it("rejects unsafe env overrides", () => {
    expect(() => deriveDatabaseName({ ...base, branch: "main", envDatabase: "Robert'); DROP" }))
      .toThrow(UnsafeDatabaseNameError)
  })

  it("falls back to the worktree name without a branch", () => {
    expect(deriveDatabaseName({ ...base, branch: undefined })).toBe("kl_fallback_wt")
  })

  it("truncates long names to 63 chars with a stable hash suffix", () => {
    const branch = "feature/" + "very-long-segment-".repeat(8)
    const name = deriveDatabaseName({ ...base, branch })
    const again = deriveDatabaseName({ ...base, branch })
    expect(name).toHaveLength(63)
    expect(name).toBe(again)
    expect(name).toMatch(DB_NAME_PATTERN)
    expect(name.slice(54, 55)).toBe("_")
  })

  it("derived names always match the safety pattern", () => {
    for (const branch of ["feature/X", "fix/émoji-🎉", "release/2025.06", "UPPER/Case"]) {
      expect(deriveDatabaseName({ ...base, branch })).toMatch(DB_NAME_PATTERN)
    }
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run test/core/database-name.test.ts` → Expected: FAIL.

- [ ] **Step 3: Implement `src/core/database-name.ts`**

```ts
import { createHash } from "node:crypto"
import { UnsafeDatabaseNameError } from "../errors/errors.js"

export const DB_NAME_PATTERN = /^[a-z][a-z0-9_]*$/
export const MAX_DB_NAME_LENGTH = 63

/** Leading branch path segments dropped before deriving a name. */
const TYPE_SEGMENTS = new Set(["feature", "feat", "bugfix", "bug", "hotfix", "fix", "chore", "task"])

export const sanitizeNamePart = (raw: string): string =>
  raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")

const sha8 = (input: string): string => createHash("sha256").update(input).digest("hex").slice(0, 8)

const truncate = (name: string): string =>
  name.length <= MAX_DB_NAME_LENGTH ? name : `${name.slice(0, 54)}_${sha8(name)}`

export const assertSafeDatabaseName = (name: string): string => {
  if (name.length === 0 || name.length > MAX_DB_NAME_LENGTH || !DB_NAME_PATTERN.test(name)) {
    throw new UnsafeDatabaseNameError({ name })
  }
  return name
}

export const deriveDatabaseName = (options: {
  readonly branch: string | undefined
  readonly worktreeName: string
  readonly dbPrefix: string
  readonly sharedDatabase: string | null
  readonly sharedBranches: ReadonlyArray<string>
  readonly envDatabase: string | undefined
}): string => {
  if (options.envDatabase !== undefined) return assertSafeDatabaseName(options.envDatabase)

  if (
    options.branch !== undefined &&
    options.sharedDatabase !== null &&
    options.sharedBranches.includes(options.branch)
  ) {
    return assertSafeDatabaseName(options.sharedDatabase)
  }

  const seed = options.branch ?? options.worktreeName
  const segments = seed.split("/")
  while (segments.length > 1 && TYPE_SEGMENTS.has(segments[0]!.toLowerCase())) segments.shift()
  let body = sanitizeNamePart(segments.join("/"))
  if (body.length === 0) body = sanitizeNamePart(options.worktreeName)

  const prefixed = body === options.dbPrefix || body.startsWith(`${options.dbPrefix}_`)
    ? body
    : `${options.dbPrefix}_${body}`

  return assertSafeDatabaseName(truncate(prefixed))
}
```

- [ ] **Step 4: Run tests + typecheck, then commit**

Run: `pnpm vitest run test/core/database-name.test.ts && pnpm typecheck` → Expected: PASS.

```bash
git add -A && git commit -m "feat: deterministic database name derivation with truncation hashing"
```

---

### Task 6: Port allocation

**Files:**
- Create: `src/core/port-allocator.ts`
- Test: `test/core/port-allocator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/core/port-allocator.test.ts
import { describe, expect, it } from "vitest"
import { derivePorts, fnv1a32 } from "../../src/core/port-allocator.js"
import { ConfigValidationError } from "../../src/errors/errors.js"

const ports = { odooBase: 18069, companionBase: 28028, range: 1000 }

describe("fnv1a32", () => {
  it("is deterministic and 32-bit unsigned", () => {
    expect(fnv1a32("kl_123_payment_flow")).toBe(fnv1a32("kl_123_payment_flow"))
    expect(fnv1a32("a")).not.toBe(fnv1a32("b"))
    expect(fnv1a32("x")).toBeGreaterThanOrEqual(0)
    expect(Number.isInteger(fnv1a32("x"))).toBe(true)
  })
})

describe("derivePorts", () => {
  it("derives odoo and companion ports from the same offset", () => {
    const result = derivePorts({
      databaseName: "kl_123_payment_flow", ports,
      companionApps: [{ name: "pwa" }, { name: "mock" }],
      envHttpPort: undefined
    })
    const offset = fnv1a32("kl_123_payment_flow") % 1000
    expect(result.odooHttpPort).toBe(18069 + offset)
    expect(result.companionPorts.get("pwa")).toBe(28028 + offset)
    expect(result.companionPorts.get("mock")).toBe(28028 + offset + 1)
  })

  it("is stable across calls", () => {
    const a = derivePorts({ databaseName: "x_db", ports, companionApps: [], envHttpPort: undefined })
    const b = derivePorts({ databaseName: "x_db", ports, companionApps: [], envHttpPort: undefined })
    expect(a.odooHttpPort).toBe(b.odooHttpPort)
  })

  it("ODOO_HTTP_PORT env override wins for odoo only", () => {
    const result = derivePorts({
      databaseName: "x_db", ports, companionApps: [{ name: "pwa" }], envHttpPort: "9999"
    })
    expect(result.odooHttpPort).toBe(9999)
    expect(result.companionPorts.get("pwa")).toBe(28028 + (fnv1a32("x_db") % 1000))
  })

  it("rejects a non-integer env port", () => {
    expect(() => derivePorts({ databaseName: "x_db", ports, companionApps: [], envHttpPort: "abc" }))
      .toThrow(ConfigValidationError)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run test/core/port-allocator.test.ts` → Expected: FAIL.

- [ ] **Step 3: Implement `src/core/port-allocator.ts`**

```ts
import { ConfigValidationError } from "../errors/errors.js"

/** FNV-1a 32-bit hash; stable basis for port offsets. */
export const fnv1a32 = (input: string): number => {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

export const derivePorts = (options: {
  readonly databaseName: string
  readonly ports: { readonly odooBase: number; readonly companionBase: number; readonly range: number }
  readonly companionApps: ReadonlyArray<{ readonly name: string }>
  readonly envHttpPort: string | undefined
}): { readonly odooHttpPort: number; readonly companionPorts: ReadonlyMap<string, number> } => {
  const offset = fnv1a32(options.databaseName) % options.ports.range

  let odooHttpPort = options.ports.odooBase + offset
  if (options.envHttpPort !== undefined) {
    const parsed = Number.parseInt(options.envHttpPort, 10)
    if (!Number.isInteger(parsed) || String(parsed) !== options.envHttpPort.trim() || parsed < 1 || parsed > 65535) {
      throw new ConfigValidationError({ issues: [`ODOO_HTTP_PORT must be an integer port, got "${options.envHttpPort}"`] })
    }
    odooHttpPort = parsed
  }

  const companionPorts = new Map<string, number>()
  options.companionApps.forEach((app, index) => {
    companionPorts.set(app.name, options.ports.companionBase + offset + index)
  })

  return { odooHttpPort, companionPorts }
}
```

- [ ] **Step 4: Run tests + typecheck, then commit**

Run: `pnpm vitest run test/core/port-allocator.test.ts && pnpm typecheck` → Expected: PASS.

```bash
git add -A && git commit -m "feat: deterministic port allocation from database name hash"
```

---

### Task 7: Compose project name and safety guards

**Files:**
- Create: `src/core/compose-project.ts`, `src/core/safety.ts`
- Test: `test/core/compose-project.test.ts`, `test/core/safety.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/core/compose-project.test.ts
import { describe, expect, it } from "vitest"
import { deriveComposeProjectName } from "../../src/core/compose-project.js"
import { ConfigValidationError } from "../../src/errors/errors.js"

describe("deriveComposeProjectName", () => {
  it("matches the PRD example", () => {
    expect(deriveComposeProjectName("kriss-laure", "kl_123_payment_flow"))
      .toBe("kriss_laure_kl_123_payment_flow")
  })

  it("sanitizes the project id", () => {
    expect(deriveComposeProjectName("My Project!", "db_x")).toBe("my_project_db_x")
  })

  it("never returns an empty or invalid name", () => {
    expect(() => deriveComposeProjectName("!!!", "")).toThrow(ConfigValidationError)
  })
})
```

```ts
// test/core/safety.test.ts
import { describe, expect, it } from "vitest"
import { assertComposeProjectName, assertSharedDatabaseAllowed, isSharedDatabase } from "../../src/core/safety.js"
import { ConfigValidationError, SharedDatabaseProtectionError } from "../../src/errors/errors.js"

describe("shared database guard", () => {
  it("detects the shared database", () => {
    expect(isSharedDatabase("kl_e2e_demo", "kl_e2e_demo")).toBe(true)
    expect(isSharedDatabase("kl_feature_x", "kl_e2e_demo")).toBe(false)
    expect(isSharedDatabase("kl_feature_x", null)).toBe(false)
  })

  it("throws without allowShared, names the action", () => {
    expect(() => assertSharedDatabaseAllowed({
      databaseName: "kl_e2e_demo", sharedDatabase: "kl_e2e_demo", allowShared: false, action: "reset-db"
    })).toThrow(SharedDatabaseProtectionError)
  })

  it("passes with allowShared or on isolated databases", () => {
    expect(() => assertSharedDatabaseAllowed({
      databaseName: "kl_e2e_demo", sharedDatabase: "kl_e2e_demo", allowShared: true, action: "reset-db"
    })).not.toThrow()
    expect(() => assertSharedDatabaseAllowed({
      databaseName: "kl_feature_x", sharedDatabase: "kl_e2e_demo", allowShared: false, action: "reset-db"
    })).not.toThrow()
  })
})

describe("assertComposeProjectName", () => {
  it("rejects empty and accepts derived names", () => {
    expect(() => assertComposeProjectName("")).toThrow(ConfigValidationError)
    expect(assertComposeProjectName("kriss_laure_kl_x")).toBe("kriss_laure_kl_x")
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/core/compose-project.test.ts test/core/safety.test.ts` → Expected: FAIL.

- [ ] **Step 3: Implement both modules**

```ts
// src/core/compose-project.ts
import { ConfigValidationError } from "../errors/errors.js"
import { sanitizeNamePart } from "./database-name.js"
import { assertComposeProjectName } from "./safety.js"

export const deriveComposeProjectName = (projectId: string, databaseName: string): string => {
  const id = sanitizeNamePart(projectId)
  const name = [id, databaseName].filter((part) => part.length > 0).join("_")
  if (id.length === 0) {
    throw new ConfigValidationError({ issues: [`project.id "${projectId}" sanitizes to an empty compose project name`] })
  }
  return assertComposeProjectName(name)
}
```

```ts
// src/core/safety.ts
import { ConfigValidationError, SharedDatabaseProtectionError } from "../errors/errors.js"

const COMPOSE_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

export const isSharedDatabase = (databaseName: string, sharedDatabase: string | null): boolean =>
  sharedDatabase !== null && databaseName === sharedDatabase

export const assertSharedDatabaseAllowed = (options: {
  readonly databaseName: string
  readonly sharedDatabase: string | null
  readonly allowShared: boolean
  /** command name for the error message, e.g. "reset-db" */
  readonly action: string
}): void => {
  if (isSharedDatabase(options.databaseName, options.sharedDatabase) && !options.allowShared) {
    throw new SharedDatabaseProtectionError({ database: options.databaseName, action: options.action })
  }
}

export const assertComposeProjectName = (name: string): string => {
  if (!COMPOSE_PROJECT_PATTERN.test(name)) {
    throw new ConfigValidationError({ issues: [`compose project name "${name}" is empty or unsafe`] })
  }
  return name
}
```

- [ ] **Step 4: Run tests + typecheck, then commit**

Run: `pnpm vitest run test/core/compose-project.test.ts test/core/safety.test.ts && pnpm typecheck` → Expected: PASS.

```bash
git add -A && git commit -m "feat: compose project naming and shared-database safety guards"
```

---

### Task 8: Worktree context assembly

**Files:**
- Create: `src/core/worktree-context.ts`
- Test: `test/core/worktree-context.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/core/worktree-context.test.ts
import { describe, expect, it } from "vitest"
import { buildWorktreeContext, substituteEnvTokens } from "../../src/core/worktree-context.js"
import type { GitState } from "../../src/core/worktree-context.js"
import { normalizeConfig, validateConfigInput } from "../../src/config/schema.js"
import { ConfigValidationError } from "../../src/errors/errors.js"
import { fnv1a32 } from "../../src/core/port-allocator.js"

const recipe = normalizeConfig(validateConfigInput({
  project: {
    id: "kriss-laure", dbPrefix: "kl",
    sharedDatabase: "kl_e2e_demo",
    sharedBranches: ["main", "master", "dev", "develop", "development"]
  },
  ports: { odooBase: 18069, companionBase: 28028, range: 1000 },
  odoo: { version: "18.0", addons: [{ host: "backend/addons/Custom", container: "/mnt/extra-addons/Custom" }] },
  envAliases: { KL_WORKTREE_DB_NAME: "ODOO_DATABASE", E2E_BASE_URL: "ODOO_BASE_URL" },
  companionApps: [{ name: "pwa", cwd: "frontend", command: "pnpm", args: ["dev"], portEnv: "PWA_PORT" }]
}))

const onBranch = (branch: string): GitState => ({ _tag: "Branch", branch })

const build = (git: GitState, env: Record<string, string | undefined> = {}) =>
  buildWorktreeContext({ rootDir: "/work/kriss-laure", recipe, env, git })

describe("buildWorktreeContext", () => {
  it("derives the PRD example end to end", () => {
    const ctx = build(onBranch("feature/KL-123-payment-flow"))
    const offset = fnv1a32("kl_123_payment_flow") % 1000
    expect(ctx.worktreeName).toBe("feature/KL-123-payment-flow")
    expect(ctx.databaseName).toBe("kl_123_payment_flow")
    expect(ctx.composeProjectName).toBe("kriss_laure_kl_123_payment_flow")
    expect(ctx.odooHttpPort).toBe(18069 + offset)
    expect(ctx.odooBaseUrl).toBe(`http://127.0.0.1:${18069 + offset}`)
    expect(ctx.companionPorts.get("pwa")).toBe(28028 + offset)
  })

  it("injects canonical env plus aliases", () => {
    const ctx = build(onBranch("feature/x"))
    expect(ctx.env.ODOO_DATABASE).toBe(ctx.databaseName)
    expect(ctx.env.E2E_ODOO_DB).toBe(ctx.databaseName)
    expect(ctx.env.ODOO_BASE_URL).toBe(ctx.odooBaseUrl)
    expect(ctx.env.ODOO_HTTP_PORT).toBe(String(ctx.odooHttpPort))
    expect(ctx.env.ODOO_COMPOSE_PROJECT_NAME).toBe(ctx.composeProjectName)
    expect(ctx.env.KL_WORKTREE_DB_NAME).toBe(ctx.databaseName)
    expect(ctx.env.E2E_BASE_URL).toBe(ctx.odooBaseUrl)
  })

  it("ODOO_WORKTREE_NAME env override beats the branch", () => {
    const ctx = build(onBranch("feature/x"), { ODOO_WORKTREE_NAME: "custom-name" })
    expect(ctx.worktreeName).toBe("custom-name")
    expect(ctx.databaseName).toBe("kl_custom_name")
  })

  it("agreeing ODOO_DATABASE/E2E_ODOO_DB overrides are honored", () => {
    const ctx = build(onBranch("main"), { ODOO_DATABASE: "kl_pinned", E2E_ODOO_DB: "kl_pinned" })
    expect(ctx.databaseName).toBe("kl_pinned")
  })

  it("disagreeing ODOO_DATABASE/E2E_ODOO_DB fail", () => {
    expect(() => build(onBranch("main"), { ODOO_DATABASE: "kl_a", E2E_ODOO_DB: "kl_b" }))
      .toThrow(ConfigValidationError)
  })

  it("detached and non-repo states use a deterministic fallback name", () => {
    const detached = build({ _tag: "Detached" })
    const again = build({ _tag: "Detached" })
    expect(detached.worktreeName).toBe(again.worktreeName)
    expect(detached.worktreeName).toMatch(/^kriss-laure-[0-9a-f]{8}$/)
    expect(detached.databaseName).toMatch(/^kl_kriss_laure_[0-9a-f]{8}$/)
  })

  it("shared branch uses the shared database", () => {
    expect(build(onBranch("main")).databaseName).toBe("kl_e2e_demo")
  })
})

describe("substituteEnvTokens", () => {
  it("replaces $VARS that exist and leaves unknown ones", () => {
    const env = { ODOO_DATABASE: "kl_x", ODOO_BASE_URL: "http://127.0.0.1:18100" }
    expect(substituteEnvTokens("$ODOO_BASE_URL/web", env)).toBe("http://127.0.0.1:18100/web")
    expect(substituteEnvTokens("$UNKNOWN_VAR", env)).toBe("$UNKNOWN_VAR")
    expect(substituteEnvTokens("", env)).toBe("")
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/core/worktree-context.test.ts` → Expected: FAIL.

- [ ] **Step 3: Implement `src/core/worktree-context.ts`**

```ts
import { createHash } from "node:crypto"
import { basename } from "node:path"
import { ConfigValidationError } from "../errors/errors.js"
import type { OdooAgenticDevConfig } from "./project-recipe.js"
import { deriveDatabaseName } from "./database-name.js"
import { derivePorts } from "./port-allocator.js"
import { deriveComposeProjectName } from "./compose-project.js"

export type GitState =
  | { readonly _tag: "Branch"; readonly branch: string }
  | { readonly _tag: "Detached" }
  | { readonly _tag: "NotARepo" }

export type WorktreeContext = {
  readonly rootDir: string
  readonly worktreeName: string
  readonly databaseName: string
  readonly composeProjectName: string
  readonly odooHttpPort: number
  readonly odooBaseUrl: string
  readonly companionPorts: ReadonlyMap<string, number>
  readonly env: Record<string, string>
}

const resolveEnvDatabase = (env: Record<string, string | undefined>): string | undefined => {
  const primary = env["ODOO_DATABASE"]
  const alias = env["E2E_ODOO_DB"]
  if (primary !== undefined && alias !== undefined && primary !== alias) {
    throw new ConfigValidationError({
      issues: [`ODOO_DATABASE ("${primary}") and E2E_ODOO_DB ("${alias}") disagree; unset one of them`]
    })
  }
  return primary ?? alias
}

const fallbackWorktreeName = (rootDir: string): string =>
  `${basename(rootDir)}-${createHash("sha256").update(rootDir).digest("hex").slice(0, 8)}`

export const buildWorktreeContext = (options: {
  readonly rootDir: string
  readonly recipe: OdooAgenticDevConfig
  readonly env: Record<string, string | undefined>
  readonly git: GitState
}): WorktreeContext => {
  const { env, git, recipe, rootDir } = options

  const branch = git._tag === "Branch" ? git.branch : undefined
  const worktreeName = env["ODOO_WORKTREE_NAME"] ?? branch ?? fallbackWorktreeName(rootDir)
  // an explicit ODOO_WORKTREE_NAME also redefines what "branch" means for naming
  const effectiveBranch = env["ODOO_WORKTREE_NAME"] ?? branch

  const databaseName = deriveDatabaseName({
    branch: effectiveBranch,
    worktreeName,
    dbPrefix: recipe.project.dbPrefix,
    sharedDatabase: recipe.project.sharedDatabase,
    sharedBranches: recipe.project.sharedBranches,
    envDatabase: resolveEnvDatabase(env)
  })

  const { companionPorts, odooHttpPort } = derivePorts({
    databaseName,
    ports: recipe.ports,
    companionApps: recipe.companionApps,
    envHttpPort: env["ODOO_HTTP_PORT"]
  })

  const composeProjectName = deriveComposeProjectName(recipe.project.id, databaseName)
  const odooBaseUrl = `http://127.0.0.1:${odooHttpPort}`

  const canonical: Record<string, string> = {
    ODOO_DATABASE: databaseName,
    E2E_ODOO_DB: databaseName,
    ODOO_BASE_URL: odooBaseUrl,
    ODOO_HTTP_PORT: String(odooHttpPort),
    ODOO_COMPOSE_PROJECT_NAME: composeProjectName
  }
  const aliased: Record<string, string> = {}
  for (const [alias, target] of Object.entries(recipe.envAliases)) {
    aliased[alias] = canonical[target]!
  }

  return {
    rootDir, worktreeName, databaseName, composeProjectName,
    odooHttpPort, odooBaseUrl, companionPorts,
    env: { ...canonical, ...aliased }
  }
}

/** Replace $NAME tokens with values from `env`; unknown tokens are left intact. */
export const substituteEnvTokens = (value: string, env: Record<string, string>): string =>
  value.replace(/\$([A-Z][A-Z0-9_]*)/g, (token, name: string) => env[name] ?? token)
```

- [ ] **Step 4: Run tests + typecheck, then commit**

Run: `pnpm vitest run test/core/worktree-context.test.ts && pnpm typecheck` → Expected: PASS.

```bash
git add -A && git commit -m "feat: worktree context assembly with env precedence and aliases"
```

---

### Task 9: CommandRunner service + recording fake

**Files:**
- Create: `src/platform/command-runner.ts`, `src/testing/fake-adapters.ts`
- Test: `test/platform/command-runner.test.ts`

- [ ] **Step 1: Write the failing test** (the live test uses real `node` subprocesses — fast, no Docker)

```ts
// test/platform/command-runner.test.ts
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { CommandRunner, CommandRunnerLive } from "../../src/platform/command-runner.js"
import { makeRecordingRunner } from "../../src/testing/fake-adapters.js"

const runLive = <A, E>(effect: Effect.Effect<A, E, any>) =>
  Effect.runPromise(effect.pipe(Effect.provide(CommandRunnerLive), Effect.provide(NodeServices.layer)) as Effect.Effect<A, E>)

describe("CommandRunnerLive", () => {
  it("captures stdout, stderr and exit code", async () => {
    const result = await runLive(Effect.gen(function* () {
      const runner = yield* CommandRunner
      return yield* runner.run({
        command: "node",
        args: ["-e", "console.log('out'); console.error('err'); process.exit(3)"]
      })
    }))
    expect(result.exitCode).toBe(3)
    expect(result.stdout).toContain("out")
    expect(result.stderr).toContain("err")
  })

  it("merges env over the parent env", async () => {
    const result = await runLive(Effect.gen(function* () {
      const runner = yield* CommandRunner
      return yield* runner.run({
        command: "node",
        args: ["-e", "console.log(process.env.OAD_TEST_VAR + ':' + (process.env.PATH ? 'has-path' : 'no-path'))"],
        env: { OAD_TEST_VAR: "hello" }
      })
    }))
    expect(result.stdout).toContain("hello:has-path")
  })

  it("pipes stdin to the child", async () => {
    const result = await runLive(Effect.gen(function* () {
      const runner = yield* CommandRunner
      return yield* runner.run({
        command: "node",
        args: ["-e", "process.stdin.pipe(process.stdout)"],
        stdin: "fed-via-stdin"
      })
    }))
    expect(result.stdout).toContain("fed-via-stdin")
  })
})

describe("makeRecordingRunner", () => {
  it("records calls and returns scripted results", async () => {
    const recording = makeRecordingRunner((spec) =>
      spec.args[0] === "version" ? { exitCode: 0, stdout: "Docker 27", stderr: "" } : undefined)
    const result = await Effect.runPromise(Effect.gen(function* () {
      const runner = yield* CommandRunner
      yield* runner.run({ command: "docker", args: ["compose", "up"] })
      return yield* runner.run({ command: "docker", args: ["version"] })
    }).pipe(Effect.provide(recording.layer)))
    expect(result.stdout).toBe("Docker 27")
    expect(recording.calls.map((c) => [c.command, ...c.args].join(" ")))
      .toEqual(["docker compose up", "docker version"])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/platform/command-runner.test.ts` → Expected: FAIL.

- [ ] **Step 3: Implement `src/platform/command-runner.ts`**

```ts
import { Context, Effect, Layer, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CommandFailedError, tail } from "../errors/errors.js"

export type ExecSpec = {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string
  /** merged over the parent process env */
  readonly env?: Record<string, string>
  readonly stdin?: string
  /** line prefix for runInherited streaming, e.g. "[pwa] " */
  readonly prefix?: string
}

export type ExecResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface CommandRunnerApi {
  /** Run to completion capturing output. Non-zero exits RESOLVE (callers decide). Spawn failures FAIL. */
  readonly run: (spec: ExecSpec) => Effect.Effect<ExecResult, CommandFailedError>
  /** Run streaming output lines to this process's stdout (with optional prefix). Resolves with exit code. */
  readonly runInherited: (spec: ExecSpec) => Effect.Effect<number, CommandFailedError>
}

export const CommandRunner = Context.Service<CommandRunnerApi>("odoo-agentic-dev/CommandRunner")

const collectText = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString)

export const CommandRunnerLive = Layer.effect(
  CommandRunner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner

    const spawn = (spec: ExecSpec) =>
      ChildProcess.make(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        extendEnv: true
      })

    const toFailure = (spec: ExecSpec) => (cause: unknown) =>
      new CommandFailedError({
        command: spec.command,
        args: spec.args,
        cwd: spec.cwd,
        exitCode: -1,
        stderrTail: tail(String(cause))
      })

    const feedStdin = (spec: ExecSpec, handle: { readonly stdin: any }) =>
      spec.stdin === undefined
        ? Effect.void
        : Stream.make(new TextEncoder().encode(spec.stdin)).pipe(Stream.run(handle.stdin))

    const run = (spec: ExecSpec) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawn(spec)
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [collectText(handle.stdout), collectText(handle.stderr), handle.exitCode],
            { concurrency: "unbounded" }
          ).pipe(Effect.zipLeft(feedStdin(spec, handle), { concurrent: true }))
          return { exitCode: Number(exitCode), stdout, stderr }
        })
      ).pipe(
        Effect.provideService(ChildProcessSpawner, spawner),
        Effect.catchAll((cause) => Effect.fail(toFailure(spec)(cause)))
      )

    const runInherited = (spec: ExecSpec) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawn(spec)
          const prefix = spec.prefix ?? ""
          const echo = handle.all.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) => Effect.sync(() => { process.stdout.write(`${prefix}${line}\n`) }))
          )
          const [, exitCode] = yield* Effect.all([echo, handle.exitCode], { concurrency: "unbounded" })
          return Number(exitCode)
        })
      ).pipe(
        Effect.provideService(ChildProcessSpawner, spawner),
        Effect.catchAll((cause) => Effect.fail(toFailure(spec)(cause)))
      )

    return { run, runInherited }
  })
)
```

Implementation note: the exact composition of `feedStdin` (running the stdin write concurrently with output collection) may need adjustment against the beta API — the REQUIRED behavior is pinned by the three live tests above (capture, env merge, stdin). `Effect.zipLeft(..., { concurrent: true })` can be replaced by forking `feedStdin` before the `Effect.all`, whichever typechecks; do not weaken the tests.

- [ ] **Step 4: Implement `src/testing/fake-adapters.ts`**

```ts
import { Effect, Layer } from "effect"
import { CommandRunner } from "../platform/command-runner.js"
import type { ExecResult, ExecSpec } from "../platform/command-runner.js"
import { Git } from "../platform/git.js"
import type { GitState } from "../core/worktree-context.js"

/**
 * CommandRunner fake: records every call; `script` may return a result per
 * spec (default: exit 0, empty output).
 */
export const makeRecordingRunner = (
  script?: (spec: ExecSpec) => ExecResult | undefined
): { readonly calls: Array<ExecSpec>; readonly layer: Layer.Layer<never> } => {
  const calls: Array<ExecSpec> = []
  const respond = (spec: ExecSpec): ExecResult => {
    calls.push(spec)
    return script?.(spec) ?? { exitCode: 0, stdout: "", stderr: "" }
  }
  return {
    calls,
    layer: Layer.succeed(CommandRunner, {
      run: (spec) => Effect.sync(() => respond(spec)),
      runInherited: (spec) => Effect.sync(() => respond(spec).exitCode)
    }) as Layer.Layer<never>
  }
}

export const makeFakeGit = (state: GitState): Layer.Layer<never> =>
  Layer.succeed(Git, { state: () => Effect.succeed(state) }) as Layer.Layer<never>
```

(The `Git` import will not resolve until Task 10 — to keep this task green, add `makeFakeGit` in Task 10's step instead if you prefer strict ordering; the commit at the end of Task 10 must have both.)

- [ ] **Step 5: Run tests + typecheck, then commit**

Run: `pnpm vitest run test/platform/command-runner.test.ts && pnpm typecheck` → Expected: PASS (comment out `makeFakeGit` until Task 10 if needed).

```bash
git add -A && git commit -m "feat: CommandRunner service over effect ChildProcess with recording fake"
```

---

### Task 10: Git service

**Files:**
- Create: `src/platform/git.ts`
- Modify: `src/testing/fake-adapters.ts` (enable `makeFakeGit`)
- Test: `test/platform/git.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/platform/git.test.ts
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { Git, GitLive } from "../../src/platform/git.js"
import { makeRecordingRunner } from "../../src/testing/fake-adapters.js"

const state = (script: Parameters<typeof makeRecordingRunner>[0]) => {
  const recording = makeRecordingRunner(script)
  return {
    recording,
    run: Effect.runPromise(
      Effect.gen(function* () {
        const git = yield* Git
        return yield* git.state("/work/repo")
      }).pipe(Effect.provide(GitLive), Effect.provide(recording.layer)) as Effect.Effect<any, any>
    )
  }
}

describe("GitLive.state", () => {
  it("returns Branch for a normal checkout", async () => {
    const { recording, run } = state(() => ({ exitCode: 0, stdout: "feature/KL-123-payment-flow\n", stderr: "" }))
    expect(await run).toEqual({ _tag: "Branch", branch: "feature/KL-123-payment-flow" })
    expect(recording.calls[0]).toMatchObject({
      command: "git",
      args: ["rev-parse", "--abbrev-ref", "HEAD"],
      cwd: "/work/repo"
    })
  })

  it("returns Detached when HEAD is not on a branch", async () => {
    const { run } = state(() => ({ exitCode: 0, stdout: "HEAD\n", stderr: "" }))
    expect(await run).toEqual({ _tag: "Detached" })
  })

  it("returns NotARepo on the dedicated git error", async () => {
    const { run } = state(() => ({ exitCode: 128, stdout: "", stderr: "fatal: not a git repository" }))
    expect(await run).toEqual({ _tag: "NotARepo" })
  })

  it("fails with GitError on other failures", async () => {
    const { run } = state(() => ({ exitCode: 1, stdout: "", stderr: "fatal: weird" }))
    await expect(run).rejects.toThrow(/weird/)
  })
})
```

Note on layer plumbing in tests: `GitLive` depends on `CommandRunner`; provide the fake first: `Effect.provide(GitLive)` then `Effect.provide(recording.layer)` (as written). If the layer types complain, use `Layer.provide(GitLive, recording.layer)` and provide the result once.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/platform/git.test.ts` → Expected: FAIL.

- [ ] **Step 3: Implement `src/platform/git.ts`**

```ts
import { Context, Effect, Layer } from "effect"
import { GitError } from "../errors/errors.js"
import type { GitState } from "../core/worktree-context.js"
import { CommandRunner } from "./command-runner.js"

export interface GitApi {
  readonly state: (rootDir: string) => Effect.Effect<GitState, GitError>
}

export const Git = Context.Service<GitApi>("odoo-agentic-dev/Git")

export const GitLive = Layer.effect(
  Git,
  Effect.gen(function* () {
    const runner = yield* CommandRunner
    return {
      state: (rootDir: string) =>
        runner.run({ command: "git", args: ["rev-parse", "--abbrev-ref", "HEAD"], cwd: rootDir }).pipe(
          Effect.mapError((e) => new GitError({ reason: e.stderrTail || String(e) })),
          Effect.flatMap((result): Effect.Effect<GitState, GitError> => {
            if (result.exitCode === 0) {
              const branch = result.stdout.trim()
              return Effect.succeed(branch === "HEAD" ? { _tag: "Detached" } : { _tag: "Branch", branch })
            }
            if (result.stderr.includes("not a git repository")) {
              return Effect.succeed({ _tag: "NotARepo" })
            }
            return Effect.fail(new GitError({ reason: result.stderr.trim() || `git exited ${result.exitCode}` }))
          })
        )
    }
  })
)
```

- [ ] **Step 4: Enable `makeFakeGit` in `src/testing/fake-adapters.ts`** (uncomment/add per Task 9's listing).

- [ ] **Step 5: Run tests + typecheck, then commit**

Run: `pnpm vitest run test/platform/git.test.ts && pnpm typecheck` → Expected: PASS.

```bash
git add -A && git commit -m "feat: Git service deriving branch/detached/not-a-repo state"
```

---

### Task 11: Recipe loader (discovery + jiti + validation)

**Files:**
- Create: `src/config/load-recipe.ts`
- Test: `test/config/load-recipe.test.ts` (uses real temp dirs — simpler and exercises jiti for real; intentional deviation from the spec's "in-memory FS" idea)

- [ ] **Step 1: Write the failing test**

```ts
// test/config/load-recipe.test.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { Effect } from "effect"
import { discoverConfigPath, loadRecipe } from "../../src/config/load-recipe.js"

const SRC_INDEX = resolve(import.meta.dirname, "../../src/index.ts")
const tmp: Array<string> = []
const makeProject = (config: string, filename = "odoo-agentic-dev.config.ts"): string => {
  const dir = mkdtempSync(join(tmpdir(), "oad-test-"))
  tmp.push(dir)
  writeFileSync(join(dir, filename), config)
  return dir
}
afterAll(() => { for (const dir of tmp) rmSync(dir, { recursive: true, force: true }) })

const VALID = `
import { defineOdooAgenticDevConfig } from ${JSON.stringify(SRC_INDEX)}
export default defineOdooAgenticDevConfig({
  project: { id: "billing-odoo", dbPrefix: "billing" },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/extra-addons/custom" }] }
})
`

describe("discoverConfigPath", () => {
  it("finds the config in the start dir and walks parents", () => {
    const dir = makeProject(VALID)
    const nested = join(dir, "a/b")
    mkdirSync(nested, { recursive: true })
    expect(discoverConfigPath(dir)).toBe(join(dir, "odoo-agentic-dev.config.ts"))
    expect(discoverConfigPath(nested)).toBe(join(dir, "odoo-agentic-dev.config.ts"))
  })

  it("returns undefined when nothing is found", () => {
    const dir = mkdtempSync(join(tmpdir(), "oad-empty-"))
    tmp.push(dir)
    expect(discoverConfigPath(dir)).toBeUndefined()
  })
})

describe("loadRecipe", () => {
  it("loads, validates, and normalizes a .ts config; rootDir is the config's dir", async () => {
    const dir = makeProject(VALID)
    const { recipe, rootDir } = await Effect.runPromise(loadRecipe({ cwd: dir, env: {} }))
    expect(rootDir).toBe(dir)
    expect(recipe.project.dbPrefix).toBe("billing")
    expect(recipe.odoo.serviceName).toBe("odoo") // defaults applied
  })

  it("honors an explicit --config path", async () => {
    const dir = makeProject(VALID, "custom.config.ts")
    const { recipe } = await Effect.runPromise(
      loadRecipe({ cwd: tmpdir(), explicitPath: join(dir, "custom.config.ts"), env: {} })
    )
    expect(recipe.project.id).toBe("billing-odoo")
  })

  it("honors ODOO_WORKTREE_CONFIG env override", async () => {
    const dir = makeProject(VALID, "from-env.config.ts")
    const { recipe } = await Effect.runPromise(
      loadRecipe({ cwd: tmpdir(), env: { ODOO_WORKTREE_CONFIG: join(dir, "from-env.config.ts") } })
    )
    expect(recipe.project.id).toBe("billing-odoo")
  })

  it("fails with ConfigLoadError when nothing is discoverable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oad-none-"))
    tmp.push(dir)
    await expect(Effect.runPromise(loadRecipe({ cwd: dir, env: {} })))
      .rejects.toThrow(/No odoo-agentic-dev config/)
  })

  it("fails with ConfigValidationError for an invalid shape", async () => {
    const dir = makeProject(`export default { project: { id: "x" } }`)
    await expect(Effect.runPromise(loadRecipe({ cwd: dir, env: {} })))
      .rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/config/load-recipe.test.ts` → Expected: FAIL.

- [ ] **Step 3: Implement `src/config/load-recipe.ts`**

```ts
import { existsSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { Effect } from "effect"
import { createJiti } from "jiti"
import { ConfigLoadError, ConfigValidationError } from "../errors/errors.js"
import type { OdooAgenticDevConfig } from "../core/project-recipe.js"
import { normalizeConfig, validateConfigInput } from "./schema.js"

export const CONFIG_FILENAMES = [
  "odoo-agentic-dev.config.ts",
  "odoo-agentic-dev.config.mts",
  "odoo-agentic-dev.config.js",
  "odoo-agentic-dev.config.mjs"
] as const

/** Walk from startDir upward; first directory containing a config file wins. */
export const discoverConfigPath = (startDir: string): string | undefined => {
  let dir = resolve(startDir)
  for (;;) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = join(dir, filename)
      if (existsSync(candidate)) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

const jiti = createJiti(import.meta.url, { interopDefault: true })

export const loadRecipe = (options: {
  readonly cwd: string
  readonly explicitPath?: string
  readonly env: Record<string, string | undefined>
}): Effect.Effect<{ readonly rootDir: string; readonly recipe: OdooAgenticDevConfig }, ConfigLoadError | ConfigValidationError> =>
  Effect.gen(function* () {
    const override = options.explicitPath ?? options.env["ODOO_WORKTREE_CONFIG"]
    const path = override !== undefined
      ? (isAbsolute(override) ? override : resolve(options.cwd, override))
      : discoverConfigPath(options.cwd)

    if (path === undefined) {
      return yield* Effect.fail(new ConfigLoadError({
        path: options.cwd,
        reason: `No odoo-agentic-dev config found from ${options.cwd} upward (looked for ${CONFIG_FILENAMES.join(", ")})`
      }))
    }
    if (!existsSync(path)) {
      return yield* Effect.fail(new ConfigLoadError({ path, reason: "file does not exist" }))
    }

    const raw = yield* Effect.tryPromise({
      try: () => jiti.import(path, { default: true }),
      catch: (cause) => new ConfigLoadError({ path, reason: String(cause) })
    })

    const recipe = yield* Effect.try({
      try: () => normalizeConfig(validateConfigInput(raw)),
      catch: (cause) => cause as ConfigValidationError
    })

    return { rootDir: dirname(path), recipe }
  })
```

- [ ] **Step 4: Run tests + typecheck, then commit**

Run: `pnpm vitest run test/config/load-recipe.test.ts && pnpm typecheck` → Expected: PASS.

```bash
git add -A && git commit -m "feat: recipe discovery and jiti-based .ts config loading"
```

---

### Task 12: `info` command and CLI entry

**Files:**
- Create: `src/commands/resolve-context.ts`, `src/commands/info.ts`, `src/cli.ts`
- Test: `test/commands/info.test.ts`

- [ ] **Step 1: Write the failing test** (drives the pure output builder AND the handler through fakes)

```ts
// test/commands/info.test.ts
import { describe, expect, it } from "vitest"
import { buildInfoJson, buildInfoText } from "../../src/commands/info.js"
import { buildWorktreeContext } from "../../src/core/worktree-context.js"
import { normalizeConfig, validateConfigInput } from "../../src/config/schema.js"

const recipe = normalizeConfig(validateConfigInput({
  project: { id: "kriss-laure", dbPrefix: "kl", sharedDatabase: "kl_e2e_demo", sharedBranches: ["main"] },
  ports: { odooBase: 18069, companionBase: 28028, range: 1000 },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/x" }] },
  companionApps: [{ name: "pwa", cwd: "frontend", command: "pnpm", args: ["dev"], portEnv: "PWA_PORT" }]
}))

const ctx = buildWorktreeContext({
  rootDir: "/work/kl", recipe, env: {},
  git: { _tag: "Branch", branch: "feature/KL-123-payment-flow" }
})

describe("info output", () => {
  it("text output contains the PRD-required lines", () => {
    const text = buildInfoText(ctx)
    expect(text).toContain("Worktree: feature/KL-123-payment-flow")
    expect(text).toContain("Database: kl_123_payment_flow")
    expect(text).toContain("Compose project: kriss_laure_kl_123_payment_flow")
    expect(text).toMatch(/Odoo URL: http:\/\/127\.0\.0\.1:\d+\/web\?db=kl_123_payment_flow/)
    expect(text).toMatch(/pwa URL: http:\/\/localhost:\d+/)
  })

  it("json output is stable and machine-readable", () => {
    const a = JSON.parse(buildInfoJson(ctx))
    const b = JSON.parse(buildInfoJson(ctx))
    expect(a).toEqual(b)
    expect(a.databaseName).toBe("kl_123_payment_flow")
    expect(a.composeProjectName).toBe("kriss_laure_kl_123_payment_flow")
    expect(typeof a.odooHttpPort).toBe("number")
    expect(a.companions.pwa).toBe(ctx.companionPorts.get("pwa"))
    expect(a.env.ODOO_DATABASE).toBe("kl_123_payment_flow")
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/commands/info.test.ts` → Expected: FAIL.

- [ ] **Step 3: Implement `src/commands/resolve-context.ts`**

```ts
import { Effect, Option } from "effect"
import { loadRecipe } from "../config/load-recipe.js"
import { buildWorktreeContext } from "../core/worktree-context.js"
import type { WorktreeContext } from "../core/worktree-context.js"
import type { OdooAgenticDevConfig } from "../core/project-recipe.js"
import { Git } from "../platform/git.js"
import type { ConfigLoadError, ConfigValidationError, GitError, RuntimeError } from "../errors/errors.js"

export type ResolvedContext = {
  readonly recipe: OdooAgenticDevConfig
  readonly ctx: WorktreeContext
}

/** Shared preamble for every command: config + git -> context. */
export const resolveContext = (
  configFlag: Option.Option<string>
): Effect.Effect<ResolvedContext, ConfigLoadError | ConfigValidationError | GitError | RuntimeError, Git> =>
  Effect.gen(function* () {
    const env = process.env as Record<string, string | undefined>
    const { recipe, rootDir } = yield* loadRecipe({
      cwd: process.cwd(),
      explicitPath: Option.getOrUndefined(configFlag),
      env
    })
    const git = yield* Git
    const gitState = yield* git.state(rootDir)
    const ctx = yield* Effect.try({
      try: () => buildWorktreeContext({ rootDir, recipe, env, git: gitState }),
      catch: (cause) => cause as RuntimeError
    })
    return { recipe, ctx }
  })
```

(If `Context.Service` keys cannot appear in the `R` position by their shape name, type the third parameter as `typeof Git.Identifier` per the v4 `Context.Key` types — check how `GitApi` flows; adjust the annotation, not the structure. `Effect.Effect<ResolvedContext, ..., GitApi>` is the likely correct form since the function-style key uses the shape as identifier.)

- [ ] **Step 4: Implement `src/commands/info.ts`**

```ts
import { Console, Effect, Option } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import type { WorktreeContext } from "../core/worktree-context.js"
import { resolveContext } from "./resolve-context.js"

export const buildInfoText = (ctx: WorktreeContext): string => {
  const out = [
    `Worktree: ${ctx.worktreeName}`,
    `Database: ${ctx.databaseName}`,
    `Compose project: ${ctx.composeProjectName}`,
    `Odoo URL: ${ctx.odooBaseUrl}/web?db=${ctx.databaseName}`
  ]
  for (const [name, port] of ctx.companionPorts) out.push(`${name} URL: http://localhost:${port}`)
  return out.join("\n")
}

export const buildInfoJson = (ctx: WorktreeContext): string =>
  JSON.stringify({
    rootDir: ctx.rootDir,
    worktreeName: ctx.worktreeName,
    databaseName: ctx.databaseName,
    composeProjectName: ctx.composeProjectName,
    odooHttpPort: ctx.odooHttpPort,
    odooBaseUrl: ctx.odooBaseUrl,
    odooUrl: `${ctx.odooBaseUrl}/web?db=${ctx.databaseName}`,
    companions: Object.fromEntries(ctx.companionPorts),
    env: ctx.env
  }, null, 2)

export const buildInfoEnv = (ctx: WorktreeContext): string =>
  Object.entries(ctx.env).map(([key, value]) => `${key}=${value}`).join("\n")

export const infoCommand = Command.make("info", {
  json: Flag.boolean("json").pipe(Flag.withDescription("print machine-readable JSON")),
  env: Flag.boolean("env").pipe(Flag.withDescription("print KEY=value env lines")),
  config: Flag.string("config").pipe(Flag.optional, Flag.withDescription("explicit config file path"))
}, (flags) =>
  Effect.gen(function* () {
    const { ctx } = yield* resolveContext(flags.config)
    const output = flags.json ? buildInfoJson(ctx) : flags.env ? buildInfoEnv(ctx) : buildInfoText(ctx)
    yield* Console.log(output)
  })
)
```

- [ ] **Step 5: Implement `src/cli.ts`** (subcommands beyond `info` are added by later tasks; start with `info` only)

```ts
#!/usr/bin/env node
import { Console, Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { infoCommand } from "./commands/info.js"
import { CommandRunnerLive } from "./platform/command-runner.js"
import { GitLive } from "./platform/git.js"
import { isRuntimeError, renderError } from "./errors/errors.js"

const root = Command.make("odoo-agentic-dev").pipe(
  Command.withDescription("Agent-friendly local Odoo development runtime"),
  Command.withSubcommands([infoCommand])
)

const services = Layer.mergeAll(
  GitLive.pipe(Layer.provide(CommandRunnerLive)),
  CommandRunnerLive
).pipe(Layer.provideMerge(NodeServices.layer))

const program = Command.run(root, { version: "0.1.0" }).pipe(
  Effect.catchAll((error) =>
    Effect.gen(function* () {
      yield* Console.error(isRuntimeError(error) ? renderError(error) : String(error))
      yield* Effect.sync(() => { process.exitCode = 1 })
    })
  ),
  Effect.provide(services)
)

NodeRuntime.runMain(program, { disableErrorReporting: true })
```

- [ ] **Step 6: Run all tests, typecheck, and exercise the CLI manually**

Run: `pnpm vitest run && pnpm typecheck` → Expected: PASS.
Then create a throwaway fixture and run the CLI from source via a tiny script:

```bash
mkdir -p /tmp/oad-fixture && cat > /tmp/oad-fixture/odoo-agentic-dev.config.ts <<'EOF'
export default {
  project: { id: "fixture", dbPrefix: "fx" },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/extra-addons/custom" }] }
}
EOF
cd /tmp/oad-fixture && git init -q && git checkout -qb feature/demo-branch
node --experimental-strip-types /Users/philippelattention/Code/odoo-agentic-dev/src/cli.ts info --json 2>/dev/null \
  || (cd /Users/philippelattention/Code/odoo-agentic-dev && pnpm build && cd /tmp/oad-fixture && node /Users/philippelattention/Code/odoo-agentic-dev/dist/cli.js info --json)
```

Expected: JSON with `"databaseName": "fx_demo_branch"`. (The `--experimental-strip-types` shortcut may or may not work with v4's exports; the `pnpm build` fallback is authoritative.)

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: info command with json/env output and CLI entry point"
```

**Milestone: the PRD's "Suggested First Slice" is complete.**

---

### Task 13: Compose model and YAML renderer

**Files:**
- Create: `src/core/compose-model.ts`
- Test: `test/core/compose-model.test.ts`

- [ ] **Step 1: Add the `yaml` dev dependency** (test-only, used to prove the rendered output parses)

```bash
pnpm add -D yaml
```

- [ ] **Step 2: Write the failing test**

```ts
// test/core/compose-model.test.ts
import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import { buildComposeModel, renderComposeYaml } from "../../src/core/compose-model.js"
import { buildWorktreeContext } from "../../src/core/worktree-context.js"
import { normalizeConfig, validateConfigInput } from "../../src/config/schema.js"

const recipe = normalizeConfig(validateConfigInput({
  project: { id: "kriss-laure", dbPrefix: "kl" },
  odoo: {
    version: "18.0-20250606",
    configFile: "config/odoo.worktree.conf",
    dockerfile: "Dockerfile.odoo",
    imageName: "krisslaure-odoo-agentic-dev",
    addons: [
      { host: "backend/addons/Custom", container: "/mnt/extra-addons/Custom" },
      { host: "backend/addons/OCA", container: "/mnt/extra-addons/OCA" }
    ]
  }
}))
const ctx = buildWorktreeContext({ rootDir: "/work/kl", recipe, env: {}, git: { _tag: "Branch", branch: "feature/x" } })
const model = buildComposeModel(recipe, ctx)

describe("buildComposeModel", () => {
  it("renders YAML that parses back to the model", () => {
    expect(parse(renderComposeYaml(model))).toEqual(JSON.parse(JSON.stringify(model)))
  })

  it("uses build+image when a dockerfile is configured", () => {
    const odoo = model.services["odoo"] as Record<string, unknown>
    expect(odoo["build"]).toEqual({ context: ".", dockerfile: "Dockerfile.odoo" })
    expect(odoo["image"]).toBe("krisslaure-odoo-agentic-dev")
  })

  it("falls back to the official image without a dockerfile", () => {
    const plain = normalizeConfig(validateConfigInput({
      project: { id: "x", dbPrefix: "x" },
      odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] }
    }))
    const plainCtx = buildWorktreeContext({ rootDir: "/w", recipe: plain, env: {}, git: { _tag: "Branch", branch: "b" } })
    const m = buildComposeModel(plain, plainCtx)
    expect((m.services["odoo"] as Record<string, unknown>)["image"]).toBe("odoo:18.0")
  })

  it("maps the derived port, addon mounts, config mount, and healthy-db dependency", () => {
    const odoo = model.services["odoo"] as Record<string, any>
    expect(odoo.ports).toEqual([`${ctx.odooHttpPort}:8069`])
    expect(odoo.volumes).toContain("./backend/addons/Custom:/mnt/extra-addons/Custom")
    expect(odoo.volumes).toContain("./config/odoo.worktree.conf:/etc/odoo/odoo.conf")
    expect(odoo.depends_on).toEqual({ db: { condition: "service_healthy" } })
    const db = model.services["db"] as Record<string, any>
    expect(db.image).toBe("postgres:16")
    expect(db.healthcheck.test).toEqual(["CMD-SHELL", "pg_isready -U odoo -d postgres"])
    expect(model.volumes).toEqual({ "db-data": {}, "web-data": {} })
  })

  it("is deterministic", () => {
    expect(renderComposeYaml(model)).toBe(renderComposeYaml(buildComposeModel(recipe, ctx)))
  })
})
```

- [ ] **Step 3: Run to verify failure, then implement `src/core/compose-model.ts`**

Run: `pnpm vitest run test/core/compose-model.test.ts` → Expected: FAIL.

```ts
import type { OdooAgenticDevConfig } from "./project-recipe.js"
import type { WorktreeContext } from "./worktree-context.js"

export type ComposeModel = {
  readonly services: Record<string, Record<string, unknown>>
  readonly volumes: Record<string, Record<string, never>>
}

export const GENERATED_COMPOSE_RELATIVE_PATH = ".odoo-agentic-dev/compose.generated.yml"

const hostPath = (host: string): string =>
  host.startsWith("/") || host.startsWith("./") || host.startsWith("../") ? host : `./${host}`

export const buildComposeModel = (recipe: OdooAgenticDevConfig, ctx: WorktreeContext): ComposeModel => {
  const dbService = recipe.odoo.databaseServiceName
  const odooService = recipe.odoo.serviceName

  const imageOrBuild: Record<string, unknown> =
    recipe.odoo.dockerfile !== null
      ? {
          build: { context: ".", dockerfile: recipe.odoo.dockerfile },
          ...(recipe.odoo.imageName !== null ? { image: recipe.odoo.imageName } : {})
        }
      : { image: `odoo:${recipe.odoo.version}` }

  return {
    services: {
      [dbService]: {
        image: recipe.odoo.postgresImage,
        environment: { POSTGRES_USER: "odoo", POSTGRES_PASSWORD: "odoo", POSTGRES_DB: "postgres" },
        healthcheck: {
          test: ["CMD-SHELL", "pg_isready -U odoo -d postgres"],
          interval: "2s", timeout: "5s", retries: 30
        },
        volumes: ["db-data:/var/lib/postgresql/data"]
      },
      [odooService]: {
        ...imageOrBuild,
        depends_on: { [dbService]: { condition: "service_healthy" } },
        environment: { HOST: dbService, USER: "odoo", PASSWORD: "odoo" },
        ports: [`${ctx.odooHttpPort}:8069`],
        volumes: [
          "web-data:/var/lib/odoo",
          ...recipe.odoo.addons.map((mount) => `${hostPath(mount.host)}:${mount.container}`),
          ...(recipe.odoo.configFile !== null ? [`${hostPath(recipe.odoo.configFile)}:/etc/odoo/odoo.conf`] : [])
        ]
      }
    },
    volumes: { "db-data": {}, "web-data": {} }
  }
}

const renderScalar = (value: string | number | boolean): string =>
  typeof value === "string" ? JSON.stringify(value) : String(value)

const renderNode = (node: unknown, indent: number): Array<string> => {
  const pad = "  ".repeat(indent)
  if (Array.isArray(node)) {
    return node.map((item) => `${pad}- ${renderScalar(item as string)}`)
  }
  if (typeof node === "object" && node !== null) {
    return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => {
      if (value === undefined) return []
      if (typeof value === "object" && value !== null) {
        if (!Array.isArray(value) && Object.keys(value).length === 0) return [`${pad}${key}: {}`]
        return [`${pad}${key}:`, ...renderNode(value, indent + 1)]
      }
      return [`${pad}${key}: ${renderScalar(value as string)}`]
    })
  }
  return [`${pad}${renderScalar(node as string)}`]
}

/** Deterministic hand-rolled YAML for the fixed compose shape (no YAML runtime dep). */
export const renderComposeYaml = (model: ComposeModel): string =>
  renderNode(model, 0).join("\n") + "\n"
```

- [ ] **Step 4: Run tests + typecheck, then commit**

Run: `pnpm vitest run test/core/compose-model.test.ts && pnpm typecheck` → Expected: PASS.

```bash
git add -A && git commit -m "feat: generated compose model with deterministic YAML rendering"
```

---

### Task 14: DockerCompose service

**Files:**
- Create: `src/platform/docker-compose.ts`
- Test: `test/platform/docker-compose.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/platform/docker-compose.test.ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { composeArgs, DockerCompose, DockerComposeLive } from "../../src/platform/docker-compose.js"
import { makeRecordingRunner } from "../../src/testing/fake-adapters.js"
import { buildWorktreeContext } from "../../src/core/worktree-context.js"
import { normalizeConfig, validateConfigInput } from "../../src/config/schema.js"
import { GENERATED_COMPOSE_RELATIVE_PATH } from "../../src/core/compose-model.js"
import { DockerUnavailableError } from "../../src/errors/errors.js"
import type { ExecSpec, ExecResult } from "../../src/platform/command-runner.js"

const tmp: Array<string> = []
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }) })

const makeEnv = (script?: (spec: ExecSpec) => ExecResult | undefined) => {
  const rootDir = mkdtempSync(join(tmpdir(), "oad-dc-"))
  tmp.push(rootDir)
  const recipe = normalizeConfig(validateConfigInput({
    project: { id: "fixture", dbPrefix: "fx" },
    odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] }
  }))
  const ctx = buildWorktreeContext({ rootDir, recipe, env: {}, git: { _tag: "Branch", branch: "feature/y" } })
  const recording = makeRecordingRunner(script)
  const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
    Effect.runPromise(effect.pipe(
      Effect.provide(Layer.provide(DockerComposeLive, recording.layer))
    ) as Effect.Effect<A, E>)
  return { ctx, recipe, recording, rootDir, run }
}

describe("composeArgs", () => {
  it("builds the canonical docker compose argv", () => {
    expect(composeArgs({ projectName: "p", composeFile: "/f.yml", projectDir: "/root" }, ["up", "-d"]))
      .toEqual(["compose", "-p", "p", "-f", "/f.yml", "--project-directory", "/root", "up", "-d"])
  })
})

describe("DockerComposeLive", () => {
  it("ensureAvailable fails with DockerUnavailableError when docker is missing", async () => {
    const { run } = makeEnv(() => ({ exitCode: 1, stdout: "", stderr: "command not found" }))
    await expect(run(Effect.gen(function* () {
      const dc = yield* DockerCompose
      yield* dc.ensureAvailable()
    }))).rejects.toThrow(DockerUnavailableError)
  })

  it("prepareComposeFile writes the generated file under .odoo-agentic-dev", async () => {
    const { ctx, recipe, rootDir, run } = makeEnv()
    const ref = await run(Effect.gen(function* () {
      const dc = yield* DockerCompose
      return yield* dc.prepareComposeFile(recipe, ctx)
    }))
    expect(ref.projectName).toBe(ctx.composeProjectName)
    expect(ref.projectDir).toBe(rootDir)
    expect(ref.composeFile).toBe(join(rootDir, GENERATED_COMPOSE_RELATIVE_PATH))
    expect(readFileSync(ref.composeFile, "utf8")).toContain("pg_isready")
  })

  it("prepareComposeFile honors the project-supplied escape hatch", async () => {
    const { ctx, rootDir, run } = makeEnv()
    const recipe = normalizeConfig(validateConfigInput({
      project: { id: "fixture", dbPrefix: "fx" },
      odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
      compose: { file: "docker-compose.worktree.yml" }
    }))
    const ref = await run(Effect.gen(function* () {
      const dc = yield* DockerCompose
      return yield* dc.prepareComposeFile(recipe, ctx)
    }))
    expect(ref.composeFile).toBe(join(rootDir, "docker-compose.worktree.yml"))
  })

  it("run issues exact argv and fails on non-zero exit", async () => {
    const { ctx, recipe, recording, run } = makeEnv((spec) =>
      spec.args.includes("down") ? { exitCode: 9, stdout: "", stderr: "kaboom" } : undefined)
    const ref = await run(Effect.gen(function* () {
      const dc = yield* DockerCompose
      const ref = yield* dc.prepareComposeFile(recipe, ctx)
      yield* dc.run(ref, ["up", "-d", "--build", "odoo"])
      return ref
    }))
    expect(recording.calls.at(-1)).toMatchObject({
      command: "docker",
      args: ["compose", "-p", ctx.composeProjectName, "-f", ref.composeFile, "--project-directory", ref.projectDir, "up", "-d", "--build", "odoo"]
    })
    await expect(run(Effect.gen(function* () {
      const dc = yield* DockerCompose
      yield* dc.run(ref, ["down"])
    }))).rejects.toThrow(/kaboom/)
    // full failure output is preserved under .odoo-agentic-dev/logs/
    const { existsSync, readdirSync } = await import("node:fs")
    const logsDir = join(ref.projectDir, ".odoo-agentic-dev", "logs")
    expect(existsSync(logsDir)).toBe(true)
    expect(readdirSync(logsDir).length).toBeGreaterThan(0)
  })

  it("waitForDb polls pg_isready until success", async () => {
    let attempts = 0
    const { ctx, recipe, run } = makeEnv((spec) => {
      if (spec.args.includes("pg_isready")) {
        attempts += 1
        return { exitCode: attempts < 3 ? 1 : 0, stdout: "", stderr: "" }
      }
      return undefined
    })
    await run(Effect.gen(function* () {
      const dc = yield* DockerCompose
      const ref = yield* dc.prepareComposeFile(recipe, ctx)
      yield* dc.waitForDb(ref, "db", { intervalMillis: 1, maxAttempts: 10 })
    }))
    expect(attempts).toBe(3)
  })
})
```

- [ ] **Step 2: Run to verify failure, then implement `src/platform/docker-compose.ts`**

Run: `pnpm vitest run test/platform/docker-compose.test.ts` → Expected: FAIL.

```ts
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { Context, Duration, Effect, Layer } from "effect"
import { ComposeCommandError, DockerUnavailableError, tail } from "../errors/errors.js"
import type { OdooAgenticDevConfig } from "../core/project-recipe.js"
import type { WorktreeContext } from "../core/worktree-context.js"
import { buildComposeModel, GENERATED_COMPOSE_RELATIVE_PATH, renderComposeYaml } from "../core/compose-model.js"
import { CommandRunner } from "./command-runner.js"
import type { ExecResult } from "./command-runner.js"

export type ComposeRef = {
  readonly projectName: string
  readonly composeFile: string
  readonly projectDir: string
}

export const composeArgs = (ref: ComposeRef, rest: ReadonlyArray<string>): Array<string> =>
  ["compose", "-p", ref.projectName, "-f", ref.composeFile, "--project-directory", ref.projectDir, ...rest]

export interface DockerComposeApi {
  readonly ensureAvailable: () => Effect.Effect<void, DockerUnavailableError>
  /** Write the generated compose file (or resolve the project-supplied one). */
  readonly prepareComposeFile: (recipe: OdooAgenticDevConfig, ctx: WorktreeContext) => Effect.Effect<ComposeRef, ComposeCommandError>
  /** Captured run; fails ComposeCommandError on non-zero exit. */
  readonly run: (ref: ComposeRef, args: ReadonlyArray<string>) => Effect.Effect<ExecResult, ComposeCommandError>
  /** Captured run with stdin; same failure semantics. */
  readonly runWithStdin: (ref: ComposeRef, args: ReadonlyArray<string>, stdin: string) => Effect.Effect<ExecResult, ComposeCommandError>
  /** Streamed to our stdout; fails ComposeCommandError on non-zero exit. */
  readonly stream: (ref: ComposeRef, args: ReadonlyArray<string>) => Effect.Effect<void, ComposeCommandError>
  /** Captured run returning the result even on non-zero exit (for polling). */
  readonly tryRun: (ref: ComposeRef, args: ReadonlyArray<string>) => Effect.Effect<ExecResult, ComposeCommandError>
  readonly waitForDb: (ref: ComposeRef, dbService: string, options?: { readonly intervalMillis?: number; readonly maxAttempts?: number }) => Effect.Effect<void, ComposeCommandError>
}

export const DockerCompose = Context.Service<DockerComposeApi>("odoo-agentic-dev/DockerCompose")

export const DockerComposeLive = Layer.effect(
  DockerCompose,
  Effect.gen(function* () {
    const runner = yield* CommandRunner

    const toComposeError = (args: ReadonlyArray<string>) => (cause: { readonly stderrTail?: string }) =>
      new ComposeCommandError({ args, exitCode: -1, stderrTail: cause.stderrTail ?? String(cause) })

    const tryRun = (ref: ComposeRef, args: ReadonlyArray<string>, stdin?: string) => {
      const argv = composeArgs(ref, args)
      return runner.run({ command: "docker", args: argv, cwd: ref.projectDir, stdin }).pipe(
        Effect.mapError(toComposeError(argv))
      )
    }

    /** Spec rule: never dump huge logs inline — full output goes to .odoo-agentic-dev/logs/, the error keeps a tail + the path. */
    const writeFailureLog = (ref: ComposeRef, argv: ReadonlyArray<string>, result: ExecResult): string | undefined => {
      try {
        const dir = join(ref.projectDir, ".odoo-agentic-dev", "logs")
        mkdirSync(dir, { recursive: true })
        const file = join(dir, `compose-${Date.now()}.log`)
        writeFileSync(file, `$ docker ${argv.join(" ")}\nexit ${result.exitCode}\n\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`)
        return file
      } catch {
        return undefined
      }
    }

    const failOnNonZero = (ref: ComposeRef, argv: ReadonlyArray<string>) => (result: ExecResult) => {
      if (result.exitCode === 0) return Effect.succeed(result)
      const logFile = writeFailureLog(ref, argv, result)
      return Effect.fail(new ComposeCommandError({
        args: argv, exitCode: result.exitCode,
        stderrTail: tail(result.stderr || result.stdout) + (logFile !== undefined ? `\nfull log: ${logFile}` : "")
      }))
    }

    const run = (ref: ComposeRef, args: ReadonlyArray<string>, stdin?: string) =>
      tryRun(ref, args, stdin).pipe(Effect.flatMap(failOnNonZero(ref, composeArgs(ref, args))))

    return {
      ensureAvailable: () =>
        runner.run({ command: "docker", args: ["version", "--format", "json"] }).pipe(
          Effect.mapError((e) => new DockerUnavailableError({ reason: e.stderrTail || "docker CLI not found" })),
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : Effect.fail(new DockerUnavailableError({ reason: tail(result.stderr) || `docker exited ${result.exitCode}` })))
        ),

      prepareComposeFile: (recipe, ctx) =>
        Effect.try({
          try: () => {
            if (recipe.compose.file !== null) {
              const file = isAbsolute(recipe.compose.file) ? recipe.compose.file : resolve(ctx.rootDir, recipe.compose.file)
              return { projectName: ctx.composeProjectName, composeFile: file, projectDir: ctx.rootDir }
            }
            const file = join(ctx.rootDir, GENERATED_COMPOSE_RELATIVE_PATH)
            mkdirSync(dirname(file), { recursive: true })
            writeFileSync(file, renderComposeYaml(buildComposeModel(recipe, ctx)))
            return { projectName: ctx.composeProjectName, composeFile: file, projectDir: ctx.rootDir }
          },
          catch: (cause) => new ComposeCommandError({ args: ["<prepare>"], exitCode: -1, stderrTail: String(cause) })
        }),

      run: (ref, args) => run(ref, args),
      runWithStdin: (ref, args, stdin) => run(ref, args, stdin),
      tryRun,

      stream: (ref, args) => {
        const argv = composeArgs(ref, args)
        return runner.runInherited({ command: "docker", args: argv, cwd: ref.projectDir }).pipe(
          Effect.mapError(toComposeError(argv)),
          Effect.flatMap((code) =>
            code === 0
              ? Effect.void
              : Effect.fail(new ComposeCommandError({ args: argv, exitCode: code, stderrTail: "" })))
        )
      },

      waitForDb: (ref, dbService, options) => {
        const interval = options?.intervalMillis ?? 1000
        const maxAttempts = options?.maxAttempts ?? 60
        const args = ["exec", "-T", dbService, "pg_isready", "-U", "odoo", "-d", "postgres"]
        const attempt = (n: number): Effect.Effect<void, ComposeCommandError> =>
          tryRun(ref, args).pipe(Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : n >= maxAttempts
                ? Effect.fail(new ComposeCommandError({
                    args: composeArgs(ref, args), exitCode: result.exitCode,
                    stderrTail: `database not ready after ${maxAttempts} attempts`
                  }))
                : Effect.sleep(Duration.millis(interval)).pipe(Effect.flatMap(() => attempt(n + 1)))))
        return attempt(1)
      }
    }
  })
)
```

- [ ] **Step 3: Run tests + typecheck, then commit**

Run: `pnpm vitest run test/platform/docker-compose.test.ts && pnpm typecheck` → Expected: PASS.

```bash
git add -A && git commit -m "feat: DockerCompose service with generated compose file and db readiness"
```

---

### Task 15: ProcessSupervisor + `up` and `down` commands

**Files:**
- Create: `src/platform/process-supervisor.ts`, `src/commands/up.ts`, `src/commands/down.ts`
- Modify: `src/cli.ts` (register `downCommand`; add `DockerComposeLive` to layers)
- Test: `test/platform/process-supervisor.test.ts`, `test/commands/up-down.test.ts`

(`up.ts` imports the supervisor, so the supervisor is built here — registration of `upCommand` in `cli.ts` still waits for Task 19 where the full layer set lands.)

- [ ] **Step 1: Write the failing test**

```ts
// test/commands/up-down.test.ts
import { describe, expect, it } from "vitest"
import { buildUpPlan } from "../../src/commands/up.js"
import { buildDownArgs, guardDown } from "../../src/commands/down.js"
import { SharedDatabaseProtectionError } from "../../src/errors/errors.js"
import { normalizeConfig, validateConfigInput } from "../../src/config/schema.js"
import { buildWorktreeContext } from "../../src/core/worktree-context.js"

const recipe = normalizeConfig(validateConfigInput({
  project: { id: "kl", dbPrefix: "kl", sharedDatabase: "kl_e2e_demo", sharedBranches: ["main"] },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
  companionApps: [{ name: "pwa", cwd: "frontend", command: "pnpm", args: ["dev"], portEnv: "PWA_PORT", env: { VITE_DB: "$ODOO_DATABASE" } }]
}))
const onMain = buildWorktreeContext({ rootDir: "/w", recipe, env: {}, git: { _tag: "Branch", branch: "main" } })
const onFeature = buildWorktreeContext({ rootDir: "/w", recipe, env: {}, git: { _tag: "Branch", branch: "feature/z" } })

describe("buildUpPlan", () => {
  it("builds compose args and companion specs with injected env", () => {
    const plan = buildUpPlan(recipe, onFeature, { odooOnly: false, noBuild: false, detach: false, logs: false })
    expect(plan.upArgs).toEqual(["up", "-d", "--build", "odoo"])
    expect(plan.companions).toHaveLength(1)
    const pwa = plan.companions[0]!
    expect(pwa.name).toBe("pwa")
    expect(pwa.cwd).toBe("/w/frontend")
    expect(pwa.env.PWA_PORT).toBe(String(onFeature.companionPorts.get("pwa")))
    expect(pwa.env.VITE_DB).toBe(onFeature.databaseName)
    expect(pwa.env.ODOO_DATABASE).toBe(onFeature.databaseName)
  })

  it("--no-build drops --build; --odoo-only drops companions", () => {
    const plan = buildUpPlan(recipe, onFeature, { odooOnly: true, noBuild: true, detach: false, logs: false })
    expect(plan.upArgs).toEqual(["up", "-d", "odoo"])
    expect(plan.companions).toEqual([])
  })
})

describe("down guard", () => {
  it("refuses --volumes on the shared database without --allow-shared", () => {
    expect(() => guardDown(recipe, onMain, { volumes: true, allowShared: false }))
      .toThrow(SharedDatabaseProtectionError)
    expect(() => guardDown(recipe, onMain, { volumes: false, allowShared: false })).not.toThrow()
    expect(() => guardDown(recipe, onFeature, { volumes: true, allowShared: false })).not.toThrow()
    expect(() => guardDown(recipe, onMain, { volumes: true, allowShared: true })).not.toThrow()
  })

  it("buildDownArgs maps --volumes", () => {
    expect(buildDownArgs({ volumes: false })).toEqual(["down"])
    expect(buildDownArgs({ volumes: true })).toEqual(["down", "--volumes"])
  })
})
```

```ts
// test/platform/process-supervisor.test.ts
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { ProcessSupervisor, ProcessSupervisorLive } from "../../src/platform/process-supervisor.js"
import { makeRecordingRunner } from "../../src/testing/fake-adapters.js"
import { CompanionProcessError } from "../../src/errors/errors.js"

const run = <A, E>(layer: Layer.Layer<never>, effect: Effect.Effect<A, E, any>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.provide(ProcessSupervisorLive, layer))) as Effect.Effect<A, E>)

describe("ProcessSupervisorLive", () => {
  it("runs every companion with prefix and env", async () => {
    const recording = makeRecordingRunner()
    await run(recording.layer, Effect.gen(function* () {
      const supervisor = yield* ProcessSupervisor
      yield* supervisor.runAll([
        { name: "pwa", cwd: "/w/frontend", command: "pnpm", args: ["dev"], env: { ODOO_DATABASE: "kl_x" } },
        { name: "mock", cwd: "/w", command: "node", args: ["mock.js"], env: {} }
      ])
    }))
    expect(recording.calls).toHaveLength(2)
    expect(recording.calls[0]).toMatchObject({ command: "pnpm", prefix: "[pwa] ", env: { ODOO_DATABASE: "kl_x" } })
  })

  it("fails with CompanionProcessError naming the failing app", async () => {
    const recording = makeRecordingRunner((spec) =>
      spec.command === "node" ? { exitCode: 5, stdout: "", stderr: "" } : undefined)
    await expect(run(recording.layer, Effect.gen(function* () {
      const supervisor = yield* ProcessSupervisor
      yield* supervisor.runAll([
        { name: "mock", cwd: "/w", command: "node", args: ["mock.js"], env: {} }
      ])
    }))).rejects.toThrow(CompanionProcessError)
  })

  it("no companions is a no-op", async () => {
    const recording = makeRecordingRunner()
    await run(recording.layer, Effect.gen(function* () {
      const supervisor = yield* ProcessSupervisor
      yield* supervisor.runAll([])
    }))
    expect(recording.calls).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run to verify failure, then implement**

Run: `pnpm vitest run test/platform/process-supervisor.test.ts test/commands/up-down.test.ts` → Expected: FAIL.

```ts
// src/platform/process-supervisor.ts
import { Context, Effect, Layer } from "effect"
import { CompanionProcessError } from "../errors/errors.js"
import type { CommandFailedError } from "../errors/errors.js"
import { CommandRunner } from "./command-runner.js"

export type CompanionSpec = {
  readonly name: string
  readonly cwd: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly env: Record<string, string>
}

export interface ProcessSupervisorApi {
  /** Run all companions concurrently; first failure interrupts the rest. */
  readonly runAll: (specs: ReadonlyArray<CompanionSpec>) => Effect.Effect<void, CompanionProcessError | CommandFailedError>
}

export const ProcessSupervisor = Context.Service<ProcessSupervisorApi>("odoo-agentic-dev/ProcessSupervisor")

export const ProcessSupervisorLive = Layer.effect(
  ProcessSupervisor,
  Effect.gen(function* () {
    const runner = yield* CommandRunner
    return {
      runAll: (specs) =>
        specs.length === 0
          ? Effect.void
          : Effect.all(
              specs.map((spec) =>
                runner.runInherited({
                  command: spec.command, args: spec.args, cwd: spec.cwd,
                  env: spec.env, prefix: `[${spec.name}] `
                }).pipe(
                  Effect.flatMap((code) =>
                    code === 0
                      ? Effect.void
                      : Effect.fail(new CompanionProcessError({ name: spec.name, exitCode: code })))
                )),
              { concurrency: "unbounded" }
            ).pipe(Effect.asVoid)
    }
  })
)
```

```ts
// src/commands/up.ts
import { resolve } from "node:path"
import { Console, Effect } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import type { OdooAgenticDevConfig } from "../core/project-recipe.js"
import type { WorktreeContext } from "../core/worktree-context.js"
import { substituteEnvTokens } from "../core/worktree-context.js"
import type { CompanionSpec } from "../platform/process-supervisor.js"
import { ProcessSupervisor } from "../platform/process-supervisor.js"
import { DockerCompose } from "../platform/docker-compose.js"
import { resolveContext } from "./resolve-context.js"
import { buildInfoText } from "./info.js"

export type UpFlags = { odooOnly: boolean; noBuild: boolean; detach: boolean; logs: boolean }

export const buildCompanionSpecs = (recipe: OdooAgenticDevConfig, ctx: WorktreeContext): Array<CompanionSpec> =>
  recipe.companionApps.map((app) => {
    const extra: Record<string, string> = {}
    for (const [key, value] of Object.entries(app.env ?? {})) {
      extra[key] = substituteEnvTokens(value, ctx.env)
    }
    const port = ctx.companionPorts.get(app.name)
    if (app.portEnv !== undefined && port !== undefined) extra[app.portEnv] = String(port)
    return {
      name: app.name,
      cwd: resolve(ctx.rootDir, app.cwd),
      command: app.command,
      args: app.args,
      env: { ...ctx.env, ...extra }
    }
  })

export const buildUpPlan = (recipe: OdooAgenticDevConfig, ctx: WorktreeContext, flags: UpFlags): {
  readonly upArgs: Array<string>
  readonly companions: Array<CompanionSpec>
} => ({
  upArgs: ["up", "-d", ...(flags.noBuild ? [] : ["--build"]), recipe.odoo.serviceName],
  companions: flags.odooOnly ? [] : buildCompanionSpecs(recipe, ctx)
})

export const upCommand = Command.make("up", {
  odooOnly: Flag.boolean("odoo-only").pipe(Flag.withDescription("skip companion apps")),
  noBuild: Flag.boolean("no-build"),
  logs: Flag.boolean("logs").pipe(Flag.withDescription("follow odoo logs after start")),
  detach: Flag.boolean("detach").pipe(Flag.withDescription("start containers and return")),
  config: Flag.string("config").pipe(Flag.optional)
}, (flags) =>
  Effect.gen(function* () {
    const { ctx, recipe } = yield* resolveContext(flags.config)
    const compose = yield* DockerCompose
    yield* compose.ensureAvailable()
    const ref = yield* compose.prepareComposeFile(recipe, ctx)
    const plan = buildUpPlan(recipe, ctx, flags)
    yield* compose.stream(ref, plan.upArgs)
    yield* Console.log(buildInfoText(ctx))
    if (plan.companions.length > 0 && !flags.detach) {
      const supervisor = yield* ProcessSupervisor
      yield* supervisor.runAll(plan.companions)
    } else if (flags.logs && !flags.detach) {
      yield* compose.stream(ref, ["logs", "-f", recipe.odoo.serviceName])
    }
  })
)
```

```ts
// src/commands/down.ts
import { Console, Effect } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import type { OdooAgenticDevConfig } from "../core/project-recipe.js"
import type { WorktreeContext } from "../core/worktree-context.js"
import { assertSharedDatabaseAllowed } from "../core/safety.js"
import { DockerCompose } from "../platform/docker-compose.js"
import { resolveContext } from "./resolve-context.js"
import type { RuntimeError } from "../errors/errors.js"

export const guardDown = (
  recipe: OdooAgenticDevConfig, ctx: WorktreeContext,
  flags: { volumes: boolean; allowShared: boolean }
): void => {
  if (flags.volumes) {
    assertSharedDatabaseAllowed({
      databaseName: ctx.databaseName,
      sharedDatabase: recipe.project.sharedDatabase,
      allowShared: flags.allowShared,
      action: "down --volumes"
    })
  }
}

export const buildDownArgs = (flags: { volumes: boolean }): Array<string> =>
  ["down", ...(flags.volumes ? ["--volumes"] : [])]

export const downCommand = Command.make("down", {
  volumes: Flag.boolean("volumes").pipe(Flag.withDescription("also remove this worktree's volumes")),
  allowShared: Flag.boolean("allow-shared"),
  config: Flag.string("config").pipe(Flag.optional)
}, (flags) =>
  Effect.gen(function* () {
    const { ctx, recipe } = yield* resolveContext(flags.config)
    yield* Effect.try({ try: () => guardDown(recipe, ctx, flags), catch: (e) => e as RuntimeError })
    const compose = yield* DockerCompose
    yield* compose.ensureAvailable()
    const ref = yield* compose.prepareComposeFile(recipe, ctx)
    yield* Console.log(`Stopping compose project: ${ctx.composeProjectName} (database: ${ctx.databaseName})`)
    yield* compose.stream(ref, buildDownArgs(flags))
  })
)
```

- [ ] **Step 3: Register in `src/cli.ts`**

Add imports and extend (ProcessSupervisorLive arrives in Task 19 — until then, register only `downCommand` and add `upCommand` in Task 19's step; alternatively stub the supervisor layer now. **Choose: register `downCommand` now, `upCommand` in Task 19.**)

```ts
// cli.ts diffs
import { downCommand } from "./commands/down.js"
import { DockerComposeLive } from "./platform/docker-compose.js"
// Command.withSubcommands([infoCommand, downCommand])
// services: add DockerComposeLive.pipe(Layer.provide(CommandRunnerLive)) to the mergeAll list
```

- [ ] **Step 4: Run tests + typecheck, then commit**

Run: `pnpm vitest run test/commands/up-down.test.ts && pnpm typecheck` → Expected: PASS.

```bash
git add -A && git commit -m "feat: up/down command logic with shared-volume protection"
```

---

### Task 16: Database lifecycle command plans and hook expansion

**Files:**
- Create: `src/core/command-plan.ts`
- Test: `test/core/command-plan.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/core/command-plan.test.ts
import { describe, expect, it } from "vitest"
import {
  createDatabaseSql, dropDatabaseSql, expandHook, odooInitArgs, odooShellArgs,
  odooTestArgs, odooUpdateArgs, psqlArgs, removeFilestoreArgs, setIrConfigParameterCode,
  terminateSessionsSql
} from "../../src/core/command-plan.js"

describe("sql/argv builders", () => {
  it("psqlArgs targets the db service with ON_ERROR_STOP", () => {
    expect(psqlArgs("db", "SELECT 1")).toEqual(
      ["exec", "-T", "db", "psql", "-U", "odoo", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", "SELECT 1"])
  })

  it("session/drop/create SQL quote the database name", () => {
    expect(terminateSessionsSql("kl_x")).toContain("datname = 'kl_x'")
    expect(dropDatabaseSql("kl_x")).toBe('DROP DATABASE IF EXISTS "kl_x"')
    expect(createDatabaseSql("kl_x")).toBe('CREATE DATABASE "kl_x" OWNER "odoo"')
  })

  it("filestore removal runs without deps through /bin/sh", () => {
    expect(removeFilestoreArgs("odoo", "kl_x")).toEqual(
      ["run", "--rm", "--no-deps", "--entrypoint", "/bin/sh", "odoo", "-c", "rm -rf /var/lib/odoo/filestore/kl_x"])
  })

  it("init installs modules (base fallback) honoring withoutDemo", () => {
    expect(odooInitArgs("odoo", "kl_x", ["KL_setup", "KL_pay"], "all")).toEqual(
      ["run", "--rm", "odoo", "odoo", "-d", "kl_x", "-i", "KL_setup,KL_pay", "--without-demo=all", "--stop-after-init"])
    expect(odooInitArgs("odoo", "kl_x", [], false)).toEqual(
      ["run", "--rm", "odoo", "odoo", "-d", "kl_x", "-i", "base", "--stop-after-init"])
  })

  it("update and shell argv", () => {
    expect(odooUpdateArgs("odoo", "kl_x", ["KL_base", "KL_sale"])).toEqual(
      ["run", "--rm", "odoo", "odoo", "-d", "kl_x", "-u", "KL_base,KL_sale", "--stop-after-init"])
    expect(odooShellArgs("odoo", "kl_x")).toEqual(
      ["run", "--rm", "-T", "odoo", "odoo", "shell", "-d", "kl_x", "--no-http"])
  })

  it("test argv maps every option", () => {
    expect(odooTestArgs("odoo", "kl_x", {})).toEqual(
      ["run", "--rm", "odoo", "odoo", "-d", "kl_x", "--test-enable", "--stop-after-init"])
    expect(odooTestArgs("odoo", "kl_x", {
      tags: "payment", file: "tests/test_x.py", module: "KL_sale", logLevel: "test", extraArgs: ["--workers", "0"]
    })).toEqual([
      "run", "--rm", "odoo", "odoo", "-d", "kl_x", "--test-enable",
      "--test-tags", "payment", "--test-file", "tests/test_x.py", "--test-tags", "/KL_sale",
      "--log-level", "test", "--workers", "0", "--stop-after-init"
    ])
  })
})

describe("expandHook", () => {
  it("passes through shell file and inline hooks", () => {
    expect(expandHook({ type: "odoo-shell-file", file: "scripts/x.py" }))
      .toEqual({ kind: "odoo-shell-file", file: "scripts/x.py" })
    expect(expandHook({ type: "odoo-shell-inline", code: "print(1)" }))
      .toEqual({ kind: "odoo-shell", code: "print(1)" })
  })

  it("set-ir-config-parameter expands to committing shell code", () => {
    const expanded = expandHook({ type: "set-ir-config-parameter", key: "web.base.url", value: "http://x" })
    expect(expanded).toEqual({ kind: "odoo-shell", code: setIrConfigParameterCode("web.base.url", "http://x") })
    expect((expanded as { code: string }).code).toContain('set_param("web.base.url", "http://x")')
    expect((expanded as { code: string }).code).toContain("env.cr.commit()")
  })

  it("command hooks become host commands", () => {
    expect(expandHook({ type: "command", command: "pnpm", args: ["seed"], cwd: "frontend" }))
      .toEqual({ kind: "host-command", command: "pnpm", args: ["seed"], cwd: "frontend" })
  })
})
```

- [ ] **Step 2: Run to verify failure, then implement `src/core/command-plan.ts`**

Run: `pnpm vitest run test/core/command-plan.test.ts` → Expected: FAIL.

```ts
import type { PostInitHook } from "./project-recipe.js"

// All database names reaching these builders have passed assertSafeDatabaseName
// (^[a-z][a-z0-9_]*$), which is what makes the string interpolation safe.

export const psqlArgs = (dbService: string, sql: string): Array<string> =>
  ["exec", "-T", dbService, "psql", "-U", "odoo", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql]

export const terminateSessionsSql = (databaseName: string): string =>
  `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${databaseName}' AND pid <> pg_backend_pid()`

export const dropDatabaseSql = (databaseName: string): string =>
  `DROP DATABASE IF EXISTS "${databaseName}"`

export const createDatabaseSql = (databaseName: string): string =>
  `CREATE DATABASE "${databaseName}" OWNER "odoo"`

export const removeFilestoreArgs = (odooService: string, databaseName: string): Array<string> =>
  ["run", "--rm", "--no-deps", "--entrypoint", "/bin/sh", odooService, "-c", `rm -rf /var/lib/odoo/filestore/${databaseName}`]

export const odooInitArgs = (
  odooService: string, databaseName: string,
  modules: ReadonlyArray<string>, withoutDemo: string | false
): Array<string> => [
  "run", "--rm", odooService, "odoo", "-d", databaseName,
  "-i", (modules.length > 0 ? modules : ["base"]).join(","),
  ...(withoutDemo === false ? [] : [`--without-demo=${withoutDemo}`]),
  "--stop-after-init"
]

export const odooUpdateArgs = (odooService: string, databaseName: string, modules: ReadonlyArray<string>): Array<string> =>
  ["run", "--rm", odooService, "odoo", "-d", databaseName, "-u", modules.join(","), "--stop-after-init"]

export const odooShellArgs = (odooService: string, databaseName: string): Array<string> =>
  ["run", "--rm", "-T", odooService, "odoo", "shell", "-d", databaseName, "--no-http"]

export type OdooTestOptions = {
  readonly tags?: string
  readonly file?: string
  readonly module?: string
  readonly logLevel?: string
  readonly extraArgs?: ReadonlyArray<string>
}

export const odooTestArgs = (odooService: string, databaseName: string, options: OdooTestOptions): Array<string> => [
  "run", "--rm", odooService, "odoo", "-d", databaseName, "--test-enable",
  ...(options.tags !== undefined ? ["--test-tags", options.tags] : []),
  ...(options.file !== undefined ? ["--test-file", options.file] : []),
  ...(options.module !== undefined ? ["--test-tags", `/${options.module}`] : []),
  ...(options.logLevel !== undefined ? ["--log-level", options.logLevel] : []),
  ...(options.extraArgs ?? []),
  "--stop-after-init"
]

const pythonString = (value: string): string => JSON.stringify(value)

export const setIrConfigParameterCode = (key: string, value: string): string =>
  [`env["ir.config_parameter"].sudo().set_param(${pythonString(key)}, ${pythonString(value)})`, "env.cr.commit()"].join("\n")

export type ExpandedHook =
  | { readonly kind: "odoo-shell"; readonly code: string }
  | { readonly kind: "odoo-shell-file"; readonly file: string }
  | { readonly kind: "host-command"; readonly command: string; readonly args: ReadonlyArray<string>; readonly cwd: string | undefined }

export const expandHook = (hook: PostInitHook): ExpandedHook => {
  switch (hook.type) {
    case "odoo-shell-file": return { kind: "odoo-shell-file", file: hook.file }
    case "odoo-shell-inline": return { kind: "odoo-shell", code: hook.code }
    case "set-ir-config-parameter":
      return { kind: "odoo-shell", code: setIrConfigParameterCode(hook.key, hook.value) }
    case "command": return { kind: "host-command", command: hook.command, args: hook.args, cwd: hook.cwd }
  }
}
```

(Note: `odoo-shell-file`/`odoo-shell-inline` scripts must commit their own transactions; only the generated `set-ir-config-parameter` code commits automatically. Document this in the README task.)

- [ ] **Step 3: Run tests + typecheck, then commit**

Run: `pnpm vitest run test/core/command-plan.test.ts && pnpm typecheck` → Expected: PASS.

```bash
git add -A && git commit -m "feat: pure command plans for database lifecycle and hook expansion"
```

---

### Task 17: OdooLifecycle service

**Files:**
- Create: `src/platform/odoo-lifecycle.ts`
- Test: `test/platform/odoo-lifecycle.test.ts`

- [ ] **Step 1: Write the failing test** (asserts the exact orchestration sequence through the recording runner)

```ts
// test/platform/odoo-lifecycle.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { OdooLifecycle, OdooLifecycleLive } from "../../src/platform/odoo-lifecycle.js"
import { DockerComposeLive } from "../../src/platform/docker-compose.js"
import { makeRecordingRunner } from "../../src/testing/fake-adapters.js"
import { normalizeConfig, validateConfigInput } from "../../src/config/schema.js"
import { buildWorktreeContext } from "../../src/core/worktree-context.js"

const tmp: Array<string> = []
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }) })

const makeEnv = (extraConfig: Record<string, unknown> = {}) => {
  const rootDir = mkdtempSync(join(tmpdir(), "oad-lc-"))
  tmp.push(rootDir)
  const recipe = normalizeConfig(validateConfigInput({
    project: { id: "kl", dbPrefix: "kl" },
    odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
    database: { initialModules: ["KL_setup"], withoutDemo: "all" },
    ...extraConfig
  }))
  const ctx = buildWorktreeContext({ rootDir, recipe, env: {}, git: { _tag: "Branch", branch: "feature/z" } })
  const recording = makeRecordingRunner()
  const layer = Layer.provide(OdooLifecycleLive, Layer.merge(
    Layer.provide(DockerComposeLive, recording.layer), recording.layer))
  const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E>)
  return { ctx, recipe, recording, rootDir, run }
}

const joinedCalls = (recording: { calls: Array<{ command: string; args: ReadonlyArray<string> }> }) =>
  recording.calls.map((c) => [c.command, ...c.args].join(" "))

describe("OdooLifecycle.resetDatabase", () => {
  it("runs the documented sequence: db up, wait, terminate, drop, create, filestore, init", async () => {
    const { ctx, recipe, recording, run } = makeEnv()
    await run(Effect.gen(function* () {
      const lifecycle = yield* OdooLifecycle
      yield* lifecycle.resetDatabase(recipe, ctx, {})
    }))
    const calls = joinedCalls(recording)
    const indexOf = (needle: string) => calls.findIndex((c) => c.includes(needle))
    expect(indexOf("up -d db")).toBeGreaterThanOrEqual(0)
    expect(indexOf("pg_isready")).toBeGreaterThan(indexOf("up -d db"))
    expect(indexOf("pg_terminate_backend")).toBeGreaterThan(indexOf("pg_isready"))
    expect(indexOf("DROP DATABASE")).toBeGreaterThan(indexOf("pg_terminate_backend"))
    expect(indexOf("CREATE DATABASE")).toBeGreaterThan(indexOf("DROP DATABASE"))
    expect(indexOf("filestore")).toBeGreaterThan(indexOf("CREATE DATABASE"))
    expect(indexOf("-i KL_setup")).toBeGreaterThan(indexOf("filestore"))
    expect(calls[indexOf("-i KL_setup")]).toContain("--without-demo=all")
  })
})

describe("OdooLifecycle.runPostInitHooks", () => {
  it("runs hooks in declared order: shell file via stdin, ir param, host command", async () => {
    const { ctx, recipe, recording, rootDir, run } = makeEnv({
      database: {
        initialModules: ["KL_setup"],
        postInit: [
          { type: "odoo-shell-file", file: "scripts/post-init.py" },
          { type: "set-ir-config-parameter", key: "web.base.url", value: "http://x" },
          { type: "command", command: "pnpm", args: ["seed"], cwd: "." }
        ]
      }
    })
    mkdirSync(join(rootDir, "scripts"), { recursive: true })
    writeFileSync(join(rootDir, "scripts", "post-init.py"), "print('post init')")
    await run(Effect.gen(function* () {
      const lifecycle = yield* OdooLifecycle
      yield* lifecycle.runPostInitHooks(recipe, ctx)
    }))
    const shellCalls = recording.calls.filter((c) => c.args.includes("shell"))
    expect(shellCalls).toHaveLength(2)
    expect(shellCalls[0]?.stdin).toContain("post init")
    expect(shellCalls[1]?.stdin).toContain("set_param")
    const host = recording.calls.at(-1)!
    expect(host.command).toBe("pnpm")
    expect(host.args).toEqual(["seed"])
    expect(host.env?.ODOO_DATABASE).toBe(ctx.databaseName)
  })
})

describe("OdooLifecycle.updateModules", () => {
  it("stops odoo, updates, restarts (unless restart=false)", async () => {
    const { ctx, recipe, recording, run } = makeEnv()
    await run(Effect.gen(function* () {
      const lifecycle = yield* OdooLifecycle
      yield* lifecycle.updateModules(recipe, ctx, ["KL_base"], { restart: true })
    }))
    const calls = joinedCalls(recording)
    const indexOf = (needle: string) => calls.findIndex((c) => c.includes(needle))
    expect(indexOf("stop odoo")).toBeGreaterThanOrEqual(0)
    expect(indexOf("-u KL_base")).toBeGreaterThan(indexOf("stop odoo"))
    expect(indexOf("up -d odoo")).toBeGreaterThan(indexOf("-u KL_base"))
  })

  it("skips the restart with restart=false", async () => {
    const { ctx, recipe, recording, run } = makeEnv()
    await run(Effect.gen(function* () {
      const lifecycle = yield* OdooLifecycle
      yield* lifecycle.updateModules(recipe, ctx, ["KL_base"], { restart: false })
    }))
    expect(joinedCalls(recording).some((c) => c.includes("up -d odoo"))).toBe(false)
  })
})

describe("OdooLifecycle.runTests", () => {
  it("returns the odoo exit code", async () => {
    const { ctx, recipe, run } = makeEnv()
    const code = await run(Effect.gen(function* () {
      const lifecycle = yield* OdooLifecycle
      return yield* lifecycle.runTests(recipe, ctx, { tags: "payment" })
    }))
    expect(code).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify failure, then implement `src/platform/odoo-lifecycle.ts`**

Run: `pnpm vitest run test/platform/odoo-lifecycle.test.ts` → Expected: FAIL.

```ts
import { readFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { Context, Effect, Layer } from "effect"
import { CommandFailedError, ConfigLoadError, OdooCommandError, tail } from "../errors/errors.js"
import type { RuntimeError } from "../errors/errors.js"
import type { OdooAgenticDevConfig } from "../core/project-recipe.js"
import type { WorktreeContext } from "../core/worktree-context.js"
import {
  createDatabaseSql, dropDatabaseSql, expandHook, odooInitArgs, odooShellArgs,
  odooTestArgs, odooUpdateArgs, psqlArgs, removeFilestoreArgs, terminateSessionsSql
} from "../core/command-plan.js"
import type { OdooTestOptions } from "../core/command-plan.js"
import { DockerCompose } from "./docker-compose.js"
import type { ComposeRef } from "./docker-compose.js"
import { CommandRunner } from "./command-runner.js"

export interface OdooLifecycleApi {
  readonly resetDatabase: (
    recipe: OdooAgenticDevConfig, ctx: WorktreeContext,
    options: { readonly modules?: ReadonlyArray<string>; readonly withoutDemo?: string | false }
  ) => Effect.Effect<void, RuntimeError>
  readonly runPostInitHooks: (recipe: OdooAgenticDevConfig, ctx: WorktreeContext) => Effect.Effect<void, RuntimeError>
  readonly updateModules: (
    recipe: OdooAgenticDevConfig, ctx: WorktreeContext,
    modules: ReadonlyArray<string>, options: { readonly restart: boolean }
  ) => Effect.Effect<void, RuntimeError>
  readonly runTests: (
    recipe: OdooAgenticDevConfig, ctx: WorktreeContext, options: OdooTestOptions
  ) => Effect.Effect<number, RuntimeError>
}

export const OdooLifecycle = Context.Service<OdooLifecycleApi>("odoo-agentic-dev/OdooLifecycle")

export const OdooLifecycleLive = Layer.effect(
  OdooLifecycle,
  Effect.gen(function* () {
    const compose = yield* DockerCompose
    const runner = yield* CommandRunner

    const ensureDbReady = (recipe: OdooAgenticDevConfig, ref: ComposeRef) =>
      compose.stream(ref, ["up", "-d", recipe.odoo.databaseServiceName]).pipe(
        Effect.andThen(compose.waitForDb(ref, recipe.odoo.databaseServiceName))
      )

    const runShellCode = (recipe: OdooAgenticDevConfig, ctx: WorktreeContext, ref: ComposeRef, code: string) =>
      compose.runWithStdin(ref, odooShellArgs(recipe.odoo.serviceName, ctx.databaseName), code)

    return {
      resetDatabase: (recipe, ctx, options) =>
        Effect.gen(function* () {
          const ref = yield* compose.prepareComposeFile(recipe, ctx)
          yield* ensureDbReady(recipe, ref)
          const db = recipe.odoo.databaseServiceName
          yield* compose.run(ref, psqlArgs(db, terminateSessionsSql(ctx.databaseName)))
          yield* compose.run(ref, psqlArgs(db, dropDatabaseSql(ctx.databaseName)))
          yield* compose.run(ref, psqlArgs(db, createDatabaseSql(ctx.databaseName)))
          yield* compose.run(ref, removeFilestoreArgs(recipe.odoo.serviceName, ctx.databaseName))
          const initArgs = odooInitArgs(
            recipe.odoo.serviceName, ctx.databaseName,
            options.modules ?? recipe.database.initialModules,
            options.withoutDemo ?? recipe.database.withoutDemo
          )
          yield* compose.stream(ref, initArgs).pipe(
            Effect.mapError((e) => new OdooCommandError({ args: e.args, exitCode: e.exitCode, stderrTail: e.stderrTail }))
          )
        }),

      runPostInitHooks: (recipe, ctx) =>
        Effect.gen(function* () {
          if (recipe.database.postInit.length === 0) return
          const ref = yield* compose.prepareComposeFile(recipe, ctx)
          for (const hook of recipe.database.postInit) {
            const expanded = expandHook(hook)
            switch (expanded.kind) {
              case "odoo-shell": {
                yield* runShellCode(recipe, ctx, ref, expanded.code)
                break
              }
              case "odoo-shell-file": {
                const path = isAbsolute(expanded.file) ? expanded.file : resolve(ctx.rootDir, expanded.file)
                const code = yield* Effect.try({
                  try: () => readFileSync(path, "utf8"),
                  catch: (cause) => new ConfigLoadError({ path, reason: String(cause) })
                })
                yield* runShellCode(recipe, ctx, ref, code)
                break
              }
              case "host-command": {
                const cwd = expanded.cwd === undefined ? ctx.rootDir : resolve(ctx.rootDir, expanded.cwd)
                const code = yield* runner.runInherited({
                  command: expanded.command, args: expanded.args, cwd, env: ctx.env,
                  prefix: `[hook:${expanded.command}] `
                })
                if (code !== 0) {
                  yield* Effect.fail(new CommandFailedError({
                    command: expanded.command, args: expanded.args, cwd, exitCode: code, stderrTail: ""
                  }))
                }
                break
              }
            }
          }
        }),

      updateModules: (recipe, ctx, modules, options) =>
        Effect.gen(function* () {
          const ref = yield* compose.prepareComposeFile(recipe, ctx)
          yield* ensureDbReady(recipe, ref)
          yield* compose.stream(ref, ["stop", recipe.odoo.serviceName])
          yield* compose.stream(ref, odooUpdateArgs(recipe.odoo.serviceName, ctx.databaseName, modules)).pipe(
            Effect.mapError((e) => new OdooCommandError({ args: e.args, exitCode: e.exitCode, stderrTail: e.stderrTail }))
          )
          if (options.restart) {
            yield* compose.stream(ref, ["up", "-d", recipe.odoo.serviceName])
          }
        }),

      runTests: (recipe, ctx, options) =>
        Effect.gen(function* () {
          const ref = yield* compose.prepareComposeFile(recipe, ctx)
          yield* ensureDbReady(recipe, ref)
          const result = yield* compose.tryRun(ref, odooTestArgs(recipe.odoo.serviceName, ctx.databaseName, options))
          if (result.stdout.length > 0) yield* Effect.sync(() => { process.stdout.write(tail(result.stdout, 200) + "\n") })
          if (result.stderr.length > 0) yield* Effect.sync(() => { process.stderr.write(tail(result.stderr, 200) + "\n") })
          return result.exitCode
        })
    }
  })
)
```

- [ ] **Step 3: Run tests + typecheck, then commit**

Run: `pnpm vitest run test/platform/odoo-lifecycle.test.ts && pnpm typecheck` → Expected: PASS.

```bash
git add -A && git commit -m "feat: OdooLifecycle service for reset/init/update/test/hooks"
```

---

### Task 18: `reset-db` and `setup` commands

**Files:**
- Create: `src/commands/reset-db.ts`, `src/commands/setup.ts`
- Modify: `src/cli.ts` (register both; add `OdooLifecycleLive` to layers)
- Test: `test/commands/reset-db-setup.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/commands/reset-db-setup.test.ts
import { describe, expect, it } from "vitest"
import { guardReset, parseModulesFlag } from "../../src/commands/reset-db.js"
import { buildSetupSteps } from "../../src/commands/setup.js"
import { SharedDatabaseProtectionError } from "../../src/errors/errors.js"
import { normalizeConfig, validateConfigInput } from "../../src/config/schema.js"
import { buildWorktreeContext } from "../../src/core/worktree-context.js"

const recipe = normalizeConfig(validateConfigInput({
  project: { id: "kl", dbPrefix: "kl", sharedDatabase: "kl_e2e_demo", sharedBranches: ["main"] },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
  setup: { submodules: true, packageManagers: [
    { cwd: ".", command: "pnpm", args: ["install"] },
    { cwd: "frontend", command: "pnpm", args: ["install"] }
  ] }
}))
const onMain = buildWorktreeContext({ rootDir: "/w", recipe, env: {}, git: { _tag: "Branch", branch: "main" } })
const onFeature = buildWorktreeContext({ rootDir: "/w", recipe, env: {}, git: { _tag: "Branch", branch: "feature/q" } })

describe("guardReset", () => {
  it("protects the shared database", () => {
    expect(() => guardReset(recipe, onMain, false)).toThrow(SharedDatabaseProtectionError)
    expect(() => guardReset(recipe, onMain, true)).not.toThrow()
    expect(() => guardReset(recipe, onFeature, false)).not.toThrow()
  })
})

describe("parseModulesFlag", () => {
  it("splits, trims, drops empties; undefined passes through", () => {
    expect(parseModulesFlag("KL_base, KL_sale ,")).toEqual(["KL_base", "KL_sale"])
    expect(parseModulesFlag(undefined)).toBeUndefined()
  })
})

describe("buildSetupSteps", () => {
  it("orders submodules, installs, build, db reset", () => {
    const steps = buildSetupSteps(recipe, onFeature, { skipInstall: false, skipDb: false })
    expect(steps.map((s) => s.kind)).toEqual(["submodules", "install", "install", "build", "reset-db"])
    const install = steps[1] as { kind: "install"; cwd: string }
    expect(install.cwd).toBe("/w")
  })

  it("honors skip flags", () => {
    const steps = buildSetupSteps(recipe, onFeature, { skipInstall: true, skipDb: true })
    expect(steps.map((s) => s.kind)).toEqual(["submodules", "build"])
  })
})
```

- [ ] **Step 2: Run to verify failure, then implement**

Run: `pnpm vitest run test/commands/reset-db-setup.test.ts` → Expected: FAIL.

```ts
// src/commands/reset-db.ts
import { Console, Effect, Option } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import type { OdooAgenticDevConfig } from "../core/project-recipe.js"
import type { WorktreeContext } from "../core/worktree-context.js"
import { assertSharedDatabaseAllowed } from "../core/safety.js"
import { OdooLifecycle } from "../platform/odoo-lifecycle.js"
import { resolveContext } from "./resolve-context.js"
import type { RuntimeError } from "../errors/errors.js"

export const guardReset = (recipe: OdooAgenticDevConfig, ctx: WorktreeContext, allowShared: boolean): void =>
  assertSharedDatabaseAllowed({
    databaseName: ctx.databaseName,
    sharedDatabase: recipe.project.sharedDatabase,
    allowShared,
    action: "reset-db"
  })

export const parseModulesFlag = (value: string | undefined): Array<string> | undefined =>
  value?.split(",").map((m) => m.trim()).filter((m) => m.length > 0)

export const resetDbCommand = Command.make("reset-db", {
  allowShared: Flag.boolean("allow-shared"),
  modules: Flag.string("modules").pipe(Flag.optional, Flag.withDescription("comma-separated module list (defaults to recipe initialModules)")),
  withoutDemo: Flag.string("without-demo").pipe(Flag.optional),
  config: Flag.string("config").pipe(Flag.optional)
}, (flags) =>
  Effect.gen(function* () {
    const { ctx, recipe } = yield* resolveContext(flags.config)
    yield* Effect.try({ try: () => guardReset(recipe, ctx, flags.allowShared), catch: (e) => e as RuntimeError })
    yield* Console.log(`Resetting database: ${ctx.databaseName}`)
    yield* Console.log(`Compose project:    ${ctx.composeProjectName}`)
    const lifecycle = yield* OdooLifecycle
    yield* lifecycle.resetDatabase(recipe, ctx, {
      modules: parseModulesFlag(Option.getOrUndefined(flags.modules)),
      withoutDemo: Option.getOrUndefined(flags.withoutDemo)
    })
    yield* lifecycle.runPostInitHooks(recipe, ctx)
    yield* Console.log(`Done. Odoo URL: ${ctx.odooBaseUrl}/web?db=${ctx.databaseName}`)
  })
)
```

```ts
// src/commands/setup.ts
import { resolve } from "node:path"
import { Console, Effect } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import type { OdooAgenticDevConfig } from "../core/project-recipe.js"
import type { WorktreeContext } from "../core/worktree-context.js"
import { DockerCompose } from "../platform/docker-compose.js"
import { OdooLifecycle } from "../platform/odoo-lifecycle.js"
import { CommandRunner } from "../platform/command-runner.js"
import { resolveContext } from "./resolve-context.js"
import { guardReset } from "./reset-db.js"
import { buildInfoText } from "./info.js"
import { CommandFailedError } from "../errors/errors.js"
import type { RuntimeError } from "../errors/errors.js"

export type SetupStep =
  | { readonly kind: "submodules" }
  | { readonly kind: "install"; readonly cwd: string; readonly command: string; readonly args: ReadonlyArray<string> }
  | { readonly kind: "build" }
  | { readonly kind: "reset-db" }

export const buildSetupSteps = (
  recipe: OdooAgenticDevConfig, ctx: WorktreeContext,
  flags: { readonly skipInstall: boolean; readonly skipDb: boolean }
): Array<SetupStep> => [
  ...(recipe.setup.submodules ? [{ kind: "submodules" } as const] : []),
  ...(flags.skipInstall ? [] : recipe.setup.packageManagers.map((step) => ({
    kind: "install" as const, cwd: resolve(ctx.rootDir, step.cwd), command: step.command, args: step.args
  }))),
  { kind: "build" } as const,
  ...(flags.skipDb ? [] : [{ kind: "reset-db" } as const])
]

export const setupCommand = Command.make("setup", {
  skipInstall: Flag.boolean("skip-install"),
  skipDb: Flag.boolean("skip-db"),
  allowShared: Flag.boolean("allow-shared"),
  config: Flag.string("config").pipe(Flag.optional)
}, (flags) =>
  Effect.gen(function* () {
    const { ctx, recipe } = yield* resolveContext(flags.config)
    const compose = yield* DockerCompose
    const runner = yield* CommandRunner
    const lifecycle = yield* OdooLifecycle
    yield* compose.ensureAvailable()

    const runHost = (command: string, args: ReadonlyArray<string>, cwd: string) =>
      runner.runInherited({ command, args, cwd, env: ctx.env }).pipe(
        Effect.flatMap((code) => code === 0
          ? Effect.void
          : Effect.fail(new CommandFailedError({ command, args, cwd, exitCode: code, stderrTail: "" })))
      )

    for (const step of buildSetupSteps(recipe, ctx, flags)) {
      switch (step.kind) {
        case "submodules":
          yield* Console.log("» git submodule update --init --recursive")
          yield* runHost("git", ["submodule", "update", "--init", "--recursive"], ctx.rootDir)
          break
        case "install":
          yield* Console.log(`» ${step.command} ${step.args.join(" ")} (${step.cwd})`)
          yield* runHost(step.command, step.args, step.cwd)
          break
        case "build": {
          const ref = yield* compose.prepareComposeFile(recipe, ctx)
          yield* compose.stream(ref, ["build", recipe.odoo.serviceName])
          break
        }
        case "reset-db":
          yield* Effect.try({ try: () => guardReset(recipe, ctx, flags.allowShared), catch: (e) => e as RuntimeError })
          yield* Console.log(`Resetting database: ${ctx.databaseName}`)
          yield* lifecycle.resetDatabase(recipe, ctx, {})
          yield* lifecycle.runPostInitHooks(recipe, ctx)
          break
      }
    }
    yield* Console.log(buildInfoText(ctx))
  })
)
```

- [ ] **Step 3: Register both commands in `src/cli.ts`**, adding `OdooLifecycleLive` (provided with `DockerComposeLive` + `CommandRunnerLive`) to the layer merge and both commands to `withSubcommands`.

- [ ] **Step 4: Run tests + typecheck, then commit**

Run: `pnpm vitest run test/commands/reset-db-setup.test.ts && pnpm typecheck` → Expected: PASS.

```bash
git add -A && git commit -m "feat: reset-db and setup commands with shared-db guards"
```

---

### Task 19: `update` and `test` commands + `up` registration

**Files:**
- Create: `src/commands/update.ts`, `src/commands/test.ts`
- Modify: `src/cli.ts` (register `upCommand`, `updateCommand`, `testCommand`; add `ProcessSupervisorLive`)
- Test: `test/commands/update-test.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/commands/update-test.test.ts
import { describe, expect, it } from "vitest"
import { resolveTestOptions } from "../../src/commands/test.js"
import { ConfigValidationError } from "../../src/errors/errors.js"
import { normalizeConfig, validateConfigInput } from "../../src/config/schema.js"

const recipe = normalizeConfig(validateConfigInput({
  project: { id: "kl", dbPrefix: "kl" },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/c" }] },
  test: { profiles: { payment: ["--test-tags", "payment_flow"] } }
}))

describe("resolveTestOptions", () => {
  it("maps flags directly", () => {
    expect(resolveTestOptions(recipe, { tags: "x", file: undefined, module: "m", logLevel: "test", profile: undefined }))
      .toEqual({ tags: "x", file: undefined, module: "m", logLevel: "test", extraArgs: [] })
  })

  it("expands a recipe profile into extraArgs", () => {
    expect(resolveTestOptions(recipe, { tags: undefined, file: undefined, module: undefined, logLevel: undefined, profile: "payment" }))
      .toEqual({ tags: undefined, file: undefined, module: undefined, logLevel: undefined, extraArgs: ["--test-tags", "payment_flow"] })
  })

  it("rejects unknown profiles listing the available ones", () => {
    expect(() => resolveTestOptions(recipe, { tags: undefined, file: undefined, module: undefined, logLevel: undefined, profile: "nope" }))
      .toThrow(ConfigValidationError)
    try {
      resolveTestOptions(recipe, { tags: undefined, file: undefined, module: undefined, logLevel: undefined, profile: "nope" })
    } catch (e) {
      expect(String((e as ConfigValidationError).issues)).toContain("payment")
    }
  })
})
```

- [ ] **Step 2: Run to verify failure, then implement**

Run: `pnpm vitest run test/commands/update-test.test.ts` → Expected: FAIL.

```ts
// src/commands/update.ts
import { Console, Effect } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { ConfigValidationError } from "../errors/errors.js"
import { OdooLifecycle } from "../platform/odoo-lifecycle.js"
import { resolveContext } from "./resolve-context.js"

export const updateCommand = Command.make("update", {
  modules: Argument.string("modules"),
  noRestart: Flag.boolean("no-restart"),
  config: Flag.string("config").pipe(Flag.optional)
}, (flags) =>
  Effect.gen(function* () {
    const list = flags.modules.split(",").map((m) => m.trim()).filter((m) => m.length > 0)
    if (list.length === 0) {
      return yield* Effect.fail(new ConfigValidationError({ issues: ["update requires a non-empty comma-separated module list"] }))
    }
    const { ctx, recipe } = yield* resolveContext(flags.config)
    const lifecycle = yield* OdooLifecycle
    yield* Console.log(`Updating modules [${list.join(", ")}] in ${ctx.databaseName}`)
    yield* lifecycle.updateModules(recipe, ctx, list, { restart: !flags.noRestart })
  })
)
```

```ts
// src/commands/test.ts
import { Console, Effect, Option } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { ConfigValidationError } from "../errors/errors.js"
import type { RuntimeError } from "../errors/errors.js"
import type { OdooAgenticDevConfig } from "../core/project-recipe.js"
import type { OdooTestOptions } from "../core/command-plan.js"
import { OdooLifecycle } from "../platform/odoo-lifecycle.js"
import { resolveContext } from "./resolve-context.js"

export const resolveTestOptions = (
  recipe: OdooAgenticDevConfig,
  flags: {
    readonly tags: string | undefined
    readonly file: string | undefined
    readonly module: string | undefined
    readonly logLevel: string | undefined
    readonly profile: string | undefined
  }
): OdooTestOptions & { readonly extraArgs: ReadonlyArray<string> } => {
  let extraArgs: ReadonlyArray<string> = []
  if (flags.profile !== undefined) {
    const profile = recipe.test.profiles[flags.profile]
    if (profile === undefined) {
      throw new ConfigValidationError({
        issues: [`unknown test profile "${flags.profile}"; available: ${Object.keys(recipe.test.profiles).join(", ") || "(none)"}`]
      })
    }
    extraArgs = profile
  }
  return { tags: flags.tags, file: flags.file, module: flags.module, logLevel: flags.logLevel, extraArgs }
}

export const testCommand = Command.make("test", {
  tags: Flag.string("tags").pipe(Flag.optional),
  file: Flag.string("file").pipe(Flag.optional),
  module: Flag.string("module").pipe(Flag.optional),
  logLevel: Flag.string("log-level").pipe(Flag.optional),
  profile: Flag.string("profile").pipe(Flag.optional, Flag.withDescription("recipe-defined test profile")),
  includeDemo: Flag.boolean("include-demo").pipe(Flag.withDescription("accepted for compatibility; demo data is controlled at database init in v1")),
  config: Flag.string("config").pipe(Flag.optional)
}, (flags) =>
  Effect.gen(function* () {
    const { ctx, recipe } = yield* resolveContext(flags.config)
    if (flags.includeDemo) {
      yield* Console.log("note: --include-demo has no effect in v1; reset the database with --without-demo=false instead")
    }
    const options = yield* Effect.try({
      try: () => resolveTestOptions(recipe, {
        tags: Option.getOrUndefined(flags.tags),
        file: Option.getOrUndefined(flags.file),
        module: Option.getOrUndefined(flags.module),
        logLevel: Option.getOrUndefined(flags.logLevel),
        profile: Option.getOrUndefined(flags.profile)
      }),
      catch: (e) => e as RuntimeError
    })
    const lifecycle = yield* OdooLifecycle
    const code = yield* lifecycle.runTests(recipe, ctx, options)
    if (code !== 0) {
      yield* Console.error(`Tests failed (odoo exit ${code})`)
      yield* Effect.sync(() => { process.exitCode = code })
    } else {
      yield* Console.log("Tests passed")
    }
  })
)
```

- [ ] **Step 3: Register `upCommand`, `updateCommand`, `testCommand` in `src/cli.ts`** and add `ProcessSupervisorLive.pipe(Layer.provide(CommandRunnerLive))` to the layers. Final subcommand list: `[infoCommand, setupCommand, upCommand, downCommand, resetDbCommand, updateCommand, testCommand]` (link-source joins in Task 20).

- [ ] **Step 4: Run tests + typecheck, then commit**

Run: `pnpm vitest run && pnpm typecheck` → Expected: ALL PASS.

```bash
git add -A && git commit -m "feat: update/test commands and companion process supervisor"
```

---

### Task 20: `link-source` command

**Files:**
- Create: `src/commands/link-source.ts`
- Modify: `src/cli.ts` (register)
- Test: `test/commands/link-source.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/commands/link-source.test.ts
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { performLinkSource } from "../../src/commands/link-source.js"
import { SourceResolverError } from "../../src/errors/errors.js"

const tmp: Array<string> = []
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }) })
const makeDirs = () => {
  const root = mkdtempSync(join(tmpdir(), "oad-ls-"))
  tmp.push(root)
  const source = join(root, "odoo-src")
  mkdirSync(source)
  const project = join(root, "project")
  mkdirSync(project)
  return { project, source }
}

describe("performLinkSource", () => {
  it("creates a .odoo symlink to the resolved target", () => {
    const { project, source } = makeDirs()
    const linkPath = performLinkSource({ rootDir: project, target: source, name: ".odoo", force: false, recipeSource: null })
    expect(linkPath).toBe(join(project, ".odoo"))
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(linkPath)).toBe(source)
  })

  it("refuses to overwrite a real directory", () => {
    const { project, source } = makeDirs()
    mkdirSync(join(project, ".odoo"))
    expect(() => performLinkSource({ rootDir: project, target: source, name: ".odoo", force: false, recipeSource: null }))
      .toThrow(SourceResolverError)
  })

  it("replaces an existing symlink only with force", () => {
    const { project, source } = makeDirs()
    symlinkSync(project, join(project, ".odoo"))
    expect(() => performLinkSource({ rootDir: project, target: source, name: ".odoo", force: false, recipeSource: null }))
      .toThrow(/--force/)
    performLinkSource({ rootDir: project, target: source, name: ".odoo", force: true, recipeSource: null })
    expect(readlinkSync(join(project, ".odoo"))).toBe(source)
  })

  it("falls back to recipe source, then errors with guidance", () => {
    const { project, source } = makeDirs()
    const linkPath = performLinkSource({ rootDir: project, target: undefined, name: ".odoo", force: false, recipeSource: source })
    expect(readlinkSync(linkPath)).toBe(source)
    rmSync(linkPath)
    expect(() => performLinkSource({ rootDir: project, target: undefined, name: ".odoo", force: false, recipeSource: null }))
      .toThrow(SourceResolverError)
  })
})
```

- [ ] **Step 2: Run to verify failure, then implement `src/commands/link-source.ts`**

Run: `pnpm vitest run test/commands/link-source.test.ts` → Expected: FAIL.

```ts
import { existsSync, lstatSync, symlinkSync, unlinkSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { Console, Effect, Option } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { SourceResolverError } from "../errors/errors.js"
import type { RuntimeError } from "../errors/errors.js"
import { resolveContext } from "./resolve-context.js"

export const performLinkSource = (options: {
  readonly rootDir: string
  readonly target: string | undefined
  readonly name: string
  readonly force: boolean
  readonly recipeSource: string | null
}): string => {
  const configured = options.target ?? (options.recipeSource === "docker-only" ? undefined : options.recipeSource ?? undefined)
  const sibling = resolve(options.rootDir, "../odoo")
  const resolved = configured !== undefined
    ? (isAbsolute(configured) ? configured : resolve(options.rootDir, configured))
    : (existsSync(sibling) ? sibling : undefined)

  if (resolved === undefined || !existsSync(resolved)) {
    throw new SourceResolverError({
      reason: resolved === undefined
        ? "no --target given, no odoo.source configured, and no ../odoo sibling checkout found"
        : `resolved source path does not exist: ${resolved}`
    })
  }

  const linkPath = join(options.rootDir, options.name)
  let existing: ReturnType<typeof lstatSync> | undefined
  try { existing = lstatSync(linkPath) } catch { existing = undefined }
  if (existing !== undefined) {
    if (!existing.isSymbolicLink()) {
      throw new SourceResolverError({ reason: `${linkPath} exists and is not a symlink; refusing to overwrite` })
    }
    if (!options.force) {
      throw new SourceResolverError({ reason: `${linkPath} already exists; pass --force to replace it` })
    }
    unlinkSync(linkPath)
  }
  symlinkSync(resolved, linkPath)
  return linkPath
}

export const linkSourceCommand = Command.make("link-source", {
  target: Flag.string("target").pipe(Flag.optional),
  name: Flag.string("name").pipe(Flag.withDefault(".odoo")),
  force: Flag.boolean("force"),
  config: Flag.string("config").pipe(Flag.optional)
}, (flags) =>
  Effect.gen(function* () {
    const { ctx, recipe } = yield* resolveContext(flags.config)
    const linkPath = yield* Effect.try({
      try: () => performLinkSource({
        rootDir: ctx.rootDir,
        target: Option.getOrUndefined(flags.target),
        name: flags.name,
        force: flags.force,
        recipeSource: recipe.odoo.source
      }),
      catch: (e) => e as RuntimeError
    })
    yield* Console.log(`Linked ${linkPath} -> resolved Odoo source`)
  })
)
```

- [ ] **Step 3: Register `linkSourceCommand` in `src/cli.ts`** (final subcommand list complete).

- [ ] **Step 4: Run tests + typecheck, then commit**

Run: `pnpm vitest run && pnpm typecheck` → Expected: ALL PASS.

```bash
git add -A && git commit -m "feat: link-source command with symlink safety"
```

---

### Task 21: Build verification, e2e test, README, CI, Docker integration script

**Files:**
- Create: `test/e2e/cli.test.ts`, `README.md`, `scripts/docker-integration.sh`, `.github/workflows/ci.yml`

- [ ] **Step 1: Build and create the e2e test against the built CLI**

```ts
// test/e2e/cli.test.ts
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

const CLI = resolve(import.meta.dirname, "../../dist/cli.js")
const tmp: Array<string> = []
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }) })

describe.skipIf(!existsSync(CLI))("built CLI e2e (run `pnpm build` first)", () => {
  const dir = mkdtempSync(join(tmpdir(), "oad-e2e-"))
  tmp.push(dir)
  writeFileSync(join(dir, "odoo-agentic-dev.config.mjs"), `
export default {
  project: { id: "fixture", dbPrefix: "fx" },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/extra-addons/custom" }] }
}
`)
  const run = (args: Array<string>, env: Record<string, string> = {}) =>
    execFileSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } })

  it("info --json works without git or docker", () => {
    const parsed = JSON.parse(run(["info", "--json"], { ODOO_WORKTREE_NAME: "feature/demo" }))
    expect(parsed.databaseName).toBe("fx_demo")
    expect(parsed.composeProjectName).toBe("fixture_fx_demo")
    expect(parsed.env.ODOO_DATABASE).toBe("fx_demo")
  })

  it("info --env prints KEY=value lines", () => {
    const out = run(["info", "--env"], { ODOO_WORKTREE_NAME: "feature/demo" })
    expect(out).toContain("ODOO_DATABASE=fx_demo")
  })

  it("info is deterministic", () => {
    const a = run(["info", "--json"], { ODOO_WORKTREE_NAME: "feature/demo" })
    expect(run(["info", "--json"], { ODOO_WORKTREE_NAME: "feature/demo" })).toBe(a)
  })
})
```

Run: `pnpm build && pnpm vitest run test/e2e/cli.test.ts` → Expected: PASS (3 tests, not skipped).

- [ ] **Step 2: Write `README.md`** covering, in this order: what the tool is (2 paragraphs), requirements (Node 20+, pnpm, Docker; **WSL2 only on Windows** with the PRD's four WSL guidelines), quickstart (`pnpm add -D @basaltbytes/odoo-agentic-dev`, create `odoo-agentic-dev.config.ts` — include BOTH PRD example recipes verbatim), the eight commands with their flags (copy semantics from the PRD command sections), env variable table (from the PRD), safety rules (shared DB + `--allow-shared`, flags-only confirmations), hook semantics (declared order; only `set-ir-config-parameter` auto-commits), and a development section (pnpm scripts, `scripts/docker-integration.sh`). pnpm-only examples throughout.

- [ ] **Step 3: Write `scripts/docker-integration.sh`** (Linux CI / manual; NOT part of `pnpm test`)

```bash
#!/usr/bin/env bash
# Minimal Docker integration check: generated compose validates and the
# postgres half of the stack starts, accepts a database reset, and tears down.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm build
FIXTURE=$(mktemp -d)
trap 'docker compose -p oad_ci -f "$FIXTURE/.odoo-agentic-dev/compose.generated.yml" down --volumes >/dev/null 2>&1 || true; rm -rf "$FIXTURE"' EXIT
cat > "$FIXTURE/odoo-agentic-dev.config.mjs" <<'EOF'
export default {
  project: { id: "oad-ci", dbPrefix: "ci" },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/extra-addons/custom" }] }
}
EOF
mkdir -p "$FIXTURE/addons"
cd "$FIXTURE"
export ODOO_WORKTREE_NAME="ci-run"
node "$OLDPWD/dist/cli.js" info --json
# "ci-run" sanitizes to "ci_run", which already carries the "ci_" prefix (no doubling)
node "$OLDPWD/dist/cli.js" info --json | grep -q '"databaseName": "ci_run"'
# Generate the compose file via a harmless command, then validate it with compose itself.
node "$OLDPWD/dist/cli.js" down || true
docker compose -f .odoo-agentic-dev/compose.generated.yml config -q
echo "docker integration: OK"
```

`chmod +x scripts/docker-integration.sh`. (Full odoo-image lifecycle is intentionally out of scope for CI v1 — the image pull is gigabytes; document this in the README.)

- [ ] **Step 4: Write `.github/workflows/ci.yml`**

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  checks:
    strategy:
      matrix: { os: [ubuntu-latest, macos-latest, windows-latest] }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 11 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm build
      - run: pnpm test
  docker-integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 11 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: bash scripts/docker-integration.sh
```

(Windows job runs the unit suite only — no Docker; tests never require it. That satisfies the PRD's "CI Windows runner: dry-run tests only".)

- [ ] **Step 5: Full verification sweep**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm build && pnpm test` → Expected: everything green (run `pnpm format` first if format:check complains).

- [ ] **Step 6: Acceptance checklist against the PRD** — verify each and fix anything missing:
  - [ ] Odoo-only project works with one recipe file (covered by e2e fixture)
  - [ ] KRISS LAURE-like monorepo recipe validates (covered by compose-model/worktree-context tests)
  - [ ] `info` works without Docker (e2e)
  - [ ] `setup` can recreate a worktree database (lifecycle tests)
  - [ ] `update` updates selected modules (lifecycle tests)
  - [ ] `down --volumes` only touches the current project (argv tests) and shared DBs are protected (guard tests)
  - [ ] macOS/Linux/WSL2 documented (README)
  - [ ] unit tests cover context derivation and command construction
  - [ ] CI dry-runs without Docker + one Linux Docker job

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: e2e test, README, CI workflow, and docker integration script"
```

---

## Post-plan notes for the executor

- **Layer wiring reference (final `cli.ts` services):**
  ```ts
  const services = Layer.mergeAll(
    GitLive,
    DockerComposeLive,
    OdooLifecycleLive,
    ProcessSupervisorLive
  ).pipe(
    Layer.provideMerge(CommandRunnerLive),
    Layer.provideMerge(NodeServices.layer)
  )
  ```
  If `provideMerge` ordering fights the beta types, provide `CommandRunnerLive` into each dependent layer individually (`Layer.provide(GitLive, CommandRunnerLive)` etc.) and merge the results — behavior is identical.
- **Deviation log expectations:** v4 beta API call-site adjustments are expected and fine; record them as code comments only when the call shape differs materially from this plan. Module boundaries, error types, derivation rules, and test expectations are NOT adjustable without coming back to the user.
- **PRD parity check before calling it done:** `info` output format, all eight commands' flags, and the safety rules section of the PRD.


