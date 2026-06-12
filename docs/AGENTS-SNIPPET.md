# Paste-ready agent doc

Copy the block below into your project's `CLAUDE.md` / `AGENTS.md` so coding
agents drive the environment through the CLI instead of improvising.

---

## Odoo dev environment (odoo-agentic-dev)

Local Odoo environments are managed by `@basaltbytes/odoo-agentic-dev`. One
isolated stack (database, ports, Docker Compose project) is derived
deterministically from the current git worktree/branch — same branch, same
database, same ports, on every machine.

- `pnpm exec odoo-agentic-dev info --json` — the resolved context: database,
  ports, URLs, and every env var the tooling derives.
- `pnpm exec odoo-agentic-dev setup` — prepare a fresh worktree end to end
  (deps, Docker image, database init, template snapshot).
- `pnpm exec odoo-agentic-dev up --detach` / `down` — start/stop the stack.
- `pnpm exec odoo-agentic-dev reset-db --json` — recreate the database
  (fast template restore when the recipe hasn't changed).
- `pnpm exec odoo-agentic-dev update <modules>` / `test --tags <tags>` —
  module upgrade / Odoo test runs against this worktree's database.
- `pnpm exec odoo-agentic-dev run -- <cmd>` — run any host command with the
  context env injected (`ODOO_DATABASE`, `ODOO_BASE_URL`, companion app ports).
  Never hand-assemble these variables.
- `pnpm exec odoo-agentic-dev compose -- <args>` — Docker Compose scoped to
  this worktree's project. Never call `docker compose` directly.

Rules:

- Every command exits non-zero on failure. Mutating commands accept `--json`:
  exactly one JSON object on stdout (`ok`, `database`, `durationMs`, …), all
  logs on stderr.
- There are no interactive prompts — nothing ever waits for input. Destructive
  actions need explicit flags (`--yes`, `--volumes`, `--allow-shared`).
- A refusal to touch the shared database is a safety guard, not an error to
  work around. Stop and ask before reaching for `--allow-shared`.
- Worktree creation/teardown is handled by the configured agent hooks — do not
  write setup or teardown scripts.
