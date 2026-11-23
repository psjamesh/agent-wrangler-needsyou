# WS-6 — Integration, smoke tests & release

**Depends on:** WS-2, WS-3, WS-4, WS-5 merged · **Branch:** `ws6-integration`
**Read first:** everything in `docs/specs/`; wrangler-squared `scripts/validate-manifest.mjs`,
`scripts/boot-smoke.sh`, `scripts/dev-smoke.mjs`, `.github/workflows/test.yml`.

## Goal

Prove that the whole extension installs, loads and works end to end against a real Agent Wrangler,
and make it installable from a git URL.

## Owned files

```
scripts/validate-manifest.mjs   # extend WS-1's version
scripts/boot-smoke.sh scripts/dev-smoke.mjs
.github/workflows/test.yml      # add the boot-smoke job (coordinate: WS-1 created it; you own it from now on)
README.md CHANGELOG.md docs/notes/*.md
```

## Requirements

1. **validate-manifest**: runs the real loader (`AW_REPO`) and asserts no quarantine. Also asserts
   that the 3 tools, the 6 handler types, the `inbox` skill, the 5 settings, the `view` client
   asset and the sweeps are registered. Also run the tools through agent-wrangler's **real MCP
   server** (`server/mcp/server.js` `buildMcpServer`, or its `McpServer` from the SDK) with an
   in-memory client: `tools/list` shows the 3 tools with their schemas, one valid `tools/call`
   succeeds and one invalid one is rejected. The extension builds schemas with `host.schema.z`
   (Zod 4) through `schema:zod` on host API `^2.1.0`. Compare the listed schemas with
   the baseline fixture and check validation limits using the host's Zod.
2. **boot-smoke** boots a wrangler on a temp `AW_DATA_DIR` and a free port, with this repo copied
   to `extensions/needsyou`. `dev-smoke.mjs` then:
   - connects to the control socket and waits for a graph with `inbox`
   - calls the MCP `request_human_input` as a fake caller (or uses a dispatched dummy session, if the
     harness offers one; follow wrangler-squared's approach) and sees the item in `graph.inbox`
   - sends `inbox-observe` with a synthetic `needs-you` session, sees a status item, then sends it
     `idle` and sees it resolved
   - sends `inbox-mark-read` and sees `unread` drop
   - calls `request_human_input` as a caller whose session has `spawnedBy` set, gets the refusal
     naming the spawner, then sends `inbox-set-can-ask` and sees the same call succeed
   - exits 1 on any failed expectation.
3. **README**: what it is, a screenshot, the install (Settings → Extensions → Git URL), what
   appears in "Needs you" (overview §3, as a table), who may ask (spawned sessions go through their
   orchestrator), settings, the limitation (status items need a board tab open,
   overview §4), privacy (items are stored in `~/.agent-wrangler/inbox.json` and kept after
   uninstall), and the trust note (extensions run with full machine access; do not soften this).
   **Writing style (from the human):**
   - README.md and docs/notes/testing.md are in GOV.UK plain English: short sentences, active
     voice, "you", everyday words, the important thing first, and task or question headings.
   - Procedures (install, testing checklist, troubleshooting) also follow ASD-STE100: one
     imperative instruction per sentence, at most 20 words, conditions and warnings before the
     step, expected results as separate sentences, and one word per meaning.
4. Add the `agent-wrangler-extension` GitHub topic once the repo is public. Ask the human first,
   because it is outward-facing.
5. **End-to-end manual checklist** (record the results in your completion mail): two parallel sessions, one
   permission prompt, one `request_human_input` decision, and one worker spawned by an orchestrator
   whose question arrives at the orchestrator by mail; answer the decision from "Needs you"; approve
   the permission in the terminal; check that both close, the badge goes to 0 and the toasts
   withdraw.
   Also run WS-2's compliance eval (its procedure is in `docs/notes/agent-requests.md`): 3 Claude
   and 3 Codex board-launched sessions asked to end by asking which improvement to do next. Pass
   means an open agent item exists before the turn ends. Target ≥ 5/6, with a control run with the
   extension off. Also settle WS-3's open question: have a Claude session call `AskUserQuestion`, and record
   whether the graph shows `needs-you` and what `waitingFor` says.
6. Write `docs/notes/<area>.md` for each WS's non-obvious decisions, and link them from
   `AGENTS.md`. The orchestrator forwards each worker's completion mail. Editing `AGENTS.md` for
   this is the one exception to WS-1 owning it.

## Acceptance criteria

- [ ] CI green, including boot-smoke against agent-wrangler `main`.
- [ ] Fresh install from the git URL on a clean data dir works, with the consent modal listing the
      4 capabilities (`sessions:read`, `tasks:read`, `deliver`, `board:rebuild`).
- [ ] The manual e2e checklist passes.
