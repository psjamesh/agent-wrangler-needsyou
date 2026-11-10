import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { inboxTools, makeInboxTools } from './index.js';
import { RATE_LIMIT } from './request-human-input.js';
import { RECENT_MS } from './list-my-human-requests.js';
import { fakeHost, seq, clock } from '../test-helpers.js';

function setup({ settings } = {}) {
  const now = clock();
  const f = fakeHost({
    sessions: [{ sessionId: 's1', taskId: 't1' }, { sessionId: 's2' }],
    settings,
    now,
    idGen: seq(),
  });
  const [request, withdraw, list] = makeInboxTools({ now });
  const as = (caller) => ({ host: f.host, caller });
  return { ...f, now, request, withdraw, list, as };
}

const ask = (extra = {}) => ({ kind: 'decision', title: 'Migrate in place or behind a copy?', ...extra });

test('the three contracted tools, uniquely named', () => {
  assert.deepEqual(inboxTools.map((t) => t.name), ['request_human_input', 'withdraw_human_request', 'list_my_human_requests']);
  for (const t of inboxTools) {
    assert.equal(typeof t.handler, 'function');
    assert.equal(typeof t.description, 'string');
    assert.equal(typeof t.inputSchema, 'object');
  }
});

test('every description keeps the "never for status updates" sentence', () => {
  for (const t of inboxTools) assert.match(t.description, /Never for status updates, summaries, or "done" notices\./, t.name);
  const [request] = inboxTools;
  assert.match(request.description, /Use only when you cannot proceed correctly without the human's decision or action\./);
  assert.match(request.description, /Good: /);
  assert.match(request.description, /Bad: /);
});

test('no tool takes a session parameter', () => {
  for (const t of inboxTools) {
    for (const k of Object.keys(t.inputSchema)) {
      assert.doesNotMatch(k, /^(session|session_?id|card|card_?id|caller)$/i, `${t.name} must not take ${k}`);
    }
  }
});

test('the input schemas are valid zod shapes that match the spec limits', () => {
  const schema = z.object(inboxTools[0].inputSchema);
  assert.equal(schema.safeParse(ask({ options: [{ label: 'A' }, { id: 'b', label: 'B', description: 'why' }] })).success, true);
  for (const bad of [
    ask({ kind: 'blocked' }),
    ask({ title: '' }),
    ask({ title: 'x'.repeat(121) }),
    ask({ options: Array(7).fill({ label: 'A' }) }),
    ask({ expires_in_minutes: 4 }),
    ask({ expires_in_minutes: 10081 }),
    ask({ urgency: 'low' }),
  ]) assert.equal(schema.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 80));
  const withdrawSchema = z.object(inboxTools[1].inputSchema);
  assert.equal(withdrawSchema.safeParse({ id: 'ibx_1', reason: 'User answered in chat' }).success, true);
  for (const bad of [{ id: 'ibx_1' }, { id: 'ibx_1', reason: '' }, { id: 'ibx_1', reason: 'x'.repeat(201) }]) {
    assert.equal(withdrawSchema.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 80));
  }
});

test('every tool refuses a caller with no session identity', async () => {
  const { host } = setup();
  for (const t of inboxTools) {
    const out = await t.handler({ host, caller: null }, { ...ask(), id: 'ibx_x' });
    assert.equal(out.isError, true, t.name);
    assert.match(out.content[0].text, /no session/);
  }
});

test('request_human_input: the happy path queues an item for the caller', async () => {
  const { request, as, store, calls, now } = setup();
  const out = await request.handler(as('s1'), ask({
    body: 'The table has 40M rows.\n\nI recommend **behind a copy**.',
    options: [{ id: 'copy', label: 'Behind a copy' }, { label: 'In place' }],
    urgency: 'high',
    expires_in_minutes: 60,
  }));
  assert.equal(out.isError, undefined);
  assert.deepEqual(out.structuredContent, { id: 'ibx_000000000001', state: 'open', blocking: true, updated: false });
  assert.match(out.content[0].text, /^Request queued in the human's "Needs you" queue\. Also write the question, its options and your recommendation in your reply, so the human sees it in chat too\. Don't tell them it is in their "Needs you" queue: the board shows them\. If they answer in chat, call withdraw_human_request with this id\. Then end your turn; the answer will arrive as a message starting `\[Needs you\]`\./);
  assert.equal(calls.rebuild, 1);

  const item = store.get('ibx_000000000001');
  assert.equal(item.source, 'agent');
  assert.equal(item.kind, 'decision');
  assert.equal(item.sessionId, 's1');
  assert.equal(item.taskId, 't1');
  assert.equal(item.body, 'The table has 40M rows.\n\nI recommend **behind a copy**.');
  assert.deepEqual(item.options, [{ id: 'copy', label: 'Behind a copy' }, { id: 'in-place', label: 'In place' }]);
  assert.equal(item.allowFreeText, true);
  assert.equal(item.urgency, 'high');
  assert.equal(item.dedupeKey, 'agent:s1:ibx_000000000001');
  assert.equal(item.expiresAt, now() + 60 * 60_000);
});

