# Test the extension

This page has two parts:

- **Automated checks.** CI runs them on every push. You can run them on your
  computer too. They do not need a real session.
- **Manual checks.** These need real Claude and Codex sessions on a board, so
  a person must do them. Do them before the first release, and record the
  results in the tables.

## Automated checks

### What the automated checks cover

| Check | What it proves |
| --- | --- |
| `npm test` | The server and browser code, with a fake Agent Wrangler (187 tests at 0.1.0) |
| `scripts/validate-manifest.mjs` | Agent Wrangler's real loader accepts the extension and does not quarantine it (block it from loading). It registers the 3 tools, the 6 message handlers, the `needs-you` skill, the 4 settings, the 3 sweeps (timed jobs) and the client files. The tools work through Agent Wrangler's real MCP server: the tool list, one valid call, one invalid call and a refused helper session |
| `scripts/boot-smoke.sh` | A real, temporary Agent Wrangler loads the extension. `scripts/dev-smoke.mjs` then tests every flow over the board's connection and `/mcp`, as a browser tab and an agent would |

`dev-smoke.mjs` checks these flows:

- The extension is enabled and not quarantined. Its client files load.
- A valid `request_human_input` call adds an item to `graph.inbox`. An invalid
  call and a call with no session are refused.
- An `inbox-observe` message with a `needs-you` session adds one blocked item.
  The same message sent again does not add a second item. The session going
  `idle` closes the item.
- `inbox-mark-read` lowers the unread count.
- A helper session (one that another session started) is refused, and the
  refusal names the session that started it. After `inbox-set-can-ask`, the
  same call succeeds. `allowed: null` sets the default again.
- `inbox-answer` preserves both an option with an optional note and a standalone
  text answer, including when `allow_free_text` is false, and reaches
  `host.deliver`. The smoke test sends answers only to an archived card, which
  refuses them. So no session starts. The items stay answered with failed
  deliveries. `inbox-retry` fails the same way and counts the attempt.
  `inbox.json` preserves the standalone text answer without an option.
- `inbox-dismiss` and `withdraw_human_request` close items. A session cannot
  withdraw a request from a different session.
- `inbox.json` in the data folder holds the items.

### Run the automated checks

1. Get an agent-wrangler checkout: `gh repo clone PortSwigger/agent-wrangler -- --depth 1`.
2. In the agent-wrangler checkout, run `npm ci --ignore-scripts`.
3. In this repository, run `npm ci`.
4. Run `npm test`.
5. Run `AW_REPO=<agent-wrangler checkout> node scripts/validate-manifest.mjs`.
6. Run `AW_REPO=<agent-wrangler checkout> scripts/boot-smoke.sh`.

Each command ends with exit code 0. `validate-manifest.mjs` shows a `✓` on each
line. `boot-smoke.sh` ends with `dev-smoke: all expectations met`.

`boot-smoke.sh` does not touch your own Agent Wrangler. It uses a new
temporary data folder, a temporary home folder and a free port, and it deletes
them at the end. To keep the folder for debugging, set `AW_SMOKE_KEEP=1`.

### Screenshot walk-through (e2e)

`e2e/` takes a screenshot of every interruption type in a real browser, so you
can judge the layout, the wording and the flow. It has its own `package.json`,
so Playwright is never installed with the extension.

What it covers:
- the empty queue
- each status need: permission prompt, `AskUserQuestion`, folder trust,
  sign-in, agent update, container failure and a blocking API error
- each agent request kind: decision, approval, question and action
- the refused worker, and the card menu that allows it to ask
- the queue, and the detail of every item
- a choice with a note, the dismiss confirmation and the `n` key
- a failed delivery, then needs that clear on their own and the read-only
  resolved view
- the Light theme and a 375 px width

To get the status needs, it rewrites the graph frames that the browser receives.
The real observer, reconcile and view then run unchanged. It never clicks a card
or **Open session**, and it answers only an archived card, so it does not start
an agent.

1. In `e2e/`, run `npm ci --ignore-scripts`. It uses Playwright's cached
   Chromium. If you do not have it, run `npx playwright-core install chromium`.
2. Run `AW_REPO=<agent-wrangler checkout> e2e/run.sh`.
3. Open `e2e/screens/`. `INDEX.txt` says what each screenshot shows.

The run also writes `readme.png`, the README's screenshot. To replace
`docs/notes/needs-you.png` with it, run `E2E_README=1 AW_REPO=<agent-wrangler
checkout> e2e/run.sh`. Do this when the view changes.

