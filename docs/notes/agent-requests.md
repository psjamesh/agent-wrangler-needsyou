# Agent requests: tools, answers, who may ask (WS-2)

The non-obvious decisions behind `server/tools/`, `server/answer.js`,
`server/can-ask.js`, `server/handlers/answer.js` and `skills/needs-you/`.

## `request_human_input`

- **The order of checks:** identity → canAsk → validate → dedupe update → create.
  The store's `maxOpenPerSession` setting is the only per-session limit. Dedupe
  updates work at the cap; answering or withdrawing a request frees its slot.
- **A dedupe update replaces the request wholesale**: title, body, options and
  the rest, except `kind`, which can't change. It keeps the item's id and read
  state, so the human isn't notified again.
- **The result** is `structuredContent: { id, state, blocking, updated }` plus
  a lead line. A blocking request is told to end its turn. A non-blocking one
  is told to "carry on with work that does not depend on it".
- **`withdraw_human_request` needs a `reason`.** Without one, a closed request
  only said "withdrawn by agent", and the human couldn't tell whether they had
  answered it or the agent had given up. The reason is stored as the item's
  `resolvedNote` and shown after the closed label. It is required, not
  optional, so agents can't skip it; an agent that calls with only an `id` gets
  an error naming the missing `reason` and retries.
- `list_my_human_requests` returns `{ requests: [...] }`, since
  structuredContent must be an object. It lists only the caller's agent items.
- **The tool description is not how agents find the tool.** Agent Wrangler
  measured a tool description alone at 0/6. The `needs-you` skill and its
  WRANGLER.md nudge are what make agents call it. The description says plainly
  what the tool is *not* for.
- **Host-provided Zod 4.** Tool schema factories use `host.schema.z` through
  `schema:zod` on host API `^2.1.0`; the extension has no runtime dependencies.
  `scripts/validate-manifest.mjs` serves them through the wrangler's real
  `buildMcpServer` on every run, and `scripts/dev-smoke.mjs` does it over the
  real `/mcp`. The manifest harness also checks validation limits and compares
  every listed schema with `server/tools/fixtures/input-schemas.json`, the
  pre-migration JSON Schemas including descriptions and nested constraints. Both check that `tools/list` keeps the schemas, that a valid call
  succeeds and that an invalid one is refused.

## Answers

- Every agent request accepts standalone nonempty text instead of a choice,
  or an optional note alongside a valid selected option. `allow_free_text` is
  a deprecated, ignored compatibility parameter; supplied values must still
  be boolean. New and loaded items normalize `allowFreeText` to `true`, so
  saved requests with `false` also accept text. Invalid option ids are rejected
  even with text, as are answers over 4000 characters or without a choice or
  nonempty text. Text is trimmed and blank notes become `null`.

- **Answers go back with `host.deliver`, not mail.** Extension mail is sent as
  `ext:needsyou` and framed as an untrusted peer message that invites a
  `send_message` reply to an address that isn't a session.
- The text starts `[Needs you] The human answered your request "<title>" (<id>).`,
  then `Choice:` and `Note:` lines. The skill teaches agents that prefix, so
  the format is a contract (§6).
- `deliverAnswer` treats anything but `mode: live | dormant` as failed, and
  records `error` results and throws the same way. It never throws for a
  failed delivery. If the item moved on while the delivery was in flight (it was
  withdrawn, say), it records nothing.
- **Delivering to a dormant card wakes it**, which launches the agent. Keep that
  in mind when testing: `scripts/dev-smoke.mjs` delivers only to an archived
  card, which is refused.

## Who may ask

- `canAsk`: a store override (`true`/`false`) wins. Otherwise a session with
  `spawnedBy` is refused. `spawnedBy` is always returned, so the refusal can
  name the spawner, or say the human turned direct requests off.
- **The refusal is an order, not advice (0.1.1).** In the first spawned-worker
  test, refused workers retried the call once and then asked the human in chat;
  none mailed the spawner. The refusal now starts "Refused:" and gives one next
  step ("call send_message now (to: …)"), says not to call the tool again, and
  says the human won't see a question written in chat. `can-ask.test.js` pins
  both variants word for word, and `scripts/dev-smoke.mjs` checks the next step.
- Only `inbox-set-can-ask` changes an override, and only the human's browser
  sends it. No MCP tool reaches it.

## Compliance eval

The procedure is in [`testing.md`](testing.md#compliance-eval-ws-2). The
sessions must be started from the board, not by another session, or the eval
measures the routing path. First run (2026-11-03, Claude only): 3 of 3 raised
`request_human_input` before ending the turn. The Codex half is still to do.
The separate routing eval ([`testing.md`](testing.md#routing-eval-ws-2))
checks that helpers send their questions to their spawner.
