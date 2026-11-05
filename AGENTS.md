# AGENTS.md

Developer notes for **Needs you**: an installable Agent Wrangler extension (id `needsyou`) that
keeps a triage queue of the decisions and actions sessions need from the human. Only the
non-obvious, durable things live here. The specs in `docs/specs/` are the design, and
`docs/specs/01-contracts.md` is the interface between workstreams.

## This repository is public open source

Everything here is public: code, commits, branch names, docs and test fixtures. Never put
anything employer- or customer-specific in them: internal hostnames, service or repo names,
ticket keys, chat channels, colleague names, credentials. Keep examples generic
(`example.com`, `acme/widgets`).

## What this is

- An **external extension** for agent-wrangler's extensions API, written against host API
  `^1.57.0`. The wrangler copies it into `<DATA_DIR>/extensions/needsyou/`, runs
  `npm ci --ignore-scripts` and imports `index.js`. **The manifest `id` (`needsyou`) must equal
  that directory name.**
- Only the id (and what must equal it: the directory, `/ext/needsyou/` assets,
  `#view=ext:needsyou:…` routes, `ext:needsyou` frame types) is `needsyou`. The skill is
  `needs-you` (`skills/needs-you/`), the name agents and the human see. Internal names keep
  `inbox` on purpose: `host.stores.inbox`, `inbox.json`, `graph.inbox`, the `inbox-*` message
  types, the `ibx-` CSS prefix and the file names.
- `package.json`'s `wranglerExtension` block is what the human consents to before any code runs,
  so it duplicates `server/manifest.js` by design. `id`, `requires` and `engines` must agree
  exactly (`server/manifest.test.js` and `scripts/validate-manifest.mjs` both check).
- **`package-lock.json` is mandatory**: the wrangler refuses to install without one. Regenerate
  it after any dependency change. Runtime dependency: `zod` only.

## Invariants & footguns

- **Nothing here may import agent-wrangler.** The extension reaches the wrangler only through the
  `host` façade it is handed. Its keys are exactly what `requires` grants (`sessions:read`,
  `tasks:read`, `deliver`, `board:rebuild`) plus the always-present `id`, `version`, `stores`,
  `settings`, `log`. There is no `host.broadcast`: the client reads the graph.
- **No own file may have a static `import` line matching `from '../../index.js'` (two or more
  `../` levels; a single `../index.js` is not matched), or a path ending `/session-manager.js`,
  `/state-reader.js`, `/tmux-scraper.js`, or containing `/host-api/`.** The wrangler's import
  scanner (`server/extensions/external.js` `FORBIDDEN_IMPORTS`, checked on main 2026-11-03)
  quarantines the whole extension on a match. It skips `*.test.js`/`*.spec.js` files, directories
  named `test`, `tests`, `__tests__`, `spec` or `__mocks__`, `node_modules`, and the root `skills/`.
  Even so, keep the manifest in `server/manifest.js` with the root `index.js` only re-exporting it,
  and have tests import `./manifest.js`, never the root: the scanner's rule can change.
- **`host.sessions.*` has no `status`, `waitingFor` or `waitingReason`.** Only the browser's graph
  does, so status detection runs client-side (`public/observer.js` → `inbox-observe`).
- **`host.deliver(sessionId, text)` resolves to `{ mode: 'live' | 'dormant' }` on success and
  `{ mode: 'error', error }` on failure**, including an archived card, which it refuses. It does
  not return `{ ok }`, and it does not throw for a refusal. Treat `mode === 'error'` as failed.
- **Signatures:** a control handler is `handler(msg, host, reply)`; throw to report an error (the
  router sends it to the requesting tab as a toast). An MCP tool is `handler({ host, caller }, args)`,
  `caller` being the card id.
- **Every store mutation is synchronous and persisted before it returns; then call
  `await host.rebuild()`.** Mutate only through `InboxStore` (contracts §3).
- **A setting def has no `default`** (the loader refuses one). An unset setting reads
  `undefined` and each consumer applies the fallback from contracts §7.
- Agent-written text goes into the DOM with `textContent` or the sanitised
  `api.ui.markdownPreview`, never raw `innerHTML`. Colour only through the board's CSS variables.

## Confirmed against agent-wrangler main (host API 1.57.0)

These are checked against `server/extensions/index.js` (`validateManifest`), `server/index.js`
(activation) and the builtins (`todos`, `checklist`).