test('request_human_input: non-blocking requests say to carry on, and a session with no task gets null', async () => {
  const { request, as, store } = setup();
  const out = await request.handler(as('s2'), ask({ blocking: false }));
  assert.equal(out.structuredContent.blocking, false);
  assert.match(out.content[0].text, /Carry on with work that does not depend on it/);
  assert.match(out.content[0].text, /so the human sees it in chat too/, 'a non-blocking request is said in chat as well');
  assert.equal(store.get(out.structuredContent.id).taskId, null);
});

test('request_human_input: every validation failure is an error result that creates nothing', async () => {
  const { request, as, store, calls } = setup();
  const cases = [
    [{}, /kind must be one of/],
    [ask({ kind: 'blocked' }), /kind must be one of/],
    [ask({ title: undefined }), /title is required/],
    [ask({ title: '   ' }), /title must not be empty/],
    [ask({ title: 'x'.repeat(121) }), /title must be at most 120/],
    [ask({ body: 42 }), /body must be a string/],
    [ask({ body: 'x'.repeat(8001) }), /body must be at most 8000/],
    [ask({ options: 'a,b' }), /options must be an array/],
    [ask({ options: Array(7).fill({ label: 'A' }) }), /at most 6 options/],
    [ask({ options: [null] }), /options\[0\] must be an object/],
    [ask({ options: [{ label: '' }] }), /options\[0\]\.label is required/],
    [ask({ options: [{ label: 'x'.repeat(81) }] }), /label must be at most 80/],
    [ask({ options: [{ id: 'Bad Id', label: 'A' }] }), /options\[0\]\.id must match/],
    [ask({ options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }), /used twice/],
    [ask({ options: [{ label: 'A', description: 'x'.repeat(301) }] }), /description must be at most 300/],
    [ask({ allow_free_text: 'yes' }), /allow_free_text must be a boolean/],
    [ask({ blocking: 'no' }), /blocking must be a boolean/],
    [ask({ urgency: 'low' }), /urgency must be one of/],
    [ask({ dedupe_key: '  ' }), /dedupe_key must be a non-empty string/],
    [ask({ dedupe_key: 'k'.repeat(121) }), /dedupe_key must be at most 120/],
    [ask({ expires_in_minutes: 4 }), /expires_in_minutes must be a whole number from 5 to 10080/],
    [ask({ expires_in_minutes: 10081 }), /expires_in_minutes/],
    [ask({ expires_in_minutes: 7.5 }), /expires_in_minutes/],
  ];
  for (const [args, re] of cases) {
    const out = await request.handler(as('s1'), args);
    assert.equal(out.isError, true, JSON.stringify(args).slice(0, 80));
    assert.match(out.content[0].text, re);
  }
  assert.equal(store.snapshot().length, 0);
  assert.equal(calls.rebuild, 0);
});

test('request_human_input: a session argument smuggled in is ignored', async () => {
  const { request, as, store } = setup();
  const out = await request.handler(as('s1'), ask({ session: 's2', sessionId: 's2', session_id: 's2' }));
  assert.equal(store.get(out.structuredContent.id).sessionId, 's1');
});

test('request_human_input: the same dedupe_key updates the open item in place', async () => {
  const { request, as, store, calls, now } = setup();
  const first = await request.handler(as('s1'), ask({ dedupe_key: 'migrate', options: [{ label: 'A' }, { label: 'B' }] }));
  const { id } = first.structuredContent;
  store.markRead([id]);
  const readAt = store.get(id).readAt;
  now.tick(1000);

  const again = await request.handler(as('s1'), ask({ dedupe_key: 'migrate', title: 'Migrate now?', body: 'More context', options: [{ label: 'Yes' }, { label: 'No' }], urgency: 'high' }));
  assert.equal(again.isError, undefined);
  assert.deepEqual(again.structuredContent, { id, state: 'open', blocking: true, updated: true });
  const item = store.get(id);
  assert.equal(item.title, 'Migrate now?');
  assert.equal(item.body, 'More context');
  assert.deepEqual(item.options.map((o) => o.id), ['yes', 'no']);
  assert.equal(item.urgency, 'high');
  assert.equal(item.readAt, readAt, 'a restated request is not new mail');
  assert.equal(item.dedupeKey, 'agent:s1:migrate');
  assert.equal(store.snapshot().length, 1);
  assert.equal(calls.rebuild, 2);
});

