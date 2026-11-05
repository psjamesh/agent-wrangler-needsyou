import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inboxHandlers } from './index.js';
import { MAX_DELIVERY_ATTEMPTS } from './answer.js';
import { fakeHost, seq, clock, tempStoreFile } from '../test-helpers.js';

const handler = (type) => inboxHandlers.find((h) => h.type === type).handler;
const answer = handler('inbox-answer');
const retry = handler('inbox-retry');
const setCanAsk = handler('inbox-set-can-ask');

function setup(opts = {}) {
  const f = fakeHost({ sessions: [{ sessionId: 's1' }, { sessionId: 'w1', spawnedBy: 's1' }], now: clock(), idGen: seq(), ...opts });
  const withOptions = f.store.create({
    source: 'agent', kind: 'decision', sessionId: 's1', title: 'Pick one',
    options: [{ id: 'a', label: 'Option A' }, { id: 'b', label: 'Option B' }],
  });
  const freeText = f.store.create({ source: 'agent', kind: 'question', sessionId: 's1', title: 'Which region?' });
  return { ...f, withOptions, freeText };
}

test('the WS-2 handler types are registered', () => {
  const types = inboxHandlers.map((h) => h.type);
  for (const t of ['inbox-answer', 'inbox-retry', 'inbox-set-can-ask']) assert.ok(types.includes(t), t);
});

test('inbox-answer with an option delivers it and resolves the item', async () => {
  const { host, store, calls, withOptions } = setup();
  await answer({ type: 'inbox-answer', id: withOptions.id, optionId: 'b' }, host);
  const item = store.get(withOptions.id);
  assert.equal(item.state, 'resolved');
  assert.equal(item.resolvedReason, 'delivered');
  assert.deepEqual(calls.deliver.map((c) => c.sessionId), ['s1']);
  assert.match(calls.deliver[0].text, /^\[Needs you\] .*\nChoice: Option B \(b\)$/);
  assert.equal(calls.rebuild, 1);
});

test('fixed-choice answers persist and deliver a note for every agent kind', async () => {
  const file = tempStoreFile();
  const { host, store, calls } = setup({ file });
  const ids = [];
  for (const kind of ['decision', 'approval', 'question', 'action']) {
    const item = store.create({ source: 'agent', kind, sessionId: 's1', title: 'Pick', options: [{ id: 'a', label: 'A' }] });
    ids.push(item.id);
    assert.equal(item.allowFreeText, false);
    await answer({ id: item.id, optionId: 'a', text: ' after lunch ' }, host);
    const saved = store.get(item.id);
    assert.equal(saved.state, 'resolved');
    assert.equal(saved.answer.optionId, 'a');
    assert.equal(saved.answer.text, 'after lunch');
    assert.match(calls.deliver.at(-1).text, /\nChoice: A \(a\)\nNote: after lunch$/);
  }
  assert.equal(calls.rebuild, 4);
  const reloaded = fakeHost({ file }).store;
  for (const id of ids) {
    assert.equal(reloaded.get(id).answer.optionId, 'a');
    assert.equal(reloaded.get(id).answer.text, 'after lunch');
  }
});

test('inbox-answer with free text, and with both when free text is allowed', async () => {
  const { host, store, calls, freeText } = setup();
  await answer({ id: freeText.id, text: 'eu-west-1' }, host);
  assert.equal(store.get(freeText.id).answer.text, 'eu-west-1');
  assert.match(calls.deliver[0].text, /\nNote: eu-west-1$/);

  const both = store.create({ source: 'agent', kind: 'decision', sessionId: 's1', title: 'Both', options: [{ id: 'a', label: 'A' }], allowFreeText: true });
  await answer({ id: both.id, optionId: 'a', text: 'and tidy up' }, host);
  assert.match(calls.deliver[1].text, /\nChoice: A \(a\)\nNote: and tidy up$/);
});

