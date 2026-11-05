# Changelog

## 0.1.11

### Added

- **Optional notes on every choice answer.** Add a note alongside any selected
  option, including requests that require a fixed choice. A note alone still
  requires the agent to allow a free-text answer.

## 0.1.10

### Added

- **Optional toast notifications.** Enable **Toast notifications** to show new
  requests in the board notification stack with a **View request** shortcut.
  The setting is off by default. Existing requests are not replayed, and
  closing a notification leaves its request unchanged.

## 0.1.9

### Changed

- **The "Let it ask you directly" tick matches the board's.** In the card
  menu it is now the same check, in the same size and colour, as the tick on
  **Auto-fix PR checks**, not a small grey character.

## 0.1.8

### Fixed

- **A reply in the session no longer closes a request** (#1). An agent
  request used to close as "answered in the session" as soon as its session
  started work again, even when your message didn't answer it (a question
  about it, or "wait"). The decision was then lost. Now a request stays open
  until you answer it in the list, or the agent withdraws it after you answer
  in chat, or you dismiss it.

### Removed

- The **Close when the session moves on** setting, which turned that rule on.

## 0.1.7

### Changed

- **A blocked session opens on its Terminal.** For an item that waits on the
  terminal (a permission prompt, a trust dialog, a sign-in), **Open session**,
  the session link and **Show terminal here** now open the Terminal tab, not
  Chat. The session keeps that tab afterwards.

## 0.1.6

### Changed

- **Questions go to the session that asked.** When you ask a session about a
  "Needs you" request it did not raise, the nudge and the skill tell it
  not to research it, and to point you to the session that asked. This keeps
  one session's work out of another's context. A request that is its own, it
  explains in chat, and it updates the request if the question changes.
- **No "it's in your Needs you queue" lines.** The tool's reply, its
  description, the nudge and the skill tell agents to ask in chat without
  saying the request is also in the queue.
- **The skill is now `needs-you`** (was `inbox`), matching the name you see.
  Agents load it as `needs-you:needs-you`.

## 0.1.5

### Changed

- **All shows a count**, like Open and Closed: "All (12)" is open plus closed.

## 0.1.4

From the human's last round of ideas (`docs/specs/fixes-0.1.4.md`).

### Changed

- **Close the detail (C1).** An × in the detail's top right, and `Esc`, close
  it. It stays closed until you pick an item, press `n`, or a new item arrives.
- **Open · Closed · All (C2)** replace "Recently resolved". Closed lists the
  most recently closed first.
- **"3 open" (C3)** in the header, matching the Open filter.
- **Session names (C4).** The session link shows the card's name, not a short
  id.
- **Card menu (C5).** One tick toggle: **Let it ask you directly ✓**.
- **Said in chat too (C6).** Agents are told to write every request in their
  reply as well, and to withdraw it if you answer in chat.

## 0.1.3

### Changed

- **No Next button.** The queue opens on its first item, and answering or
  dismissing moves on by itself, so the header button added nothing. The `n`
  key stays: it jumps to the top item (the second, if you are on the top one).

## 0.1.2

Fixes from the e2e screenshot walk-through and the human's review of it
(`docs/specs/fixes-0.1.2.md`). Same host API (`^1.57.0`) and capabilities.

### Changed

- **Status items say what they are (F1).** Each has a `status.cause`
  (permission, question, trust, sign-in, update, container, api-error, other).
  The queue labels it Permission, Question, Trust, Sign-in, Restart or Waiting.
  Only a container failure or an API error reads Blocked, in red.
- **Status items say what to do (F2).** One sentence per cause, then the
  terminal text once, under "From the terminal". Core's bare phrases are no
  longer repeated.
- **Failed deliveries (F3).** A readable tag, the session's name, and, for an
  archived session, Dismiss as the main button. The row says when you
  answered.
- **Urgent requests (F4)** show an Urgent tag, colour the card pill, and sort
  with the status items.
- **The queue opens on its first item (F5)** at desktop width.
- **Answer box (F6).** Full width, labelled, with room above Send.
- **Card menu (F7).** One "can ask" item with an icon, on every card. Its label
  says what the click does, and its hint the current state. "Use default" is
  gone.
- **Next is disabled (F8)** when nothing is waiting.
- **Done button (F9)** for action requests. Non-blocking requests say the agent
  is still working.
- **Resolved items have no buttons (F11).**
- The rail icon is sized like core's rail icons.

### Added