test('request_human_input: dedupe keys are per session, and a closed item does not catch a new ask', async () => {
  const { request, withdraw, as, store } = setup();
  const mine = await request.handler(as('s1'), ask({ dedupe_key: 'k' }));
  const theirs = await request.handler(as('s2'), ask({ dedupe_key: 'k' }));
  assert.notEqual(mine.structuredContent.id, theirs.structuredContent.id);
  assert.equal(store.get(theirs.structuredContent.id).dedupeKey, 'agent:s2:k');
  assert.equal(store.get(mine.structuredContent.id).title, 'Migrate in place or behind a copy?');

  await withdraw.handler(as('s1'), { id: mine.structuredContent.id, reason: 'done' });
  const fresh = await request.handler(as('s1'), ask({ dedupe_key: 'k' }));
  assert.equal(fresh.structuredContent.updated, false);
  assert.notEqual(fresh.structuredContent.id, mine.structuredContent.id);
});

test('request_human_input: the per-session cap comes back as advice', async () => {
  const { request, as, store, now } = setup({ settings: { maxOpenPerSession: 2 } });
  await request.handler(as('s1'), ask());
  await request.handler(as('s1'), ask());
  now.tick(RATE_LIMIT.windowMs + 1);
  const out = await request.handler(as('s1'), ask());
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /already has 2 open inbox requests \(the limit is 2\)/);
  assert.match(out.content[0].text, /withdraw_human_request/);
  assert.equal(store.openForSession('s1').length, 2);
  // Another session has its own cap.
  assert.equal((await request.handler(as('s2'), ask())).isError, undefined);
});

test('request_human_input: at most three new requests per session per ten minutes', async () => {
  const { request, as, now } = setup();
  for (let i = 0; i < RATE_LIMIT.max; i++) assert.equal((await request.handler(as('s1'), ask())).isError, undefined);
  const over = await request.handler(as('s1'), ask());
  assert.equal(over.isError, true);
  assert.match(over.content[0].text, /Too many separate requests — batch related questions into one request with options\./);
  assert.equal((await request.handler(as('s2'), ask())).isError, undefined, 'another session has its own budget');
  now.tick(RATE_LIMIT.windowMs);
  assert.equal((await request.handler(as('s1'), ask())).isError, undefined, 'the window slides');
});

test('request_human_input: dedupe updates and refusals do not count towards the rate limit', async () => {
  const f = setup();
  const { request, as, store } = f;
  await request.handler(as('s1'), ask({ dedupe_key: 'same' }));
  for (let i = 0; i < 5; i++) assert.equal((await request.handler(as('s1'), ask({ dedupe_key: 'same' }))).structuredContent.updated, true);
  for (let i = 0; i < 5; i++) assert.equal((await request.handler(as('s1'), ask({ title: '' }))).isError, true);
  store.setCanAskOverride('s1', false);
  for (let i = 0; i < 5; i++) assert.equal((await request.handler(as('s1'), ask())).isError, true);
  store.setCanAskOverride('s1', null);
  // One counted so far: two more new ids fit before the limit.
  assert.equal((await request.handler(as('s1'), ask())).isError, undefined);
  assert.equal((await request.handler(as('s1'), ask())).isError, undefined);
  assert.equal((await request.handler(as('s1'), ask())).isError, true);
});

test('request_human_input: a cap refusal does not count towards the rate limit', async () => {
  const { request, withdraw, as } = setup({ settings: { maxOpenPerSession: 1 } });
  const first = await request.handler(as('s1'), ask());
  for (let i = 0; i < 4; i++) assert.match((await request.handler(as('s1'), ask())).content[0].text, /the limit is 1/);
  await withdraw.handler(as('s1'), { id: first.structuredContent.id, reason: 'done' });
  assert.equal((await request.handler(as('s1'), ask())).isError, undefined);
});

test('withdraw_human_request closes the caller\'s own open request', async () => {
  const { request, withdraw, as, store, calls } = setup();
  const { id } = (await request.handler(as('s1'), ask())).structuredContent;
  const out = await withdraw.handler(as('s1'), { id, reason: '  User answered\n in chat ' });
  assert.deepEqual(out.structuredContent, { id, state: 'resolved', resolvedReason: 'withdrawn', resolvedNote: 'User answered in chat' });
  assert.equal(store.get(id).resolvedReason, 'withdrawn');
  assert.equal(store.get(id).resolvedNote, 'User answered in chat');
  assert.equal(calls.rebuild, 2);
});

test('withdraw_human_request refuses a missing, blank or long reason and leaves the request open', async () => {
  const { request, withdraw, as, store, calls } = setup();
  const { id } = (await request.handler(as('s1'), ask())).structuredContent;
  for (const reason of [undefined, '', '   ', 42, 'x'.repeat(201)]) {
    const out = await withdraw.handler(as('s1'), { id, reason });
    assert.equal(out.isError, true, String(reason));
    assert.match(out.content[0].text, /reason/);
  }
  assert.equal(store.get(id).state, 'open');
  assert.equal(calls.rebuild, 1);
});