- **Sweeps:** each `sweeps` entry is `{ id: string, everyMs: number, run }`. `id` must be a
  non-empty string, `everyMs` a positive finite number and `run` a function, or the manifest is
  quarantined. `run({ host })` gets this extension's façade and nothing else, and is called from
  a `setInterval` (unref'd) every `everyMs`. It is fire-and-forget: a returned promise is not
  awaited by the next tick, and a throw or rejection is logged as `[ext:needsyou:<id>]`. At boot,
  sweeps start only after the instance lock; on a live enable, immediately. They stop on disable.
  Example (from the `todos` builtin):
  `sweeps: [{ id: 'strip-legacy', everyMs: 5000, run: ({ host }) => … }]`.
- **Store factory bag:** a factory gets `{ id, extId, settings, log }`. Here `id` is the store
  name (`'inbox'`), `extId` the extension id (`'needsyou'`), `log` the wrangler's error logger,
  and `settings` a frozen read-through **view**, not a values object: `settings.get(key)` and
  `settings.all()` (declared keys only) read config.json on every call, so a value edited in
  Settings lands without a restart. No other façade key exists at factory time. The manifest
  passes `getSettings: () => bag.settings?.all?.() ?? {}`, so `InboxStore` always sees a plain
  values object. `host.settings` in tools, handlers, hooks and sweeps is the same `{ get, all }`
  view.
- **Session hooks:** `session: { onArchive, onPurge }` (also allowed: `onBeforeDispatch`,
  `onFork`, `onDispatch`, `onResume`). Each is called with the core payload plus `host`:
  `onArchive({ sessionId, entry, wasArchived, host })`, `onPurge({ sessionId, host })`. They are
  awaited in turn, and a throw is logged and swallowed.
- **Graph contributor:** `graph({ host, graph })` runs on every rebuild (~4 s) and must not throw.
  At activation it is called once with `graph: {}` and its keys are checked against core's
  reserved keys (`inbox` is free).

## Store notes (`server/store.js`, `server/item.js`)

- `validateAgentRequest(args)` takes the tool's snake_case args (camelCase also accepted) and
  returns only the agent-chosen fields, `{ kind, title, body, options, allowFreeText, blocking,
  urgency, dedupeKey, expiresInMinutes }`. `dedupeKey` is the agent's raw key or `null`. The
  caller adds `sessionId`/`taskId`, prefixes the key as `agent:<sid>:<key>` and turns
  `expiresInMinutes` into `expiresAt`.
- With options, `allowFreeText` defaults to `false` unless the agent sets it. With none, it is
  forced `true`. An option without an `id` gets a slug of its label (or `option-N`). Explicit ids
  must be unique.
- `create` without a `dedupeKey` gives an agent item `agent:<sid>:<item id>`. A status item must
  bring its own (`status:<sid>:<episode>`). `create` refuses a second **open** item with the same
  `dedupeKey`.
- `normaliseItem` coerces (it trims, single-lines and clips text, drops invalid options, forces
  the source invariants) and throws only on what can't be repaired. `create` and `update` both
  run it. Agent input must go through `validateAgentRequest` first, which rejects instead.
- `answer` checks the answer with `validateAnswer`: the option must exist, an optional note
  may accompany any choice, text without a choice needs `allowFreeText`, text is ≤ 4000,
  and an item without options needs text. So `inbox-answer`
  can rely on `store.answer` throwing a message fit for a toast.
- `setDelivery` counts an attempt on every `delivered`/`failed` (`answer.attempts`); `pending`
  does not count. `deliveryError` is clipped to 500 characters.
- `update` takes only open items. An agent item may change `title, body, options,
  allowFreeText, blocking, urgency, expiresAt`. A status item may change
  `title, body, urgency, status`. `id`, `readAt`, `createdAt` and `dedupeKey` are kept.
- `rev()` is seeded from the clock at construction, so a restart never reuses a rev a tab saw.
- The `canAsk` override map persists in `inbox.json` beside the items (`{ version: 1, items,
  canAsk }`). A corrupt file is moved to `inbox.json.corrupt-<ts>` and the store starts empty.
  So is a file that parses but has the wrong shape or version.

## File ownership

Exclusive per workstream (`docs/specs/00-overview.md` §6). Edit only your own files. If you need
anything else, including a contract change, message the orchestrator.

| WS | Owns |
| --- | --- |
| WS-1 Foundation & store | package.json, package-lock.json, index.js, .gitignore, LICENSE, AGENTS.md, CLAUDE.md, test-setup.js, server/manifest.js, server/item.js, server/store.js, server/data-dir.js, server/atomic-json.js, server/graph.js, server/handlers/index.js, server/handlers/read.js, server/test-helpers.js (+ their tests) |
| WS-2 Agent requests | server/tools/**, server/answer.js, server/can-ask.js, server/handlers/answer.js, skills/needs-you/** |
| WS-3 Passive signals | public/observer.js, server/reconcile.js, server/handlers/observe.js |
| WS-4 "Needs you" UI | public/index.js, public/inbox-*.js, public/icons.js, public/styles.css |
| WS-5 Lifecycle & retention | server/lifecycle.js, server/sweeps.js |
| WS-6 Integration & release | scripts/**, .github/**, README.md, docs/notes/**, CHANGELOG.md |

WS-1 wrote the first `scripts/validate-manifest.mjs` and `.github/workflows/test.yml`. Both
pass to WS-6 once WS-1 is merged. The other workstreams' files start as WS-1 stubs that export
the contracted names, so `server/manifest.js` never has to change.

## Verification gate

Nothing lands on `main` without passing the gate. It runs in two places:
- **Local git hooks** (`.pre-commit-config.yaml`), on commit, merge commit and push.
- **CI's `gate` job**, which runs the same hooks on every push and PR, so `--no-verify` or a
  clone without hooks can't bypass it.

Set it up once per clone (each worktree shares the clone's hooks):

```sh
npm ci --ignore-scripts
pre-commit install          # installs the pre-commit, pre-merge-commit and pre-push hooks
```

| Hook | Stage | What it stops |
| --- | --- | --- |
| pre-commit-hooks | commit, merge, push | trailing whitespace, missing final newline, CRLF, merge markers, case clashes, bad YAML/JSON, files over 1 MB, shebang/mode mismatches, private keys |
| gitleaks | commit, merge, push | secrets and tokens |
| no-local-paths | commit, merge, push | absolute paths from one machine (macOS user or temp folders, Linux home folders) in any tracked file. Write a placeholder such as `<AW_DATA_DIR>` instead |
| lockfile-in-sync | when `package*.json` change | a `package-lock.json` that doesn't match `package.json`. Agent Wrangler refuses such installs, and `npm ci --dry-run` doesn't catch it |
| eslint | when JS changes | correctness errors such as unused or undefined names (`eslint.config.js`) |
| npm-test | every commit | any failing unit test, including the manifest/package agreement and forbidden-import scan |
| validate-manifest | push | the real Agent Wrangler loader and MCP server. Needs `AW_REPO`; without it the hook says so and passes, and CI's `test` job always runs it |

- `npm run verify` runs the lockfile check, lint and tests without git.
- `pre-commit run --all-files` runs the whole gate on demand.
- Never commit with `--no-verify` to get past a failure: fix the cause. CI will refuse it anyway.
- When a hook auto-fixes files (whitespace, newlines), the commit stops. Review the changes,
  `git add` them and commit again.

## Commands

- `npm test` runs `node --test --import ./test-setup.js 'server/**/*.test.js' 'public/**/*.test.js'`.
  The globs are quoted so Node expands them, which needs **Node ≥ 21** (CI runs 22 and 24), and
  they reach nested dirs (`server/test-discovery.test.js` checks this). `test-setup.js` points
  `AW_DATA_DIR` at a temp dir, so no test touches `~/.agent-wrangler/inbox.json`.
- `server/test-helpers.js` holds the one fake host every server suite builds on:
  `fakeHost({ sessions, tasks, settings, deliver, now, idGen })` →
  `{ host, store, calls, settings, setSession, removeSession, setTask }`. It has a real
  `InboxStore` on a temp file, and `calls.rebuild` (a count) and `calls.deliver` (each
  `{ sessionId, text }`) as spies. Its default `deliver` answers like the real one, including
  `{ mode: 'error' }` for an unknown or archived card. `seq()` and `clock()` give deterministic
  ids and a hand-cranked clock. It is not named `*.test.js`, so the glob doesn't run it.
- `AW_REPO=<agent-wrangler checkout> node scripts/validate-manifest.mjs` runs the real loader
  over this repo: discovery and the import scan (on a copy named `needsyou`), `validateManifest`,
  `loadExtensions` with the core tool and handler names, the store factory with a real settings
  view, `buildHostApi`, and the graph keys. Before the first run, run `npm ci --ignore-scripts`
  in the agent-wrangler checkout, never in this repo.
- **Dev install:** copy this checkout, `node_modules` included, to
  `<AW_DATA_DIR>/extensions/needsyou` of a dev wrangler (`AW_DEV=1`) and restart it. **Never
  symlink:** discovery keeps only real directories, so a symlink is silently never loaded. A
  hand-placed copy loads with no provenance record and no consent prompt. Check Settings →
  Extensions for "Needs you" (enabled, four settings), and check that `graph.inbox` is present.

## Design notes

The non-obvious decisions from each workstream, and the test procedures, are in
`docs/notes/`. Read the note for an area before changing it.

- [`foundation.md`](docs/notes/foundation.md): manifest, store, graph (WS-1)
- [`agent-requests.md`](docs/notes/agent-requests.md): the MCP tools, answer
  delivery, who may ask (WS-2)
- [`passive-signals.md`](docs/notes/passive-signals.md): the observer and
  reconcile, and the confirmed `AskUserQuestion` coverage (WS-3)
- [`ui.md`](docs/notes/ui.md): the view, keyboard, known UI limits (WS-4)
- [`lifecycle.md`](docs/notes/lifecycle.md): archive and purge hooks, expiry
  and retention sweeps (WS-5)
- [`testing.md`](docs/notes/testing.md): what validate-manifest and the boot
  smoke cover, how to run them, and the manual checklist and compliance eval
  (WS-6)

`scripts/boot-smoke.sh` boots a throwaway wrangler (temp data dir, temp `HOME`,
free port, `AW_DEV=1`) with this checkout copied in, and `scripts/dev-smoke.mjs`
drives it. It needs `npm ci` here first (the copy needs `node_modules`). Its
fixture cards have no process, and it delivers only to an archived card,
because `host.deliver` to a dormant card wakes it and launches a billed agent.