- `e2e/`: a screenshot walk-through of every interruption type in headless
  Chromium. It also regenerates the README screenshot.

## 0.1.1

Fixes from the first live tests on a real board (`docs/specs/fixes-0.1.1.md`).
Same host API (`^1.57.0`) and capabilities.

### Changed

- **Routing for spawned sessions (F10, F11, F12).** The refusal a spawned
  session gets is now one explicit next step: call `send_message` to the
  spawner now, don't call `request_human_input` again, and the human won't see
  a question written in chat. The tool description says the same. The skill
  nudge opens with the end-of-turn trigger, and tells spawners that their
  workers' questions come to them by mail and must not be promised to the
  human.
- **No toasts (F14).** The toast notifications and the **Notify when a session
  is stopped** setting are gone; there are four settings. An old value left in
  config.json is ignored.
- **Read-only resolved items (F15).** A row in **Recently resolved** has the
  queue row's layout and opens read-only: body, options with the choice
  marked, the note, the `waitingFor` text, and how and when it closed. `j`/`k`
  move into the strip while it is expanded.
- **Icon and card chip (F16).** A person silhouette replaces the inbox icon.
  The card pill drops its emoji and is a core `card-tag` chip, so it matches
  the other card chips in every theme.
- **Clearer blocked titles (F1).** "permission prompt" and "input needed"
  become "Permission needed in the session" and "Question waiting in the
  session".
- **Card menu (F3).** `graph.inbox.sessions` entries carry `canAskOverride`.
  The menu says "default" only when there is no override, and offers **Use
  default** when there is one.
- **Spawner names (F4).** Each listed session's spawner is in
  `graph.inbox.sessions`, so "spawned by X" shows X's name.

### Fixed

- The startup retention run now runs once per activation (a disable and
  enable runs it again), not once per process (F8).
- The client test fixtures moved from `public/` to `test/fixtures/`, so they
  are no longer served under `/ext/needsyou/` (F7).

### Docs

- `AskUserQuestion` is confirmed to show as `needs-you` (`waitingFor` "input
  needed", 2026-11-03) (F2).
- The restart gap in "answered elsewhere" is stated in the README and the
  notes (F5).
- `AGENTS.md` states the wrangler's real import rule (F6).
- The compliance eval must use board-launched sessions, and a separate
  routing eval checks that workers mail their spawner (F13).

## 0.1.0 (unreleased)

The first release, for Agent Wrangler host API `^1.57.0`. It asks for
`sessions:read`, `tasks:read`, `deliver` and `board:rebuild`.

### Added

- **The "Needs you" view:** a triage queue with a rail badge, worked one item
  at a time with **Next** and the keyboard. A new item that stops a session
  (a blocked session or a blocking request) gets a toast, at most three at
  once, withdrawn once it is read or closes. A card pill counts a session's
  items and opens the first.
- **Agent requests:** the `request_human_input`, `withdraw_human_request` and
  `list_my_human_requests` MCP tools, and the `inbox` skill with its wrangler
  nudge. Requests can carry options, a free-text answer, blocking or not,
  urgency, a `dedupe_key` that updates in place, and an expiry. Answers are
  delivered into the session's prompt as `[Needs you] …`. A failed delivery
  stays in the queue with **Retry**.
- **Status items:** one `blocked` item per `needs-you` episode, detected by the
  open board tabs and reconciled server-side, so several tabs give one item.
  Each closes itself when the session moves on. Transient API errors are left
  out unless **Include API errors** is on.
- **Who may ask:** sessions spawned by another session are refused and pointed
  at their spawner. The human can allow or disallow any session from its card
  menu.
- **Lifecycle:** items close when their session is archived, and are forgotten
  when it is purged. Expired requests close every minute. Resolved items are
  removed after **Keep resolved items** days (default 7).
- **Settings:** toasts, API errors, open requests per session, retention, and
  closing a blocking request when the session moves on.
- **Release tooling:** `scripts/validate-manifest.mjs` (the wrangler's real
  loader and MCP server), `scripts/boot-smoke.sh` and `scripts/dev-smoke.mjs`
  (a throwaway wrangler, driven end to end), and CI running both against
  agent-wrangler `main`.

### Known limits

- Status items appear only while a board tab is open
  ([README](README.md#limitation-status-items-need-a-board-tab-open)).
- `needs-you` prompts are answered in the terminal, not from the queue.
- After a server restart, a blocking request is closed as answered elsewhere
  only once its session has been seen idle and then working again
  ([notes](docs/notes/passive-signals.md)).
