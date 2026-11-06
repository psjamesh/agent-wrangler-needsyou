#!/usr/bin/env node
// Smoke-test a RUNNING dev wrangler that has this extension installed and the
// three cards scripts/boot-smoke.sh seeds (smoke-human, smoke-worker spawned by
// it, smoke-archived). boot-smoke.sh boots one; by hand:
//   AW_REPO=<wrangler checkout> node scripts/dev-smoke.mjs <port>
// Over the control WS and /mcp, as a board tab and an agent would:
//   - the extension is announced, enabled, unquarantined, with its 6 handlers,
//     its client assets are served (and the test fixtures are not), and
//     graph.inbox is there
//   - request_human_input (valid) lands in graph.inbox; an invalid one doesn't
//   - inbox-observe with a needs-you session opens one status item (twice
//     still one), and the same session idle resolves it
//   - inbox-mark-read drops unread
//   - a spawned caller is refused naming its spawner, inbox-set-can-ask lets
//     the same call through, and null restores the default
//   - inbox-answer reaches host.deliver: to an archived card it is refused and
//     recorded as a failed delivery (nothing is woken or launched); inbox-retry
//     fails the same way and counts the attempt
//   - inbox-dismiss and withdraw_human_request close items
//   - with AW_SMOKE_DATA_DIR, inbox.json holds it all
// Exits 1 on any failed expectation, 2 on bad usage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const port = Number(process.argv[2]);
if (!port) { console.error('usage: node scripts/dev-smoke.mjs <port>'); process.exit(2); }
if (!process.env.AW_REPO) { console.error('Set AW_REPO to the agent-wrangler checkout (for its ws module)'); process.exit(2); }
const repo = path.resolve(process.env.AW_REPO.replace(/^~/, os.homedir()));
const { WebSocket } = await import(pathToFileURL(path.join(repo, 'node_modules/ws/wrapper.mjs')).href);

const ID = 'needsyou';
const HUMAN = 'smoke-human';
const WORKER = 'smoke-worker';
const ARCHIVED = 'smoke-archived';
const base = `http://localhost:${port}`;

const failures = [];
const expect = (ok, what) => {
  if (ok) console.log(`ok: ${what}`);
  else { failures.push(what); console.error(`FAIL: ${what}`); }
  return ok;
};
const finish = () => {
  if (failures.length) console.error(`dev-smoke: ${failures.length} failed expectation(s)`);
  else console.log('dev-smoke: all expectations met');
  process.exit(failures.length ? 1 : 0);
};
const bail = (what) => {
  if (what) expect(false, what);
  const errs = errorFrames();
  if (errs.length) console.error('control errors:', JSON.stringify(errs));
  if (latest?.inbox) console.error('last graph.inbox items:', JSON.stringify(latest.inbox.items.map((i) => ({ id: i.id, sessionId: i.sessionId, state: i.state, resolvedReason: i.resolvedReason, answer: i.answer }))));
  ws.terminate();
  finish();
};

const ws = new WebSocket(`ws://localhost:${port}/ws`);
const frames = [];
let latest = null; // the newest graph frame's graph
ws.on('message', (d) => {
  const m = JSON.parse(d);
  frames.push(m);
  if (m.type === 'graph') latest = m.graph;
});
ws.on('error', (err) => bail(`control WS: ${err.message}`));
await new Promise((r) => ws.on('open', r));

// Resolves with the first matching frame: an earlier one too with `past`,
// otherwise only one that arrives from now on.
const next = (pred, what, { ms = 10_000, past = true } = {}) => new Promise((res) => {
  const hit = past && frames.find(pred); if (hit) return res(hit);
  const t = setTimeout(() => { ws.off('message', h); bail(`timed out waiting for ${what}`); }, ms);
  function h(d) { const m = JSON.parse(d); if (pred(m)) { clearTimeout(t); ws.off('message', h); res(m); } }
  ws.on('message', h);
});
// The newest graph's inbox if it satisfies pred, else the next one that does.
// Never an older frame: a stale graph (the empty first one, say) would let a
// check like `open === 0` pass before the action it checks has landed.
const inboxWhere = async (pred, what) => {
  if (latest?.inbox && pred(latest.inbox)) return latest.inbox;
  const m = await next((f) => f.type === 'graph' && f.graph.inbox && pred(f.graph.inbox), what, { past: false });
  return m.graph.inbox;
};
const send = (msg) => ws.send(JSON.stringify(msg));
const itemIn = (inbox, id) => inbox.items.find((i) => i.id === id);
const errorFrames = () => frames.filter((m) => m.type === 'error' || (m.type === `ext:${ID}` && m.error));

