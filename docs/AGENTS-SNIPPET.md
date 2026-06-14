# Paste-ready agent doc

Copy the block below into your project's `CLAUDE.md` / `AGENTS.md` so coding
agents drive the environment through the CLI instead of improvising.

---

## Odoo dev environment (odoo-agentic-dev)

Local Odoo environments are managed by `@basaltbytes/odoo-agentic-dev`
(command: `oad`, long form `odoo-agentic-dev`; without a global install use
`npx oad`). One isolated stack (database, ports, Docker Compose project) is
derived deterministically from the current git worktree/branch — same branch,
same database, same ports, on every machine.

- `oad info --json` — the resolved context: database, ports, `odooUrl`
  (browser URL), and every env var the tooling derives.
- `oad setup` — prepare a fresh worktree end to end (deps, Docker image,
  database init, optional template snapshot).
- `oad up --detach` / `down` — start/stop the stack (`up` rebuilds by
  default; pass `--no-build` only when the image is known fresh).
- `oad restart` — fast Odoo process restart when the server hangs; use
  `oad restart --rebuild` after changing image inputs.
- `oad reset-db --json` — recreate the database (fast template restore when
  the recipe hasn't changed).
- `oad update <modules>` / `test --tags <tags>` — module upgrade / Odoo test
  runs against this worktree's database.
- Add `--build` to `reset-db`, `update`, or `test` after changing `odoo.build`,
  `odoo.dockerfile`, or files copied into the Odoo image. These commands warn
  when tracked image inputs look stale.
- `oad run -- <cmd>` — run any host command with the context env injected
  (`ODOO_DATABASE`, `ODOO_BASE_URL`, companion app ports). Never hand-assemble
  these variables.
- `oad compose -- <args>` — Docker Compose scoped to this worktree's project.
  Never call `docker compose` directly.

Rules:

- Every command exits non-zero on failure. Mutating commands accept `--json`:
  exactly one JSON object on stdout (`ok`, `database`, `durationMs`, …), all
  logs on stderr.
- There are no interactive prompts — nothing ever waits for input. Destructive
  actions need explicit flags (`--yes`, `--volumes`, `--allow-shared`).
- A refusal to touch the shared database is a safety guard, not an error to
  work around. Stop and ask before reaching for `--allow-shared`.
- If `oad test` fails because Odoo skipped browser tests due to missing
  browser dependencies, add them to `odoo.build`, rebuild, and rerun. Use
  `oad doctor --deep` to probe browser-test dependencies inside the image.
- Worktree creation/teardown is handled by the configured agent hooks — do not
  write setup or teardown scripts.