test('inbox-answer refuses invalid answers without delivering', async () => {
  const { host, store, calls, withOptions, freeText } = setup();
  const cases = [
    [{ id: withOptions.id, optionId: 'nope', text: 'a note' }, /not one of this request's options/],
    [{ id: withOptions.id, text: 'free text' }, /not free text/],
    [{ id: withOptions.id, optionId: 'a', text: 'x'.repeat(4001) }, /at most 4000/],
    [{ id: withOptions.id }, /choose an option/],
    [{ id: freeText.id }, /needs some text/],
    [{ id: freeText.id, text: '   ' }, /needs some text/],
    [{ id: freeText.id, text: 'x'.repeat(4001) }, /at most 4000/],
    [{ id: 'ibx_nope', optionId: 'a' }, /unknown inbox item/],
    [{}, /needs an item id/],
    [null, /needs an item id/],
  ];
  for (const [msg, re] of cases) await assert.rejects(answer(msg, host), re);
  assert.equal(calls.deliver.length, 0);
  assert.equal(calls.rebuild, 0);
  assert.equal(store.get(withOptions.id).state, 'open');
});

test('inbox-answer takes only an open agent request', async () => {
  const { host, store, withOptions } = setup();
  const status = store.create({ source: 'status', kind: 'blocked', sessionId: 's1', title: 'blocked', dedupeKey: 'status:s1:e1', status: { waitingFor: null, waitingReason: null, episode: 'e1' } });
  await assert.rejects(answer({ id: status.id, text: 'x' }, host), /only an agent request/);
  await answer({ id: withOptions.id, optionId: 'a' }, host);
  await assert.rejects(answer({ id: withOptions.id, optionId: 'a' }, host), /resolved, not open/);
});

test('a failed delivery stays answered with its error, then a retry delivers it', async () => {
  let refuse = true;
  const { host, store, calls, withOptions } = setup({ deliver: () => (refuse ? { mode: 'error', error: 'No session s1.' } : { mode: 'live' }) });
  await answer({ id: withOptions.id, optionId: 'a' }, host);
  let item = store.get(withOptions.id);
  assert.equal(item.state, 'answered');
  assert.equal(item.answer.delivery, 'failed');
  assert.equal(item.answer.deliveryError, 'No session s1.');
  assert.equal(calls.rebuild, 1);

  refuse = false;
  await retry({ id: withOptions.id }, host);
  item = store.get(withOptions.id);
  assert.equal(item.state, 'resolved');
  assert.equal(item.resolvedReason, 'delivered');
  assert.equal(item.answer.attempts, 2);
  assert.equal(calls.deliver.length, 2);
  assert.equal(calls.deliver[0].text, calls.deliver[1].text);
  assert.equal(calls.rebuild, 2);
});

test('inbox-retry is capped at five attempts in total', async () => {
  const { host, store, calls, withOptions } = setup({ deliver: () => ({ mode: 'error', error: 'nope' }) });
  await answer({ id: withOptions.id, optionId: 'a' }, host);
  for (let i = 1; i < MAX_DELIVERY_ATTEMPTS; i++) await retry({ id: withOptions.id }, host);
  assert.equal(store.get(withOptions.id).answer.attempts, MAX_DELIVERY_ATTEMPTS);
  await assert.rejects(retry({ id: withOptions.id }, host), /delivery keeps failing — open the session/);
  assert.equal(calls.deliver.length, MAX_DELIVERY_ATTEMPTS);
});

test('inbox-retry takes only an answered item whose delivery failed', async () => {
  const { host, withOptions } = setup();
  await assert.rejects(retry({ id: withOptions.id }, host), /only a failed delivery/);
  await answer({ id: withOptions.id, optionId: 'a' }, host);
  await assert.rejects(retry({ id: withOptions.id }, host), /only a failed delivery/);
  await assert.rejects(retry({ id: 'ibx_nope' }, host), /unknown inbox item/);
  await assert.rejects(retry({}, host), /needs an item id/);
});

test('inbox-set-can-ask sets, flips and clears an override for a known session', async () => {
  const { host, store, calls } = setup();
  await setCanAsk({ sessionId: 'w1', allowed: true }, host);
  assert.equal(store.canAskOverride('w1'), true);
  await setCanAsk({ sessionId: 's1', allowed: false }, host);
  assert.equal(store.canAskOverride('s1'), false);
  await setCanAsk({ sessionId: 'w1', allowed: null }, host);
  assert.equal(store.canAskOverride('w1'), null);
  assert.equal(calls.rebuild, 3);
});

test('inbox-set-can-ask validates its payload and the session', async () => {
  const { host, store, calls } = setup();
  for (const [msg, re] of [
    [{ sessionId: 'nobody', allowed: true }, /unknown session/],
    [{ sessionId: 'w1' }, /true, false or null/],
    [{ sessionId: 'w1', allowed: 'yes' }, /true, false or null/],
    [{ allowed: true }, /needs a sessionId/],
    [null, /needs a sessionId/],
  ]) await assert.rejects(setCanAsk(msg, host), re);
  assert.equal(store.canAskOverride('w1'), null);
  assert.equal(calls.rebuild, 0);
});