// /mcp as a given card. One JSON-RPC request per POST (stateless server).
let rpc = 0;
const mcp = async (body, caller) => {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(caller ? { 'X-AW-Session': caller } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, ...body }),
  });
  return res.json();
};
const callTool = (caller, name, args) => mcp({ method: 'tools/call', params: { name, arguments: args } }, caller);
const toolText = (r) => r.result?.content?.[0]?.text ?? r.error?.message ?? '';

// 1. Loaded, enabled, wired.
const ann = await next((m) => m.type === 'extensions', 'the extensions announcement');
console.log('extensions announcement:', JSON.stringify(ann.list?.map((e) => e.id)), 'host API', ann.version);
expect(ann.list?.some((e) => e.id === ID), `${ID} is in the extensions announcement`);
const g1 = (await next((m) => m.type === 'graph', 'the first graph')).graph;
const ext = g1.extensions?.find((e) => e.id === ID);
console.log(`graph.extensions.${ID}:`, JSON.stringify({ enabled: ext?.enabled, quarantine: ext?.quarantine, handlerTypes: ext?.handlerTypes, external: ext?.external }));
if (!expect(ext, `${ID} is in graph.extensions`)) bail();
if (!expect(!ext.quarantine, `${ID} is not quarantined (${ext.quarantine ?? 'none'})`)) bail();
if (!expect(ext.enabled, `${ID} is enabled`)) bail();
expect(ext.handlerTypes?.length === 6 && ext.handlerTypes.every((t) => t.startsWith('inbox-')), 'its 6 inbox-* handlers are registered');
for (const asset of ['index.js', 'styles.css', 'observer.js', 'inbox-toasts.js']) {
  const res = await fetch(`${base}/ext/${ID}/${asset}`);
  expect(res.ok, `/ext/${ID}/${asset} is served (${res.status})`);
}
{
  // Test fixtures live in test/, outside public/, so they are never served.
  const res = await fetch(`${base}/ext/${ID}/inbox-fixtures.js`);
  expect(res.status === 404, `/ext/${ID}/inbox-fixtures.js is not served (${res.status})`);
}
const inbox0 = await inboxWhere(() => true, 'a graph with inbox');
console.log('graph.inbox:', JSON.stringify({ rev: inbox0.rev, unread: inbox0.unread, open: inbox0.open, items: inbox0.items.length, sessions: inbox0.sessions }));
expect(Number.isFinite(inbox0.rev) && Array.isArray(inbox0.items), 'graph.inbox has rev and items');
expect(inbox0.sessions?.[WORKER]?.spawnedBy === HUMAN && inbox0.sessions[WORKER].canAsk === false, 'graph.inbox.sessions lists the spawned worker with canAsk false');

// 2. An agent request, through the real /mcp.
const list = await mcp({ method: 'tools/list', params: {} }, HUMAN);
const names = (list.result?.tools ?? []).map((t) => t.name);
const tools = ['request_human_input', 'withdraw_human_request', 'list_my_human_requests'];
console.log('mcp tools/list has:', tools.map((n) => `${n}=${names.includes(n)}`).join(' '));
for (const n of tools) expect(names.includes(n), `/mcp lists ${n}`);
const asked = await callTool(HUMAN, 'request_human_input', {
  kind: 'decision', title: 'Smoke: which way?', body: 'Created by scripts/dev-smoke.mjs.',
  options: [{ label: 'Left' }, { label: 'Right' }],
});
console.log('request_human_input:', JSON.stringify(asked.result?.structuredContent ?? asked.error ?? asked.result));
const agentId = asked.result?.structuredContent?.id;
if (!expect(!asked.result?.isError && agentId, 'a valid request_human_input succeeds')) bail();
const inbox1 = await inboxWhere((ib) => itemIn(ib, agentId)?.state === 'open', 'the agent item in graph.inbox');
const agentItem = itemIn(inbox1, agentId);
expect(agentItem.source === 'agent' && agentItem.kind === 'decision' && agentItem.sessionId === HUMAN && agentItem.options.map((o) => o.id).join() === 'left,right', 'the agent item carries its kind, session and options');
expect(inbox1.unread === inbox0.unread + 1 && inbox1.open === inbox0.open + 1, `unread ${inbox0.unread} → ${inbox1.unread}, open ${inbox0.open} → ${inbox1.open}`);
const bad = await callTool(HUMAN, 'request_human_input', { kind: 'gossip', title: '' });
console.log('request_human_input (invalid):', toolText(bad).split('\n')[0].slice(0, 200));
expect(bad.error || bad.result?.isError, 'an invalid request_human_input is refused');
const noId = await callTool(null, 'request_human_input', { kind: 'question', title: 'Smoke: from nobody' });
expect(noId.error || noId.result?.isError, 'a request with no session identity is refused');

