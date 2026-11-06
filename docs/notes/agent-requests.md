# Agent requests: tools, answers, who may ask (WS-2)

The non-obvious decisions behind `server/tools/`, `server/answer.js`,
`server/can-ask.js`, `server/handlers/answer.js` and `skills/needs-you/`.

## `request_human_input`

- **The order of checks:** identity → canAsk → validate → dedupe update → rate
  limit → create. A refusal, a validation failure, a dedupe update or a cap
  refusal doesn't count towards the rate limit (3 new items per session per 10
  minutes), so an agent that restates or fixes a request is never throttled
  for it.
- **A dedupe update replaces the request wholesale**: title, body, options and
  the rest, except `kind`, which can't change. It keeps the item's id and read
  state, so the human isn't notified again.
- **The result** is `structuredContent: { id, state, blocking, updated }` plus
  a lead line. A blocking request is told to end its turn. A non-blocking one
  is told to "carry on with work that does not depend on it".
- `list_my_human_requests` returns `{ requests: [...] }`, since
  structuredContent must be an object. It lists only the caller's agent items.
- **The tool description is not how agents find the tool.** Agent Wrangler
  measured a tool description alone at 0/6. The `needs-you` skill and its
  WRANGLER.md nudge are what make agents call it. The description says plainly
  what the tool is *not* for.
- **zod 4 against the wrangler's zod 3.** This repo's schemas are zod 4 and pass
  straight to the wrangler's MCP SDK, which sits beside zod 3.
  `scripts/validate-manifest.mjs` serves them through the wrangler's real
  `buildMcpServer` on every run, and `scripts/dev-smoke.mjs` does it over the
  real `/mcp`. Both check that `tools/list` keeps the schemas, that a valid call
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
