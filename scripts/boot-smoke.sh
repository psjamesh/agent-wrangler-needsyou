#!/bin/bash
# Boot agent-wrangler with this extension installed and run dev-smoke.mjs
# against it (CI's smoke step; runs the same way locally):
#   AW_REPO=<wrangler checkout, npm ci'd> scripts/boot-smoke.sh [extension dir]
# The extension dir must have its node_modules (npm ci here first).
#
# Everything is throwaway: a fresh data dir, a free port, AW_DEV=1, and HOME
# pointed inside the data dir, so the boot cannot read or write the real
# ~/.agent-wrangler, ~/.claude or ~/.codex. The extension is COPIED into
# <data dir>/extensions/needsyou (discovery skips a symlink). The seeded cards
# have no process, nothing delivers to a live one, and no session is started,
# so nothing is billed. Exits with dev-smoke's status, 1 if the wrangler never
# serves, 2 on bad usage.
set -u
here="$(cd "$(dirname "$0")/.." && pwd)"
src="$(cd "${1:-$here}" && pwd)" || exit 2
repo="${AW_REPO:-}"
if [ ! -f "$repo/server/index.js" ]; then
  echo "boot-smoke: AW_REPO must point at an agent-wrangler checkout (got '${repo}')" >&2
  exit 2
fi
if [ ! -d "$repo/node_modules/ws" ]; then
  echo "boot-smoke: run 'npm ci --ignore-scripts' in $repo first" >&2
  exit 2
fi
if [ ! -f "$src/node_modules/zod/package.json" ]; then
  echo "boot-smoke: run 'npm ci' in $src first (the copy needs node_modules)" >&2
  exit 2
fi

data="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/needsyou-smoke-XXXXX")"
mkdir -p "$data/extensions/needsyou" "$data/home"
# Three cards with no process behind them: one the human launched, one it
# spawned (so it may not ask the human), and one archived (so a delivery to it
# is refused, never woken).
node - "$data" <<'JS'
const fs = require('node:fs'), path = require('node:path');
const now = Date.now();
const card = (intent, extra = {}) => ({ short: 'smoke', tmux: null, cwd: null, agent: 'claude', intent, createdAt: now, archived: false, ...extra });
fs.writeFileSync(path.join(process.argv[2], 'mappings.json'), JSON.stringify({
  'smoke-human': card('Smoke fixture launched by the human; no process started', { name: 'Smoke human' }),
  'smoke-worker': card('Smoke fixture spawned by smoke-human; no process started', { name: 'Smoke worker', spawnedBy: 'smoke-human', parentSession: 'smoke-human' }),
  'smoke-archived': card('Archived smoke fixture', { name: 'Smoke archived', archived: true, archivedAt: now }),
}));
JS
rsync -a --exclude .git "$src/" "$data/extensions/needsyou/"
port="$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"

HOME="$data/home" AW_DEV=1 AW_DATA_DIR="$data" AW_PORT="$port" \
  env -u CLAUDE_CONFIG_DIR -u CODEX_HOME -u AW_TMUX_SOCKET \
  node "$repo/server/index.js" > "$data/server.log" 2>&1 &
pid=$!
# shellcheck disable=SC2329 # called by the EXIT trap
stop() {
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  # The data dir's own generated socket name, never a shared one.
  sock="$(node -e "try{console.log(require('$data/config.json').tmuxSocket||'')}catch{}")"
  [ -n "$sock" ] && tmux -L "$sock" kill-server 2>/dev/null
  if [ -n "${AW_SMOKE_KEEP:-}" ]; then echo "boot-smoke: kept $data"; else rm -rf "$data"; fi
}
trap stop EXIT

for _ in $(seq 120); do
  curl -s -o /dev/null "http://127.0.0.1:$port/" && break
  if ! kill -0 "$pid" 2>/dev/null; then break; fi
  sleep 0.5
done
if ! curl -s -o /dev/null "http://127.0.0.1:$port/"; then
  echo "boot-smoke: wrangler did not serve on port $port; its log:" >&2
  cat "$data/server.log" >&2
  exit 1
fi
echo "boot-smoke: wrangler serving on port $port (data dir $data)"

AW_REPO="$repo" AW_SMOKE_DATA_DIR="$data" node "$here/scripts/dev-smoke.mjs" "$port"
status=$?
# The whole log on a failure; otherwise only what concerns extensions.
if [ "$status" -ne 0 ]; then
  sed 's/^/wrangler log: /' "$data/server.log" >&2
  echo "boot-smoke: dev-smoke failed (exit $status)" >&2
else
  grep -iE 'extension|needsyou|quarantin' "$data/server.log" | sed 's/^/wrangler log: /'
fi
exit "$status"
