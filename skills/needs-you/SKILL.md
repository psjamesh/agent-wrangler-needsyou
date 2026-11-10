---
name: needs-you
description: Use when you need the human to decide, approve or act before you can proceed correctly, or when you are about to end your turn by asking them to choose (next steps, "should I proceed?", a "Decisions for you" list). Raise it in their "Needs you" queue with the request_human_input tool. Also covers [Needs you] answer messages, withdrawing a request, and what to do when the tool refuses.
---

# Needs you

The human runs many sessions at once and does not read every terminal. Their
**"Needs you"** queue on the Agent Wrangler board lists only what needs them to
decide or act. You add to it with the `request_human_input` MCP tool, and their
answer comes back into your prompt.

Three tools, none with a session parameter (they always act for the session you
are running in):

- `request_human_input({ kind, title, body?, options?, allow_free_text?, blocking?, urgency?, dedupe_key?, expires_in_minutes? })`
  queues a request and returns its `id`
- `withdraw_human_request({ id, reason })` takes back a request that no longer needs the human.
  `reason` is one short sentence the human sees on the closed request
- `list_my_human_requests()` lists your open, answered and recently closed requests, with answers

## Always say it in chat too

Every request goes in **both** places. The queue is how the human sees it on
the board. Your reply is where they see it if they are chatting with you right
now. In your reply, write the question, the options and your recommendation,
in the same words as the request. Don't say that you put it in their "Needs
you" queue, or that they can answer there: the board already shows them, and
the line is noise. If the human answers in chat, call
`withdraw_human_request({ id, reason: "User answered in chat" })` straight away
and carry on with their answer.

## When to use it

Only when you **cannot proceed correctly without the human**:

- **decision:** a choice between materially different approaches, where a wrong
  guess costs real rework (schema design, which library, which of two specs to follow)
- **approval:** an irreversible or outward-facing action: deleting data, force-pushing,
  publishing, sending something to another person or service, spending money
- **question:** information or credentials only the human has
- **action:** something only the human can do, such as clicking an OAuth consent,
  plugging in a security key or approving access in another system

## When not to use it

- progress updates, summaries, "I'm done", "tests pass": say those in chat
- questions you can answer yourself with a sensible default. Make the call, say
  which default you chose, and carry on.
- anything you already asked that is still waiting. Use the same `dedupe_key` to
  restate it, never a second request.

## Ending your turn with a decision

If you are about to **end your turn by asking the human to choose**, call
`request_human_input` with the choices as `options`. Don't only write the
question in chat. That includes:

- "What should I focus on next?"
- a "Decisions for you", "Open questions" or "Next steps (pick one)" section
- "Should I commit / push / spawn the workers / proceed?"

Keep the chat text too (see "Always say it in chat too"). Make one request per distinct decision (up to the per-session limit, five unless the human changed it), or one
request with a free-text box when the questions are closely related. Use
`blocking: true` (the default), because you are ending your turn.

**Worked example.** An orchestrator finishes writing specs and is about to end
its turn with:

> Decisions for you: spawn WS-1 now? Commit the specs first?

Before ending the turn it makes two calls:

```
request_human_input({
  kind: "decision",
  title: "Commit the specs before spawning workers?",
  body: "The specs in docs/specs/ are uncommitted. Workers cut their worktrees from main, so they won't see uncommitted specs.\n\n**Recommendation:** commit first.",
  options: [{ id: "commit", label: "Commit first" }, { id: "skip", label: "Don't commit yet" }],
  dedupe_key: "commit-specs"
})
request_human_input({
  kind: "decision",
  title: "Spawn the WS-1 worker now?",
  body: "WS-1 has no dependencies and blocks WS-2..5.\n\n**Recommendation:** yes, right after the commit.",
  options: [{ id: "yes", label: "Spawn WS-1 now" }, { id: "wait", label: "Wait" }],
  dedupe_key: "spawn-ws1"
})
```

Then it writes the same two questions in chat and ends its turn.

## How to write a request

- **title:** one line naming the decision or action ("Migrate users in place or behind a copy?")
- **body:** markdown with the context the human needs to answer without opening your
  terminal, the trade-offs, and **your recommendation**
- **options:** 2-4 short labels when there is a choice. Every request accepts
  standalone text instead, or an optional note with a selected choice. Omit
  options for an open question.
- **allow_free_text:** deprecated and ignored; text replies are always allowed,
  including for existing requests saved with this flag set to `false`.
- **urgency:** `high` only when waiting is costly
- **dedupe_key:** a stable key of your own for this need. Asking again with it
  updates the open request in place instead of adding another.
- **blocking:** if `true` (the default), **end your turn right after the call**. If
  you can usefully keep working on something that doesn't depend on the answer,
  pass `blocking: false` and carry on.

## When the answer arrives

The answer arrives as a message that starts with `[Needs you]`:

```
[Needs you] The human answered your request "Spawn the WS-1 worker now?" (ibx_3f9a1c2b7d4e).
Choice: Spawn WS-1 now (yes)
Note: and tell it to commit often
```

Treat it as the human's answer to that request id, and continue. The `Choice`
or `Note` line is left out when the human gave none. A `Note` without a
`Choice` is a standalone human response: follow the actual text. The absence
of `Choice` alone signals neither approval nor rejection. Do not infer a
default option or approval from it; explicit text can approve, decline or
propose another approach.

## If you get the answer some other way

If the human answers in your terminal or chat instead, call
`withdraw_human_request({ id, reason })` straight away, so the queue doesn't keep
showing a question that is already settled. Do the same when the question goes
away on its own.

The `reason` is one short sentence, at most 200 characters, that the human sees
on the closed request. Say what settled it, for example:

- "User answered in chat"
- "Found the answer in the project docs"
- "No longer needed: the task was cancelled"
- "Replaced by a new request with more detail"

## When the human asks about a request

The human may ask you to explain a request, or ask a question about it. First
call `list_my_human_requests()`.

- **It is yours:** explain it in chat. If the explanation changes the question,
  call `request_human_input` again with the same `dedupe_key`, so the queue
  shows the new version.
- **It is not yours:** another session asked it, and that session has the
  context. Do not research it or answer it yourself: doing so fills your
  context with work that is not yours, and your answer can disagree with the
  session that asked. Tell the human that another session asked it, and that
  the session name at the top of the item opens the session that asked. Help
  only if they still want you to after that.

## After a restart or compaction

Call `list_my_human_requests()`. It returns your open and answered requests and
any closed in the last 24 hours, with the answer, so you can recover one you missed.

## When the tool refuses

- **"this session was launched by another session":** you are a worker. Your next
  step is `send_message` to the session that launched you (the refusal gives its
  id), with your question, its options and your recommendation. Do not call
  `request_human_input` again, and **do not ask the human in chat instead**: the
  human will not see it.
- **"The human has turned off direct requests from this session":** decide using
  your brief and sensible defaults, or stop and explain in chat what you need.
- **"Too many separate requests":** batch related questions into one request with options.
- **The open-request limit:** withdraw requests you no longer need, or wait for answers.

## If you launch sessions

Sessions you launch (with `spawn_session` or a workflow) can't ask the human.
Their questions come to **you** by mail.

- Answer what you can yourself.
- For anything only the human can decide, raise one `request_human_input`
  yourself, combining related questions from your workers.
- Never tell the human that a worker will ask them directly. Say that its
  questions come to you.
