# Needs you — shared contracts

These contracts are the interface between workstreams. **Only the orchestrator changes this file.**
If a worker finds a problem here, it messages the orchestrator.

## 1. Identity & manifest

- Extension id: **`needsyou`**. The directory name, `package.json` `wranglerExtension.id` and the
  runtime manifest `id` must all match.
- Label `Needs you`. Description: "A triage queue of the decisions and actions your sessions need from you."
- **Internal names deliberately keep `inbox`:** the store (`host.stores.inbox`), the data file
  (`inbox.json`), the graph key (`graph.inbox`), the `inbox-*` message types, the `ibx-` CSS
  prefix and the file names. The skill is `needs-you` (renamed from `inbox` in 0.1.6). Only the extension id, and what must equal it
  (directory, `/ext/<id>/` asset paths, `#view=ext:<id>:…` routes, `ext:<id>` frame and event
  types), is `needsyou`.
- `engines.wranglerApi: "^1.57.0"` in both `package.json` and the manifest.
- `requires`, identical in both places:
  `["sessions:read", "tasks:read", "deliver", "board:rebuild"]`. Nothing broadcasts: the client
  reads the graph, and handlers use `reply` only for errors. Don't request what isn't used.
- `defaultEnabled: true`.
- Dependencies: runtime `zod` only, so `package-lock.json` is mandatory; dev `happy-dom`.
- Root `index.js` only re-exports `server/manifest.js`
  (`export { default, dir } from './server/manifest.js'`).
- Nothing may import `../index.js` or any agent-wrangler module (see wrangler-squared `AGENTS.md`,
  "Invariants & footguns").

### Manifest shape (written once by WS-1, fixed afterwards)

```js
export default {
  id: 'needsyou', label: 'Needs you', description, help, author: 'PortSwigger', defaultEnabled: true,
  engines: { wranglerApi: '^1.57.0' }, dir,
  requires: [...as above],
  stores: { inbox: (bag) => new InboxStore({ file: inboxFile(bag), getSettings: () => bag.settings?.all?.() ?? {}, log: bag.log }) }, // WS-1: bag.settings is a frozen { get, all } view
  tools: inboxTools,           // server/tools/index.js (WS-2)
  handlers: inboxHandlers,     // server/handlers/index.js (WS-1): [...read, ...answer, ...observe]
  graph: inboxGraph,           // server/graph.js (WS-1)
  session: lifecycleHooks,     // server/lifecycle.js (WS-5): { onArchive, onPurge }
  sweeps: inboxSweeps,         // server/sweeps.js (WS-5)
  settings: SETTINGS,          // §7, inline in manifest (WS-1)
  skills: ['needs-you'],       // skills/needs-you/SKILL.md (WS-2; was 'inbox' before 0.1.6)
  client: 'public/index.js',   // WS-4
  styles: 'public/styles.css', // WS-4
};
```

WS-1 confirms the exact `sweeps` entry shape (and how a store factory reads settings) against
agent-wrangler's `validateManifest` and the `todos` builtin, then records both in `AGENTS.md`.

## 2. Item model (`server/item.js`, WS-1)

```ts
type Kind   = 'decision' | 'approval' | 'question' | 'action' | 'blocked';
type Source = 'agent' | 'status';
type StatusCause = 'permission' | 'question' | 'trust' | 'sign-in' | 'update' | 'container' | 'api-error' | 'other';
type State  = 'open' | 'answered' | 'resolved';
type ResolvedReason =
  | 'delivered'           // agent item: answer reached the session
  | 'withdrawn'           // agent called withdraw_human_request
  | 'answered-elsewhere'  // up to 0.1.7 only (issue #1); kept so older items still read
  | 'status-cleared'      // status item: session left needs-you
  | 'dismissed'           // human dismissed
  | 'session-archived'
  | 'expired';            // agent item past expiresAt

interface Option { id: string; label: string; description?: string }  // id: /^[a-z0-9][a-z0-9-]{0,31}$/

interface Item {
  id: string;               // 'ibx_' + 12 random hex
  source: Source;
  kind: Kind;               // 'blocked' iff source === 'status'
  sessionId: string;        // card id, never a liveSessionId
  taskId: string | null;
  title: string;            // 1..120 chars, single line
  body: string;             // markdown, 0..8000 chars
  options: Option[];        // 0..6; agent items only
  allowFreeText: boolean;   // always true after creation or normalization, including saved false values
  blocking: boolean;        // agent: default true; status: true
  urgency: 'normal' | 'high';
  dedupeKey: string;        // agent: `agent:<sid>:<key or id>`; status: `status:<sid>:<episode>`
  state: State;
  resolvedReason: ResolvedReason | null;
  createdAt: number; updatedAt: number;  // epoch ms
  readAt: number | null;
  expiresAt: number | null;
  answer: null | {
    optionId: string | null; text: string | null; at: number;
    delivery: 'pending' | 'delivered' | 'failed'; deliveryError: string | null; attempts: number;
  };
  status?: {                // status items only
    waitingFor: string | null;
    waitingReason: string | null;
    episode: string;
    cause: StatusCause;     // 0.1.2: set by reconcile's causeFor; missing/invalid → 'other'
  };
}
```

