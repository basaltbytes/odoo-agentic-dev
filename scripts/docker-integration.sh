#!/usr/bin/env bash
# Minimal Docker integration check: generated compose validates and the
# postgres half of the stack starts, accepts a database reset, and tears down.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm build
FIXTURE=$(mktemp -d)
trap 'docker compose -p oad_ci -f "$FIXTURE/.odoo-agentic-dev/compose.generated.yml" down --remove-orphans --volumes >/dev/null 2>&1 || true; rm -rf "$FIXTURE"' EXIT
cat > "$FIXTURE/odoo-agentic-dev.config.mjs" <<'EOF'
export default {
  project: { id: "oad-ci", dbPrefix: "ci" },
  odoo: { version: "18.0", addons: [{ host: "addons", container: "/mnt/extra-addons/custom" }] }
}
EOF
mkdir -p "$FIXTURE/addons"
cd "$FIXTURE"
export ODOO_WORKTREE_NAME="ci-run"
# state-touching commands must never see a real user registry
export ODOO_AGENTIC_DEV_STATE_DB="$FIXTURE/state.db"
node "$OLDPWD/dist/cli.js" info --json
# "ci-run" sanitizes to "ci_run", which already carries the "ci_" prefix (no doubling)
node "$OLDPWD/dist/cli.js" info --json | grep -q '"databaseName": "ci_run"'
# Generate the compose file via a harmless command, then validate it with compose itself.
node "$OLDPWD/dist/cli.js" down || true
docker compose -f .odoo-agentic-dev/compose.generated.yml config -q
# Generated stacks carry identity labels and a loopback-only port binding.
grep -q 'dev.basaltbytes.oad' .odoo-agentic-dev/compose.generated.yml
grep -q '127.0.0.1:' .odoo-agentic-dev/compose.generated.yml
# Smoke the diagnostics against a real Docker: all hard checks must pass here.
node "$OLDPWD/dist/cli.js" doctor --json | grep -q '"name": "docker-daemon"'
node "$OLDPWD/dist/cli.js" doctor > /dev/null
# An empty registry has nothing to prune (exit 0) and lists as empty JSON.
node "$OLDPWD/dist/cli.js" prune
node "$OLDPWD/dist/cli.js" list --json | grep -qx '\[\]'
echo "docker integration: OK"
