#!/bin/bash
# Boot a throwaway Agent Wrangler with this extension and a set of fixture
# cards, then run screens.mjs against it in headless Chromium:
#   AW_REPO=<wrangler checkout, npm ci'd> e2e/run.sh [out dir]
# Screenshots go to the out dir (default e2e/screens/, git-ignored).
# With E2E_README=1, a passing run also copies readme.png over the README's
# screenshot, docs/notes/needs-you.png.
# With E2E_SERVE=1 it prints the board URL and waits instead of running
# screens.mjs, so you can look by hand. Ctrl-C stops it.
#
# Everything is throwaway, as in scripts/boot-smoke.sh: a fresh data dir, a
# free port, AW_DEV=1 and HOME inside the data dir. The cards have no process,
# so nothing is launched or billed. screens.mjs never answers a live card: the
# one delivery it makes goes to an archived card, which core refuses.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
out="${1:-$here/screens}"
repo="${AW_REPO:-}"
if [ ! -f "$repo/server/index.js" ]; then
  echo "e2e: AW_REPO must point at an agent-wrangler checkout (got '${repo}')" >&2
  exit 2
fi
if [ ! -d "$repo/node_modules/ws" ]; then
  echo "e2e: run 'npm ci --ignore-scripts' in $repo first" >&2
  exit 2
fi
if [ ! -f "$root/node_modules/zod/package.json" ] || [ ! -d "$here/node_modules/playwright-core" ]; then
  echo "e2e: run 'npm ci --ignore-scripts' in $root and in $here first" >&2
  exit 2
fi

data="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/needsyou-e2e-XXXXX")"
mkdir -p "$data/extensions/needsyou" "$data/home"
node "$here/fixtures.mjs" "$data"
rsync -a --exclude .git --exclude e2e "$root/" "$data/extensions/needsyou/"
port="$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"

HOME="$data/home" AW_DEV=1 AW_DATA_DIR="$data" AW_PORT="$port" \
  env -u CLAUDE_CONFIG_DIR -u CODEX_HOME -u AW_TMUX_SOCKET \
  node "$repo/server/index.js" > "$data/server.log" 2>&1 &
pid=$!
# shellcheck disable=SC2329 # called by the EXIT trap
stop() {
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  sock="$(node -e "try{console.log(require('$data/config.json').tmuxSocket||'')}catch{}")"
  [ -n "$sock" ] && tmux -L "$sock" kill-server 2>/dev/null
  if [ -n "${E2E_KEEP:-}" ]; then echo "e2e: kept $data"; else rm -rf "$data"; fi
}
trap stop EXIT

for _ in $(seq 120); do
  curl -s -o /dev/null "http://127.0.0.1:$port/" && break
  if ! kill -0 "$pid" 2>/dev/null; then break; fi
  sleep 0.5
done
if ! curl -s -o /dev/null "http://127.0.0.1:$port/"; then
  echo "e2e: wrangler did not serve on port $port; its log:" >&2
  cat "$data/server.log" >&2
  exit 1
fi
echo "e2e: wrangler serving on http://127.0.0.1:$port (data dir $data)"

if [ -n "${E2E_SERVE:-}" ]; then
  echo "e2e: E2E_SERVE set; Ctrl-C to stop"
  wait "$pid"
  exit 0
fi

E2E_DATA_DIR="$data" node "$here/screens.mjs" "$port" "$out"
status=$?
if [ "$status" -eq 0 ] && [ -n "${E2E_README:-}" ]; then
  cp "$out/readme.png" "$root/docs/notes/needs-you.png" && echo "e2e: updated docs/notes/needs-you.png"
fi
if [ "$status" -ne 0 ]; then
  sed 's/^/wrangler log: /' "$data/server.log" | tail -40 >&2
  echo "e2e: screens.mjs failed (exit $status)" >&2
fi
exit "$status"