- **Unread:** `state === 'open' && readAt === null`. It only decides the row dot,
  never toast notifications, the order or the badge.
- **Needs action:** `state === 'open'`, or an `answered` item whose delivery `failed`.
- **Validation:** `validateAgentRequest(args) -> { ok, value | error }` and `normaliseItem(raw)`
  enforce every limit, and nowhere else does.

## 3. Store API (`server/store.js`, WS-1)

`host.stores.inbox` is an `InboxStore`. Methods are synchronous, persist atomically before
returning, and throw `Error` with a human-readable message on misuse. Callers then
`await host.rebuild()`.

```ts
class InboxStore {
  constructor({ file, now = Date.now, idGen, getSettings })
  snapshot(): Item[]                                     // deep copy, newest first
  get(id): Item | null
  openForSession(sessionId): Item[]
  findOpenByDedupe(dedupeKey): Item | null
  create(fields): Item                                   // fields per §2 minus id/state/timestamps/readAt/answer/resolvedReason
  update(id, patch): Item                                // open items only; in place; keeps id and readAt
                                                         // patch ⊆ { title, body, options, allowFreeText, blocking,
                                                         //   urgency, expiresAt, status }, all validated as in create
  markRead(ids: string[]): number
  answer(id, { optionId?, text? }): Item                 // open -> answered, delivery 'pending'
  setDelivery(id, { delivery, deliveryError? }): Item    // success -> resolved('delivered')
  resolve(id, reason): Item | null                       // idempotent; null if already resolved
  resolveWhere(pred, reason): Item[]
  remove(ids: string[]): number
  // who may ask the human (see §8)
  canAskOverride(sessionId): boolean | null              // null = no override
  setCanAskOverride(sessionId, value: boolean | null): void
  forgetSession(sessionId): void                         // remove items + override (purge)
  rev(): number
}
```

- **Answers:** every agent request accepts standalone nonempty `text` instead of an option,
  or an optional note alongside a valid selected option. `allow_free_text` is accepted and
  boolean-validated for compatibility, but deprecated and ignored. New and normalized metadata
  have `allowFreeText: true`; existing saved `false` values do not restrict text replies.
  Invalid option ids are rejected even with text. Text is trimmed, blank notes become `null`,
  and non-blank text is limited to 4000 characters after trimming. An answer without a valid
  option or nonempty text is rejected.
- **Caps:**
  - 500 items in total; `create` first prunes the oldest resolved items, and throws if every item
    is open.
  - `maxOpenPerSession` open agent items per session (fallback 5); `create` throws past it.
- **Persistence:**
  - File: `<DATA_DIR>/inbox.json`, shaped `{ version: 1, items, canAsk: { [sessionId]: boolean } }`.
  - Writes: temp-file + rename.
  - `DATA_DIR`: `process.env.AW_DATA_DIR || ~/.agent-wrangler`.
  - Corrupt file: renamed `inbox.json.corrupt-<ts>`, and the store starts empty, logged once.

## 4. Graph contribution (`server/graph.js`, WS-1)

```js
graph: ({ host }) => ({ inbox: {
  rev,
  unread,     // open && readAt === null
  open,       // open + answered-with-failed-delivery
  items,      // open + answered, then resolved updated < 24 h ago; ≤200, newest first
  sessions: { [sessionId]: { name, taskId, taskName, spawnedBy, canAsk, canAskOverride } },
  // listed: item sessions, every session with spawnedBy set, and each listed session's spawner (0.1.1, F4),
  // all with the same full entry shape.
  // canAskOverride: true | false | null (null = no override, the default applies) (0.1.1, F3).
}})
```

`canAsk` is the effective value from §8. The graph key `inbox` is not in core's
`RESERVED_GRAPH_KEYS` (checked 2026-11-03).

## 5. Control messages (client → server)