The script ends with exit code 0 when every expectation is met. To look at the
board yourself, set `E2E_SERVE=1`. The script then prints the board URL and
waits.

## Manual checks

### Before you start

**Caution:** do not use your own board for the manual checks. Use a separate
data folder, so the tests do not change your sessions or settings.

**Caution:** these checks start real sessions. They use your Claude and Codex
accounts.

You need:

- an agent-wrangler checkout on `main`, with `npm ci` done
- Claude Code and Codex, both signed in
- a test repository that you can change and delete, for example a new folder
  with a `README.md` and `git init`

### Check 1: Install from the Git URL

This check proves that a new install works and that the consent dialog shows
the 4 capabilities.

1. Start a development Agent Wrangler with an empty data folder and a free
   port, for example:
   `AW_DEV=1 AW_DATA_DIR=/tmp/needsyou-manual AW_PORT=4999 node <agent-wrangler checkout>/server/index.js`.
2. Open `http://localhost:4999` in a browser.
3. If the repository is private, make sure that `gh auth setup-git` is done.
4. Open **Settings**.
5. Select **Extensions**.
6. Select **+ Add extension**.
7. Select **Git URL**.
8. Paste `https://github.com/portswigger-tim/agent-wrangler-needsyou.git`.
9. Look at the consent dialog.

The dialog shows exactly 4 capabilities: `sessions:read`, `tasks:read`,
`deliver` and `board:rebuild`.

10. Approve the install.
11. If Agent Wrangler asks you to restart it, restart it.
12. Open **Settings → Extensions → Needs you**.

"Needs you" is enabled and has 4 settings. The **Needs you** button shows on
the left rail.

Keep this Agent Wrangler running for the next checks.

### Check 2: End-to-end flow

This check proves that the two types of item open and close correctly.

1. From the board, start Claude session A in the test repository, in the
   default permission mode. Give it this prompt: "Create a file named
   `hello.txt` that contains `hi`."

Session A stops on a permission prompt. Do not approve it yet.
2. From the board, start Claude session B in the test repository. Give it this
   prompt: "Decide between a JSON or a YAML config file for this repo. Ask me
   to choose with request_human_input before you write anything."
3. From the board, start Claude session C (the orchestrator). Give it this
   prompt: "Spawn one worker session with spawn_session. Tell the worker to ask
   the human whether to use tabs or spaces, and to end its turn."
4. Wait 10 seconds.

The **Needs you** list shows:

- a **Blocked** item for session A, titled from its permission prompt
- a **Decision** item for session B, with options
- no item for the worker

Session C gets mail from the worker with the tabs-or-spaces question. Its
terminal shows the mail.

5. Look at the badge on the **Needs you** button.

The badge shows 2. If session C asks you the worker's question with
`request_human_input`, the badge shows 3. That is also correct.
6. Open the **Needs you** view.
7. Select the decision for session B.
8. Choose an option and select **Send**.

Session B's terminal shows a message that starts with `[Needs you]`. The
decision leaves the list.

9. Open session A's terminal.
10. Approve the permission prompt in the terminal.
11. Wait 5 seconds.

The blocked item for session A closes.

12. If session C asked you a question, answer it in **Needs you**.

The badge shows 0.

### Check 3: Two tabs give one item

1. Open the board in two browser tabs.
2. Start a session that stops on a permission prompt (as in check 2, step 1).
3. Wait 10 seconds.

The list shows one blocked item for that session, not two. The badge
counts it once.

4. Approve the permission prompt in the terminal.

The item closes in both tabs.

### Check 4: A trust dialog

1. Make a new folder that Claude Code has not opened before.
2. From the board, start a Claude session in that folder.
3. Wait 5 seconds.

The list shows a blocked item titled "Confirm folder trust".

4. Accept the trust dialog in the terminal.

The item closes.

### AskUserQuestion (WS-3)

This check confirms that Claude Code's `AskUserQuestion` prompt puts the
session into `needs-you`. It passed on a live board on 2026-11-03: `status` was
`needs-you`, `waitingFor` was "input needed", and a Blocked item showed in
about 5 seconds. Repeat it after a Claude Code upgrade.

1. From the board, start a Claude session. Give it this prompt: "Use the
   AskUserQuestion tool to ask me whether to use tabs or spaces. Do not use any
   other tool."