// 3. A passive needs-you signal, as a board tab reports it. Every non-archived
// session is listed (complete: true).
const observe = (workerStatus, waitingFor = null) => send({
  type: 'inbox-observe', complete: true,
  sessions: [
    { sessionId: HUMAN, status: 'idle', waitingFor: null, waitingReason: null, updatedAt: null },
    { sessionId: WORKER, status: workerStatus, waitingFor, waitingReason: null, updatedAt: 1_700_000_000_000 },
  ],
});
const statusOpen = (ib) => ib.items.filter((i) => i.source === 'status' && i.sessionId === WORKER && i.state === 'open');
observe('needs-you', 'Bash: rm -rf build');
const inbox2 = await inboxWhere((ib) => statusOpen(ib).length > 0, 'a status item for the needs-you session');
const status = statusOpen(inbox2)[0];
console.log('status item:', JSON.stringify({ id: status.id, kind: status.kind, title: status.title, dedupeKey: status.dedupeKey }));
expect(status.kind === 'blocked' && status.title === 'Waiting for you: Bash: rm -rf build', 'the status item is a blocked item titled from waitingFor');
observe('needs-you', 'Bash: rm -rf build'); // a second tab, the same snapshot
observe('needs-you', 'Bash: rm -rf build');
await new Promise((r) => setTimeout(r, 1500));
expect(statusOpen(latest.inbox).length === 1, 'repeating the snapshot leaves exactly one status item');
observe('idle');
const inbox3 = await inboxWhere((ib) => itemIn(ib, status.id)?.state === 'resolved', 'the status item resolved');
expect(itemIn(inbox3, status.id).resolvedReason === 'status-cleared', 'idle resolves it as status-cleared');
expect(itemIn(inbox3, agentId)?.state === 'open', 'the agent request is still open');

// 4. Reading.
const unreadBefore = inbox3.unread;
send({ type: 'inbox-mark-read', ids: [agentId] });
const inbox4 = await inboxWhere((ib) => itemIn(ib, agentId)?.readAt, 'the agent item marked read');
expect(inbox4.unread === unreadBefore - 1, `inbox-mark-read drops unread ${unreadBefore} → ${inbox4.unread}`);

// 5. Who may ask: the spawned worker is refused, then allowed by the human.
const refused = await callTool(WORKER, 'request_human_input', { kind: 'question', title: 'Smoke: from the worker' });
console.log('worker refusal:', toolText(refused));
expect(
  refused.result?.isError && toolText(refused).includes(`call send_message now (to: "${HUMAN}")`) && toolText(refused).includes('Do not call request_human_input again'),
  'a spawned caller is refused with the send_message next step, naming its spawner',
);
send({ type: 'inbox-set-can-ask', sessionId: WORKER, allowed: true });
await inboxWhere((ib) => ib.sessions?.[WORKER]?.canAsk === true, 'canAsk true for the worker');
const allowed = await callTool(WORKER, 'request_human_input', { kind: 'question', title: 'Smoke: from the worker' });
const workerId = allowed.result?.structuredContent?.id;
console.log('worker after inbox-set-can-ask:', JSON.stringify(allowed.result?.structuredContent ?? toolText(allowed)));
expect(!allowed.result?.isError && workerId, 'after inbox-set-can-ask the same call succeeds');
await inboxWhere((ib) => itemIn(ib, workerId)?.state === 'open', "the worker's item in graph.inbox");
send({ type: 'inbox-set-can-ask', sessionId: WORKER, allowed: null });
await inboxWhere((ib) => ib.sessions?.[WORKER]?.canAsk === false, 'canAsk back to false after null');
expect(true, 'inbox-set-can-ask null restores the default');