Handlers are `{ type, handler(msg, host, reply) }`. Each mutation ends with
`await host.rebuild()`. Errors are thrown, and the router turns them into an error toast.

| type | payload | owner | effect |
| --- | --- | --- | --- |
| `inbox-mark-read` | `{ ids: string[] }` (≤200) | WS-1 `handlers/read.js` | `store.markRead` |
| `inbox-dismiss` | `{ id }` | WS-1 `handlers/read.js` | `resolve(id,'dismissed')`; a status item stays dismissed for that episode only |
| `inbox-answer` | `{ id, optionId?, text? (≤4000) }` | WS-2 `handlers/answer.js` | `store.answer`, then `deliverAnswer` (§6) |
| `inbox-retry` | `{ id }` | WS-2 `handlers/answer.js` | re-deliver an `answered` + `failed` item |
| `inbox-set-can-ask` | `{ sessionId, allowed: boolean \| null }` | WS-2 `handlers/answer.js` | `setCanAskOverride`; `null` restores the default |
| `inbox-observe` | `{ sessions: ObservedSession[], complete: true }` | WS-3 `handlers/observe.js` | `reconcile(store, sessions, { settings, now })` → `{ opened, updated, resolved }` |

```ts
interface ObservedSession { sessionId: string; status: string; waitingFor: string | null; waitingReason: string | null; updatedAt: number | null }
```

`complete: true` means **every** non-archived session in the tab's graph is listed. Caps: ≤500
entries, strings ≤500 chars.

`inbox-set-can-ask` is only ever sent by the human's browser. No MCP tool or other path reaches it.

## 6. Answer delivery (`server/answer.js`, WS-2)

`deliverAnswer(host, store, id) -> Promise<Item>` calls `host.deliver(item.sessionId, text)`. The
real `host.deliver` doesn't throw for a refusal (confirmed by WS-1 against agent-wrangler main):
- it resolves `{ mode: 'live' | 'dormant' }` on success → `setDelivery('delivered')`
- it resolves `{ mode: 'error', error }` on failure, including archived or unknown cards →
  `setDelivery('failed', error)`
- if it does throw anyway, treat that as `failed` with the message. `deliverAnswer` never throws
  for a delivery failure.

Text format:

```
[Needs you] The human answered your request "<title>" (<item id>).
Choice: <option label> (<option id>)        ← omitted when no option
Note: <free text>                           ← omitted when empty
```

We deliberately do not use mail. Extension mail is sent as `ext:needsyou` and framed as an untrusted
peer message inviting a `send_message` reply to an address that isn't a session.

## 7. Settings (declared in the manifest by WS-1)

| key | type | fallback in code | consumer |
| --- | --- | --- | --- |
| `includeTransientApiErrors` | toggle | `false` | WS-3 |
| `maxOpenPerSession` | number, 1–20 | `5` | WS-1 store / WS-2 tool |
| `retentionDays` | number, 1–90 | `7` | WS-5 |
| `toastNotifications` | toggle | `false` | WS-4 client |

## 8. Who may ask the human (`server/can-ask.js`, WS-2)

`canAsk(host, store, sessionId) -> { allowed: boolean, spawnedBy: string | null }`:
1. A store override (`true`/`false`) wins.
2. Otherwise `allowed = !host.sessions.get(sessionId)?.spawnedBy`.

`spawnedBy` is always returned, so the refusal can name the spawner, or say the human turned
direct requests off when there is no spawner.

The human sets overrides from the card menu (WS-4 → `inbox-set-can-ask`). No agent can.

## 9. MCP tools (WS-2)

`request_human_input`, `withdraw_human_request`, `list_my_human_requests`. Each is
`handler({ host, caller }, args)` with no session parameter: `caller` is the card id. Schemas are
in `ws2-agent-requests.md`.

## 10. Client module exports (fixed so WS-3 and WS-4 can work in parallel)

- **`public/observer.js` (WS-3):** `export function startObserver(api) -> { update(graph), stop() }`.
  It sends only on change, plus on every `api.onConnect`.
- **`public/index.js` (WS-4):**
  - calls `startObserver(reg.api)` once, and `observer.update(graph)` from the view's `update` and
    the `card.pill` `update`, deduplicated by graph identity
  - doesn't touch the observer's internals

## 11. Deferred to v1.1 (do not build)

"Proceed unless vetoed" requests: `default_option` + `proceed_after_minutes` on
`request_human_input`, with a countdown in the queue. This is an item-model change, so it waits
until v1 ships.

## 12. Events

None in v1 (no `events` capability). v1.1 adds `ext:needsyou:attention` (overview §8).
