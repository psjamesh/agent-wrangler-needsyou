# The "Needs you" view (WS-4)

The non-obvious decisions behind `public/index.js`, `public/inbox-*.js`,
`public/icons.js` and `public/styles.css`.

## Queue order and states

- Tiers (0.1.2, F4): every status item **and** every high-urgency agent request
  are tier 0, oldest first. So an urgent request raised after older status
  items sorts below them, but above every other request. Then come normal
  blocking requests, then non-blocking ones, then failed deliveries.
- An urgent request shows an **Urgent** tag on its row and in its detail, and
  the card pill takes the warning colour while its session has one open.
- At desktop width (two panes), the view selects the first item of the list on
  screen when nothing is selected (0.1.2, F5). The auto-picked item is not
  marked read until you act on it. At phone width the list shows first.
- The detail's × (two panes only) and `Esc` clear the selection (0.1.4, C1).
  Auto-select then stays off until the human picks a row, presses `n`, or an
  item id never seen before arrives open. A failed delivery of an item already
  seen does not count as new. At one pane there is no ×, and `Esc` is Back.
- The header count reads "N open" and is hidden at 0 (0.1.4, C3).
- There is no **Next** button (0.1.3, at the human's request). With the first
  item auto-selected and answering or dismissing moving on by itself, it added
  nothing on a desktop. The `n` key stays.
- An answer still being delivered leaves the queue and shows as "sending"
  under **Closed**. A failed delivery comes back as the last tier of
  the queue, with **Retry**.
- "Unread" decides only the row dot, never the order or the badge.

## Keyboard and focus

- Number keys pick an option and focus **Send**, so `Enter` sends. `n` jumps to
  the **top** item of the queue, not to the item below the selection. On the
  top item it moves to the second. On an auto-picked first item it opens that
  item first.
- Keys are scoped to the view and stop propagating, so the board's own
  shortcuts don't fire while you work the queue.
- A MutationObserver focuses the view when it's shown. That is also when a
  pending selection (from a card pill) lands, and when items are
  marked read: an item counts as read once it has been on screen.

## Status items (0.1.2)

- The label, icon and colour come from `status.cause`, which reconcile sets
  (F1): Permission, Question, Trust, Sign-in, Restart, Waiting, and **Blocked**
  for a container failure or a blocking API error (a transient one says
  Error). Only those two causes are red. An item without a cause shows as
  Waiting.
- The detail gives one sentence saying what to do, chosen by cause (F2). Under
  it, "From the terminal" shows the terminal text once. Reconcile leaves the
  body empty when the text is only core's phrase (`permission prompt`, `input
  needed`, `trust dialog`), so there is no box then. The body is
  markdown-escaped by reconcile, so it goes through `api.ui.markdownPreview`.
  `white-space: pre-wrap` sits on the paragraph, not the box, or the newline
  after `</p>` shows as a blank line.
- An open status item opens its session on the **Terminal** tab (0.1.7):
  **Open session**, the session link and **Show terminal here** all do. The
  host API can't choose a tab (`openSession` takes an id, `mountSession` only
  `view: 'diff'`), so `public/inbox-session-view.js` first writes the board's
  own per-session choice, `localStorage['cm-session-view'][sid] = 'terminal'`.
  That key is core's, not a contract: if it changes, the session opens on its
  remembered tab. Manual Open/Show choices stay after the prompt is answered;
  the automatic embed holds a temporary preference until it closes.
  Replace this with a `view: 'terminal'` option once the host API has one.
  Agent requests and closed items open on the remembered tab.

## Answering

- The text box is full width with a visible label (F6): "Your answer" for an
  open question, "Your answer, or a note with your choice" when there are
  options. There is a 12 px gap before the box and before the button row.
  **Send** enables for a valid option or nonempty text on every agent request,
  including saved requests with `allowFreeText: false`. Cmd/Ctrl+Enter follows
  the same rule. **Clear** clears the selected option, keeps the draft
  and focuses the answer field. Typing alone keeps the choice. Drafts and
  choices survive graph ticks and detail re-renders.
- An `action` request with no options has a main **Done** button (F9). It sends
  `done`, or `done` plus the note. **Send** stays as a secondary button.
- A non-blocking request says "The agent is still working." under its header.
- A failed delivery names the session (F3). If the session is archived
  (`graph.history`, a session marked archived, or "archived" in the error), the
  text says to restore it then retry, or dismiss, and **Dismiss** is the main
  button. The row says "answered <age> ago", and the "Not delivered" tag is a
  tinted danger chip (contrast 6.9 Dark, 5.9 Light).

## Dismissing

An agent request asks you to confirm inline, since dismissing means the agent
never gets an answer. A status item dismisses at once: it comes back on the
session's next `needs-you` episode anyway.

## Toast notifications

The **Toast notifications** setting is off unless `toastNotifications === true`.
The client uses `api.ui.notify` for each newly seen open item, with its title,
session context and a **View request** action. The action uses the same
`openItem` navigation and pending selection as a card pill. Closing a toast
changes neither the request nor its read state.

`inbox-toasts.js` seeds the first valid inbox snapshot silently and remembers
all seen ids, including while disabled. Reconnects, restatements, repeated
view/card updates and enabling the setting do not replay existing items.
An outstanding toast is withdrawn when the item no longer needs action or
the setting is disabled. Same-tab settings changes may not emit a callback, so
the next graph update also withdraws disabled toasts, usually within a few
seconds. `api.settings.onChange` withdraws toasts when the host emits a change.
A withdrawn toast's pending action cannot navigate later.

The setting uses a separate key from the historical `notifyToasts` value so
saved configuration cannot opt anyone in. Error toasts from the control router
remain the board's own.

## Icon and card chip

- The rail button and the card pill use one person-silhouette SVG
  (`ICONS.inbox`), in the board's icon style (24 × 24, stroke `currentColor`).
  There is no emoji anywhere in `public/` (a test checks).
- The pill is `<button class="card-tag ibx-pill">`. `card-tag` is core's chip
  class (`public/cards.js` on agent-wrangler main, checked 2026-11-03), so the
  pill takes the size, padding, colours and the 10 px icon size of the other
  chips in every theme. `ibx-pill` adds only the pointer cursor and the
  slightly stronger fill that core's own button chips (`.subagent-pill`, the
  checklist pill) use, because `--surface-2` barely shows on a dark card.
- The icon is 10 px, not the 12 to 14 px the fixes spec suggested, because core's
  `.card-tag svg` rule sizes every chip icon to 10 px. Matching the other chips
  was the stated aim.

## Layout

- The narrow layout uses a container query on `.ibx-root` (< 900 px), not a
  media query, so it follows the view's width.
- Selecting an open permission-status item automatically embeds its live session's
  terminal (`api.mountSession`) only after deliberate opening: selecting a row,
  opening with the keyboard or following **View request**. A desktop first-item
  preview and the next preview after resolution never mount. It uses the
  semantic `status.cause === 'permission'`, regardless of provider or title.
  Other statuses keep the **Show terminal here** toggle; agent approval requests
  and read-only items do not automatically embed.
- Only a visible detail mounts: the phone list, a hidden view and an unmounted
  view never acquire the host's single embedded panel. Changing selection,
  closing detail, resolving/removing the item or hiding the view releases it.
  Returning to a visible detail can mount again. **Hide terminal** persists
  through graph updates and view changes for the same selection; a new selection
  gets the default again when deliberately opened. Graph restatements do not
  remount or move focus.
- Automatic mounts require the session to be present, managed and not archived
  in the core graph: the host resumes dormant sessions when mounting them.
  Opening an embed runs the host's session selection path, acknowledging its
  alert and clearing its snooze; this is why automatic previews never mount.
  It sends no approval or terminal input.
- An automatic embed temporarily sets the session to Terminal while mounted,
  because the host re-reads that preference on graph updates. Release, mount
  failure and pagehide restore the prior preference. Other sessions' edits and
  a human's change to Chat are preserved. Manual **Open session** and **Show
  terminal here** keep their existing permanent Terminal choice. The temporary
  value cannot be distinguished from a later Chat → Terminal choice inside
  the embed, so that sequence can still restore the earlier saved tab on release.
- The view restores keyboard focus immediately after an automatic mount.
  The host can focus the terminal later on a pty socket reconnect (its delayed
  `openTerminal` retry) or a graph reattach after restart. The embed API has no
  focus-control option. The extension leaves later focus alone so deliberate
  terminal interaction works normally.
- Missing, null or throwing embed support leaves **Open session** available.
  A failed automatic mount is not retried by graph or visibility updates for
  that selection; **Show terminal here** allows an explicit retry.
- Colour comes only from the board's CSS variables, so both themes work.

## Filters and the read-only view

- **Open (n) · Closed (n) · All (n)** (0.1.4, C2) replaced the "Recently resolved"
  strip. One listbox (`.ibx-queue`) shows the chosen list, and its aria-label
  follows the filter. The choice is kept in `localStorage` (`needsyou.filter`),
  inside try/catch, and an unknown value falls back to Open.
- **Closed** is sorted by when each item closed, newest first (the human's
  rule): `closedAt` is `updatedAt`, which the store sets on close and never
  changes afterwards, or `answer.at` for an answer still sending. **All** is
  Open then Closed, with a hairline between them.
- Closed rows show the reason and "closed 5m ago" (or "sending"). At 375 px
  the reason is hidden in rows to keep room for the title.
- `n` always means the top **open** item: from Closed or All it switches to
  Open. Selecting an item the current filter hides (a card pill while Closed
  shows) switches to a filter that has it.
- Selecting one opens it in the detail pane read-only (0.1.1, F15): kind,
  title, session and task, the body (sanitised markdown), the options with the
  chosen one marked, the note, the `waitingFor` text for a status item, and how
  and when it closed (reason label, a `<time>` with the absolute local time,
  and a relative age the tick keeps moving). It has no buttons (0.1.2, F11, at
  the human's request): the header's session link opens the session, and the
  list is beside it. `Enter` focuses that link. `e` and the number keys do
  nothing there.
- "Read-only" is anything resolved, or answered and still sending. A failed
  delivery is back in the queue with **Retry**.
- `j`/`k` walk the list on screen. A resolved item stays selected across
  ticks. A queued item that
  leaves the queue still moves the selection on, as before.

## Card menu and spawner names

- A spawner's name comes from `graph.inbox.sessions`, which lists every
  listed session's spawner (0.1.1). It falls back to `graph.sessions`, then
  to a short id.
- The card menu has one "can ask" item on every listed card, with the
  silhouette icon (core sizes it to 15 px, like its own items). Since 0.1.4
  (C5) it is a tick toggle at the human's request: the fixed label **Let it
  ask you directly**, with a text `✓` hint when the effective `canAsk` is true.
  Core draws its own ticks with an SVG, which an extension's `hint` cannot
  carry (it is escaped text), so this tick is a little lighter. The click
  flips the state: spawned → `true`, spawned and allowed → `null`, top-level
  → `false`, top-level and refused → `null`. Clearing the override is always
  the way back, so there is no **Use default**.
- The session link falls back to the core card's `label` (then `name`, then
  the short id), clipped at 60 characters (0.1.4, C4).

## Test fixtures

The client suites' fixtures are in `test/fixtures/inbox.js`, outside
`public/`, because the wrangler serves everything in `public/` under
`/ext/needsyou/`. Moved there in 0.1.1. The boot smoke checks that
`/ext/needsyou/inbox-fixtures.js` returns 404.