test('withdraw_human_request also takes an answered request whose delivery failed', async () => {
  const { request, withdraw, as, store } = setup();
  const { id } = (await request.handler(as('s1'), ask({ options: [{ id: 'a', label: 'A' }] }))).structuredContent;
  store.answer(id, { optionId: 'a' });
  store.setDelivery(id, { delivery: 'failed', deliveryError: 'nope' });
  const out = await withdraw.handler(as('s1'), { id, reason: 'done' });
  assert.equal(out.structuredContent.resolvedReason, 'withdrawn');
});

test('withdraw_human_request refuses another session\'s, an unknown, a status and a closed request', async () => {
  const { request, withdraw, as, store } = setup();
  const { id } = (await request.handler(as('s2'), ask())).structuredContent;
  const status = store.create({ source: 'status', kind: 'blocked', sessionId: 's1', title: 'blocked', dedupeKey: 'status:s1:e1', status: { waitingFor: null, waitingReason: null, episode: 'e1' } });
  for (const bad of [id, 'ibx_nope', status.id, undefined, 42]) {
    const out = await withdraw.handler(as('s1'), { id: bad, reason: 'done' });
    assert.equal(out.isError, true);
    assert.equal(out.content[0].text, 'not your request');
  }
  assert.equal(store.get(id).state, 'open');
  assert.equal(store.get(status.id).state, 'open');

  await withdraw.handler(as('s2'), { id, reason: 'done' });
  const again = await withdraw.handler(as('s2'), { id, reason: 'done' });
  assert.equal(again.isError, true);
  assert.match(again.content[0].text, /already closed \(withdrawn\)/);
});

test('list_my_human_requests lists only the caller\'s agent requests: open, answered and closed in the last 24 h', async () => {
  const { request, withdraw, list, as, store, now } = setup();
  const old = (await request.handler(as('s1'), ask({ title: 'old' }))).structuredContent.id;
  await withdraw.handler(as('s1'), { id: old, reason: 'done' });
  now.tick(RECENT_MS + 1);
  const recent = (await request.handler(as('s1'), ask({ title: 'recent', options: [{ id: 'a', label: 'A' }] }))).structuredContent.id;
  store.answer(recent, { optionId: 'a' });
  store.setDelivery(recent, { delivery: 'delivered' });
  const answered = (await request.handler(as('s1'), ask({ title: 'answered' }))).structuredContent.id;
  store.answer(answered, { text: 'go' });
  const open = (await request.handler(as('s1'), ask({ title: 'open', kind: 'question' }))).structuredContent.id;
  await request.handler(as('s2'), ask({ title: 'not mine' }));
  now.tick(10 * 60_000); // past the rate limit
  const gone = (await request.handler(as('s1'), ask({ title: 'gone' }))).structuredContent.id;
  await withdraw.handler(as('s1'), { id: gone, reason: 'User answered in chat' });
  store.create({ source: 'status', kind: 'blocked', sessionId: 's1', title: 'status', dedupeKey: 'status:s1:e1', status: { waitingFor: null, waitingReason: null, episode: 'e1' } });

  const out = await list.handler(as('s1'), {});
  assert.equal(out.isError, undefined);
  assert.deepEqual(out.structuredContent.requests, [
    { id: gone, kind: 'decision', title: 'gone', state: 'resolved', resolvedReason: 'withdrawn', resolvedNote: 'User answered in chat', answer: null },
    { id: open, kind: 'question', title: 'open', state: 'open', resolvedReason: null, resolvedNote: null, answer: null },
    { id: answered, kind: 'decision', title: 'answered', state: 'answered', resolvedReason: null, resolvedNote: null, answer: { optionId: null, text: 'go' } },
    { id: recent, kind: 'decision', title: 'recent', state: 'resolved', resolvedReason: 'delivered', resolvedNote: null, answer: { optionId: 'a', text: null } },
  ]);
  assert.deepEqual(JSON.parse(out.content[0].text), out.structuredContent);
});

test('request_human_input ignores false compatibility flags on creation and dedupe updates', async () => {
  const { request, as, store } = setup();
  const args = ask({ options: [{ id: 'a', label: 'A' }], allow_free_text: false, dedupe_key: 'choice' });
  const first = await request.handler(as('s1'), args);
  const id = first.structuredContent.id;
  assert.equal(store.get(id).allowFreeText, true);
  const updated = await request.handler(as('s1'), { ...args, body: 'More context' });
  assert.equal(updated.structuredContent.id, id);
  assert.equal(updated.structuredContent.updated, true);
  assert.equal(store.get(id).allowFreeText, true);
  store.answer(id, { text: 'another approach' });
  assert.equal(store.get(id).answer.text, 'another approach');
});