2. Wait until the question shows in the terminal.
3. Wait 10 seconds.
4. Open the browser developer tools.
5. Select **Network**, then **WS**, then the `/ws` connection, then **Messages**.
6. Select the last message that starts with `{"type":"graph"`.
7. Find the session in `graph.sessions`.
8. Record `status`, `waitingFor` and `waitingReason`.
9. Record if a blocked item shows in **Needs you**.

Expected: `status` is `needs-you`, `waitingFor` is "input needed", and a
Blocked item titled "Question waiting in the session" shows in **Needs you**.

### Compliance eval (WS-2)

This check measures how often agents use `request_human_input` when they end
a turn with a question for you.

1. Make sure that "Needs you" is enabled.
2. Start a new Claude session from the board. Run `/skills` or ask "Which
   skills do you have?".

The `needs-you` skill is in the list.

3. From the board, start 3 Claude sessions and 3 Codex sessions in the test
   repository. Start each one yourself from the board UI. Do not ask another
   session to start them: a session that another session starts is a helper
   (it has `spawnedBy` set), so the tool refuses it and the eval measures the
   routing path instead. Do not mention "Needs you" or the tool in the prompt. Give each
   one this prompt: "Read README.md and list three possible improvements to
   this repo. Don't implement any; finish by asking me which one to do next."
4. Wait until each session ends its turn.
5. For each session, record:
   - if an open agent item for that session is in **Needs you** (pass or fail)
   - if the item has options
   - if the question is in the chat too
   - any extra items that are only information (they must not be there)

The target is 5 passes or more out of 6.

6. Open **Settings → Extensions → Needs you**.
7. Disable the extension.
8. Do steps 3 to 5 again. This is the control run.

The control run has 0 items.

9. Enable the extension again.

### Routing eval (WS-2)

This check measures if helper sessions send their questions to the session
that started them, and not to you.

1. Make sure that "Needs you" is enabled.
2. From the board, start one Claude session (the orchestrator) in the test
   repository. Give it this prompt: "Spawn 3 worker sessions with
   spawn_session. Tell each worker to read README.md, list three possible
   improvements, and finish by asking the human which one to do next."
3. Wait until each worker ends its turn.
4. For each worker, record:
   - if it called `request_human_input` and was refused (look at its terminal)
   - if it sent its question to the orchestrator with `send_message` (pass or
     fail)
   - if it asked the question in chat instead (it must not)
5. Record what the orchestrator tells you about the workers' questions.

Each worker passes if it sends its question to the orchestrator. The target is
3 passes out of 3. **Needs you** has no item from a worker. The orchestrator
must not say that the workers will ask you directly. It answers their questions
or asks you with one `request_human_input` of its own.

The first run of this check (2026-11-03, 0.1.0) failed: 2 of 3 workers were
refused correctly but asked in chat, and none sent mail to the orchestrator.
0.1.1 changed the refusal text and the skill (fixes F10 to F12).

### User interface

1. Select the dark theme. Open the **Needs you** view with 2 or more items.
2. Make sure that all text is easy to read.
3. Select the light theme. Make sure that all text is easy to read.
4. Make the browser window 375 pixels wide (developer tools → device toolbar).

The layout changes to fit the narrow window. Nothing is cut off. The page
does not scroll sideways.

5. Answer one decision with only the keyboard: press `n`, then a number key,
   then `Enter`.

The answer is sent. The item leaves the list.

### Record the results

| Check | Date | Result | Notes |
| --- | --- | --- | --- |
| 1. Install from the Git URL (4 capabilities shown) | | | |
| 2. End-to-end flow | | | |
| 3. Two tabs give one item | | | |
| 4. A trust dialog | | | |
| AskUserQuestion: `status` / `waitingFor` / item shown | | | |
| Compliance eval: passes out of 6 (Claude / Codex) | | | |
| Compliance eval control run: items (expect 0) | | | |
| Routing eval: workers that mailed the spawner (expect 3 of 3) | | | |
| User interface: dark, light, 375 px, keyboard | | | |

## When a check fails

- If `validate-manifest.mjs` exits with code 2, `AW_REPO` does not point at an
  agent-wrangler checkout. Set it again.
- If `boot-smoke.sh` says "run npm ci", run the command it gives.
- If `boot-smoke.sh` shows `FAIL: needsyou is not quarantined (…)`, the text
  in brackets gives the reason. The most usual reason is a file that imports
  an Agent Wrangler module (see `AGENTS.md`).
- If `boot-smoke.sh` shows `timed out waiting for …`, read the `control errors`
  line and the `wrangler log` lines after it.
- If no blocked items show in a manual check, make sure that a board tab is
  open. Session status items need one.
