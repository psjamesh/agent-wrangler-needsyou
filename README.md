# Needs you

"Needs you" is an extension for
[Agent Wrangler](https://github.com/PortSwigger/agent-wrangler). It keeps a
list of the decisions and actions your sessions need from you.

When many sessions run at once, some of them stop and wait for you. A session
can wait on a permission prompt, a sign-in or a trust dialog. An agent can
also reach a choice it cannot make alone. "Needs you" shows only these, one
item for each need. You work through the list one item at a time. Your answer
goes straight back to the session, so you do not have to open its terminal.

An item closes by itself when the need goes away, so the list is usually
empty. Progress updates, finished sessions, messages between sessions and
other news never appear in it.

![The Needs you view: the list of waiting requests on the left, and the selected decision on the right with its context, its options and a note field](docs/notes/needs-you.png)

## Install the extension

You need Agent Wrangler with host API `^1.57.0`. The current `main` has it.

The repository is private for now. Agent Wrangler gets it with `git` and
cannot ask you for a password. If the repository is private, do these steps
first:

1. Run `gh auth login` in a terminal.
2. Run `gh auth setup-git`.

Then install the extension:

1. Open **Settings**.
2. Select **Extensions**.
3. Select **+ Add extension**.
4. Select **Git URL**.
5. Paste `https://github.com/portswigger-tim/agent-wrangler-needsyou.git`.
6. Read the capabilities list. It shows four capabilities (see the table below).
7. Approve the install.
8. If Agent Wrangler asks you to restart it, restart it.

The **Needs you** button (a person silhouette) shows on the left rail. It has
a badge that counts the items that need you. A session card with items shows
a small chip with the same silhouette and the number of items. Select the chip
to open the first one. **Needs you** also shows in **Settings → Extensions**,
with five settings.

The extension asks for these capabilities:

| Capability | What the extension uses it for |
| --- | --- |
| `sessions:read` | To show session names, and to find which session started another one |
| `tasks:read` | To show the task name next to an item |
| `deliver` | To put your answer into the prompt of the session that asked |
| `board:rebuild` | To update the board when the list changes |

## What appears in "Needs you"

There are two types of item.

| Type | When it appears | Kind | When it closes |
| --- | --- | --- | --- |
| **Agent request** | An agent asks you with the `request_human_input` tool | Decision, approval, question or action | You answer and the session gets the answer. The agent withdraws it (it does this when you answer in the session instead). The session is archived. It expires. Or you dismiss it |
| **Session status** | A session stops on something only you can do: a permission prompt, a trust dialog, a sign-in or an API error that blocks it | Blocked | The session starts again. The session is archived. Or you dismiss it |

These do not appear, unless you change a setting:

- An API error that the session will retry by itself. The **Include API
  errors** setting adds these.
- A session that is still working but shows a note, such as "starting
  container".

Each need appears once. It does not appear again when you reload the page,
restart Agent Wrangler or open a second tab. If an agent asks the same thing
again, its earlier request changes. A second item does not appear.

A message you send in the session does not close an agent request. If it
answers the request, the agent withdraws the request. If the agent does not,
dismiss it.

Deliberately opening an open permission prompt shows the session's terminal
in the detail pane, where you can allow or deny it. The first item previewed on
a desktop, and the next preview after an item closes, wait for you to open them.
**Hide terminal** keeps it hidden for that selection; selecting another permission prompt opens its terminal
by default. Other session statuses offer **Show terminal here**. **Open session**
is always available, including when embedding is unavailable or the session is
no longer running. Opening the embedded session acknowledges its alert and clears
its snooze, just like opening the session. It never answers a prompt or resumes
a dormant session automatically. The automatic terminal restores your saved tab
when closed; manual **Show terminal here** and **Open session** remember Terminal.
Switching Chat → Terminal inside the automatic embed can still restore your
earlier saved tab when closed. Keyboard focus stays put on the initial automatic mount; the host can focus the
terminal again if it reconnects.

Every agent request lets you answer in your own words instead of selecting
an offered option. You can also add an optional note to your choice. Click
the selected option again to deselect it while keeping your draft.

## How to work through the list

Use these keys in the **Needs you** view:

| Key | What it does |
| --- | --- |
| `n` | Go to the first open item in your chosen grouping and order. If you are on it already, go to the second item |
| `j` or `↓` | Go down the list |
| `k` or `↑` | Go up the list |
| `1` to `6` | Choose an option. Then press `Enter` to send it |
| `Enter` | Open the selected item |
| `⌘ Enter` or `Ctrl Enter` | Send, when you type a note |
| `Esc` | Leave the note, or close the item |
| `e` | Dismiss the item. For an agent request, you confirm first |

Sometimes a session cannot accept your answer, for example because it is
archived. Then the item stays in the list and shows **Retry**.

Use the buttons at the top of the list to choose what it shows:

- **Open** shows what needs you now. This is where the list starts.
- **Closed** shows items that closed in the last 24 hours, with the most
  recently closed first by default.
- **All** shows open items, then closed items by default.

Use **Group** to choose **None**, **Task** or **Type**, and **Sort** to choose
**Recommended**, **Type** or **Time waiting**. **Asc** and **Desc** set the direction
for Type and Time waiting. Ascending time waiting puts the shortest wait first;
descending puts the longest first. Sorting matches the displayed age: request
creation for open items, answer time for failed deliveries, and closure time
for closed items (answer time while sending).

Groups are alphabetic; sorting applies within each group. Type uses the label
shown on the item, such as Permission, Sign-in or Decision. Task follows the
session's current task, with **No task** when task metadata is unavailable.
Distinct tasks stay separate even if their names match. Controls apply to the
chosen Open, Closed or All list. Recommended keeps the existing priority for
open items and the most recently closed first for closed items.

The filter, grouping, sort and direction are remembered in this browser,
including after a page reload or Agent Wrangler restart. They are specific to
this browser and board address. If browser storage is unavailable, you can still
change them for the current view.

Select a closed item to see what was asked, what you chose and how it closed.
You cannot change a closed item.

To close the item on the right, select **×** in its top-right corner or press
`Esc`.

## Which sessions can ask you

A session that you started can ask you directly.

A session that another session started cannot ask you directly. This stops
helper sessions from filling your list. When one tries, the tool refuses and
gives it the name of the session that started it. The helper then sends its
question to that session instead.

You can change this for any session from the menu on its card. Select
**Let it ask you directly** to turn it on or off. A tick (✓) beside it means
the session can ask you now.

An agent cannot change this setting.

Agents learn how to ask from the `needs-you` skill that comes with the extension.
Your answer arrives in the agent's prompt as a message that starts with
`[Needs you]`.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Include API errors | Off | Adds an item when a session waits on an API error that it will retry |
| Open requests per session | 5 | The number of unanswered requests one session can have at the same time (1 to 20) |
| Keep resolved items (days) | 7 | The number of days to keep closed items (1 to 90) |
| Toast notifications | Off | Shows a toast for each new Needs you item, with a **View request** shortcut |
| New requests per ten minutes | 3 | New requests each session may create in a sliding ten-minute window (0 to 100); 0 turns off the rate limit |

The request rate limit counts only newly created agent requests. Updating an open
request with the same dedupe key and refused calls do not count. Set **New requests
per ten minutes** to **0** to disable it; **Open requests per session** still limits
unanswered requests. Changes apply to the next call without restarting. Requests
created while the limit is off still count if you turn it back on within ten minutes.
The rate history is held in memory and resets when the extension restarts.

Toast notifications use the same stack as scheduled-session notifications.
They show the request title and session context. **View request** opens the
item; closing the toast leaves the request unchanged. A toast is withdrawn
when the item no longer needs action or you turn the setting off.

Opening or reconnecting a board tab, or turning the setting on, does not
replay items already in the queue. Disabling withdraws outstanding notifications
on the next board update, usually within a few seconds.

## Session status items need an open board tab

Agent Wrangler does not tell extensions the status of a session. Only the
board in your browser knows it. So each open board tab checks the sessions and
tells the extension.

**If no board tab is open, no session status items appear.** When you open a
tab, the list updates immediately.

Agent requests do not need an open tab. They appear at all times.

## Where your data is kept

The extension keeps its items, your answers and your per-session settings in
one file on this computer: `~/.agent-wrangler/inbox.json`. If you set
`AW_DATA_DIR`, the file is in that folder instead. The extension sends nothing
to any other place.

Closed items are deleted after the number of days in **Keep resolved items**.

**The file stays when you uninstall the extension.** Delete it yourself if you
do not want to keep it.

## Only install extensions you trust

**Extensions run inside the Agent Wrangler server with full access to your
computer.** The capabilities list tells you what the extension uses from Agent
Wrangler. It is not a sandbox and it does not limit the extension. Any
extension can read and change your files and run programs as you. Install only
code that you trust, and check each update before you approve it.

## Develop the extension

You need Node 22 or later and [pre-commit](https://pre-commit.com/).

1. Run `npm ci --ignore-scripts` in an agent-wrangler checkout.
2. Run `npm ci` in this repository.
3. Run `pre-commit install`. This installs the verification gate.
4. Run `npm test`.
5. Run `AW_REPO=<agent-wrangler checkout> node scripts/validate-manifest.mjs`.
6. Run `AW_REPO=<agent-wrangler checkout> scripts/boot-smoke.sh`.

The verification gate runs when you commit, merge and push. It checks for
secrets, local file paths, a stale lockfile, lint errors and failing tests.
GitHub runs the same checks on every push. If a check fails, fix the cause.
Do not use `--no-verify`.

What each check does:

- `npm test` runs the server and browser tests. They do not touch
  `~/.agent-wrangler`.
- `validate-manifest.mjs` loads this repository with Agent Wrangler's real
  extension loader. It also calls the tools through Agent Wrangler's real MCP
  server (the server that agents call tools through).
- `boot-smoke.sh` starts a temporary Agent Wrangler with a copy of this
  repository. It uses a temporary data folder, a temporary home folder and a
  free port. Then it tests every flow, as a board tab and an agent would. It
  does not start a session.

[`AGENTS.md`](AGENTS.md) lists the rules and traps for changing the code.
[`docs/notes/`](docs/notes/) has design notes and the
[manual test checklist](docs/notes/testing.md). The design is in
[`docs/specs/`](docs/specs/).

## Licence

MIT. See [`LICENSE`](LICENSE).
