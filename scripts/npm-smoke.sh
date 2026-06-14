#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/oad-npm-smoke.XXXXXX")"
export npm_config_cache="$TMP_ROOT/npm-cache"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

cd "$ROOT"

pnpm build

PACK_JSON="$(pnpm pack --pack-destination "$TMP_ROOT" --json)"
TARBALL="$(
  PACK_JSON="$PACK_JSON" node -e '
    const data = JSON.parse(process.env.PACK_JSON);
    const item = Array.isArray(data) ? data[0] : data;
    console.log(item.filename ?? item.path);
  '
)"

case "$TARBALL" in
  /*) ;;
  *) TARBALL="$ROOT/$TARBALL" ;;
esac

PACKAGE_VERSION="$(node -p "require('./package.json').version")"
PROJECT="$TMP_ROOT/project"
FIXTURE="$PROJECT/fixture"

mkdir -p "$FIXTURE/addons"
cd "$PROJECT"

npm init -y >/dev/null
npm install --ignore-scripts --no-audit --no-fund "$TARBALL" >/dev/null

BIN="$PROJECT/node_modules/.bin/oad"

VERSION_OUT="$("$BIN" --version)"
if [[ "$VERSION_OUT" != "$PACKAGE_VERSION" && "$VERSION_OUT" != "odoo-agentic-dev v$PACKAGE_VERSION" ]]; then
  echo "expected oad --version to print $PACKAGE_VERSION, got: $VERSION_OUT" >&2
  exit 1
fi

"$BIN" --help | grep -q "Agent-friendly local Odoo development runtime"

cd "$FIXTURE"
INIT_JSON="$TMP_ROOT/init.json"
"$BIN" init --id smoke-app --db-prefix smoke --odoo-version 18.0 --json >"$INIT_JSON"
grep -q '"ok":true' "$INIT_JSON"
test -f odoo-agentic-dev.config.ts
test -f .gitignore

echo "npm package smoke passed: $TARBALL"