// 6. An answer reaches host.deliver. The only card it is safe to deliver to
// in a smoke test is an archived one: delivery is refused and recorded, and
// nothing is resumed. (A live or dormant card would be pasted into or woken.)
const archivedAsk = await callTool(ARCHIVED, 'request_human_input', { kind: 'approval', title: 'Smoke: approve?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] });
const archivedId = archivedAsk.result?.structuredContent?.id;
if (expect(archivedId, 'a request from the archived card is recorded')) {
  await inboxWhere((ib) => itemIn(ib, archivedId), 'the archived card\'s item');
  send({ type: 'inbox-answer', id: archivedId, optionId: 'yes', text: ' after lunch ' });
  const ib = await inboxWhere((x) => itemIn(x, archivedId)?.answer?.delivery === 'failed', 'the answer recorded as a failed delivery');
  const a = itemIn(ib, archivedId);
  console.log('answer to the archived card:', JSON.stringify({ state: a.state, answer: a.answer }));
  expect(a.allowFreeText === true && a.answer.text === 'after lunch', 'fixed-choice answer keeps its optional note through the real handler and store');
  expect(a.state === 'answered' && a.answer.optionId === 'yes' && /archived/i.test(a.answer.deliveryError ?? ''), 'inbox-answer → host.deliver refuses the archived card, kept as answered + failed');
  send({ type: 'inbox-retry', id: archivedId });
  const ib2 = await inboxWhere((x) => itemIn(x, archivedId)?.answer?.attempts === 2, 'the retry counted');
  expect(itemIn(ib2, archivedId).answer.delivery === 'failed', 'inbox-retry fails the same way and counts the attempt');
  send({ type: 'inbox-dismiss', id: archivedId });
  const ib3 = await inboxWhere((x) => itemIn(x, archivedId)?.state === 'resolved', 'the failed answer dismissed');
  expect(itemIn(ib3, archivedId).resolvedReason === 'dismissed', 'inbox-dismiss closes it');
}

const textAsk = await callTool(ARCHIVED, 'request_human_input', {
  kind: 'decision', title: 'Smoke: another approach?', options: [{ id: 'a', label: 'A' }], allow_free_text: false,
});
const textId = textAsk.result?.structuredContent?.id;
if (expect(textId, 'a request with the false compatibility flag is recorded')) {
  await inboxWhere((ib) => itemIn(ib, textId), 'the text-only request');
  send({ type: 'inbox-answer', id: textId, text: ' another approach ' });
  const ib = await inboxWhere((x) => itemIn(x, textId)?.answer?.delivery === 'failed', 'the standalone text answer recorded');
  const a = itemIn(ib, textId);
  expect(a.allowFreeText === true && a.answer.optionId === null && a.answer.text === 'another approach', 'standalone text passes the real handler and store despite allow_free_text false');
  expect(/archived/i.test(a.answer.deliveryError ?? ''), 'standalone text reaches host.deliver without waking a card');
  send({ type: 'inbox-dismiss', id: textId });
  await inboxWhere((x) => itemIn(x, textId)?.state === 'resolved', 'the standalone text answer dismissed');
}

// 7. The agent's own view and withdrawal.
const mine = await callTool(HUMAN, 'list_my_human_requests', {});
expect(mine.result?.structuredContent?.requests?.some((r) => r.id === agentId), 'list_my_human_requests lists the open request');
const withdrawn = await callTool(HUMAN, 'withdraw_human_request', { id: agentId });
expect(!withdrawn.result?.isError, 'withdraw_human_request succeeds');
const notMine = await callTool(WORKER, 'withdraw_human_request', { id: agentId });
expect(notMine.result?.isError, "a session cannot withdraw another session's request");
const inbox5 = await inboxWhere((ib) => itemIn(ib, agentId)?.state === 'resolved', 'the agent item withdrawn');
expect(itemIn(inbox5, agentId).resolvedReason === 'withdrawn', 'withdrawn shows in graph.inbox');
send({ type: 'inbox-dismiss', id: workerId });
const inbox6 = await inboxWhere((ib) => ib.open === 0, 'nothing left open');
console.log('final graph.inbox:', JSON.stringify({ unread: inbox6.unread, open: inbox6.open, items: inbox6.items.map((i) => `${i.source}:${i.state}:${i.resolvedReason}`) }));
expect(inbox6.unread === 0 && inbox6.open === 0, 'the queue ends empty (unread 0, open 0)');

const errs = errorFrames();
if (errs.length) console.log('control errors:', JSON.stringify(errs));
expect(!errs.length, 'no control errors');
ws.close();

// 8. Persistence, when boot-smoke says where the data dir is.
if (process.env.AW_SMOKE_DATA_DIR) {
  const file = path.join(process.env.AW_SMOKE_DATA_DIR, 'inbox.json');
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error(`(could not read ${file}: ${e.message})`); }
  expect(saved?.version === 1 && saved.items?.length >= 4 && saved.items.some((i) => i.id === agentId), `inbox.json in the data dir holds the items (${saved?.items?.length ?? 0})`);
  const savedText = saved?.items?.find((i) => i.id === textId);
  expect(savedText?.answer?.optionId === null && savedText?.answer?.text === 'another approach', 'inbox.json persists the standalone text answer without a choice');
  expect(saved && !Object.hasOwn(saved.canAsk ?? {}, WORKER), 'inbox.json has no canAsk override left for the worker');
}
finish();
