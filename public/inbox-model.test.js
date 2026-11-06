import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  queueOrder, queueTier, closedOrder, closedAt, closedLabel, filteredList, sessionName, kindLabel, resolvedLabel, ageLabel, waitingLabel,
  sessionMeta, spawnedByLabel, nextAfter, answerPayload, stopsWork, causeOf, itemLabel, itemIconKey, isAlarm,
  isUrgent, guidanceFor, terminalText, hasDone, donePayload, deliveryProblem,
} from './inbox-model.js';
import { ICONS } from './icons.js';

import { item } from '../test/fixtures/inbox.js';

const failed = (over = {}) => item({ state: 'answered', answer: { optionId: null, text: 'x', at: 1, delivery: 'failed', deliveryError: 'gone', attempts: 1 }, ...over });

test('queueOrder puts every tier in cost-of-waiting order', () => {
  const nonBlocking = item({ blocking: false, createdAt: 1 });
  const fail = failed({ createdAt: 0 });
  const normal = item({ createdAt: 2 });
  const high = item({ urgency: 'high', createdAt: 3 });
  const blocked = item({ source: 'status', kind: 'blocked', createdAt: 4 });
  const highFyi = item({ urgency: 'high', blocking: false, createdAt: 5 });
  const order = queueOrder([nonBlocking, fail, normal, high, blocked, highFyi]);
  // High urgency sorts with the stopped sessions, blocking or not (F4).
  assert.deepEqual(order.map((i) => i.id), [high, blocked, highFyi, normal, nonBlocking, fail].map((i) => i.id));
  assert.deepEqual(order.map(queueTier), [0, 0, 0, 1, 2, 3]);
});

test('queueOrder breaks ties by age, oldest first, then by id', () => {
  const young = item({ source: 'status', kind: 'blocked', createdAt: 50 });
  const old = item({ source: 'status', kind: 'blocked', createdAt: 10 });
  const twinA = item({ id: 'ibx_a', createdAt: 5 });
  const twinB = item({ id: 'ibx_b', createdAt: 5 });
  const highNew = item({ urgency: 'high', createdAt: 99 });
  const highOld = item({ urgency: 'high', createdAt: 1 });
  assert.deepEqual(queueOrder([twinB, young, highNew, twinA, old, highOld]).map((i) => i.id),
    [highOld.id, old.id, young.id, highNew.id, 'ibx_a', 'ibx_b']);
});

test('queueOrder leaves out resolved items and answers still being delivered', () => {
  const pending = item({ state: 'answered', answer: { delivery: 'pending' } });
  const done = item({ state: 'resolved', resolvedReason: 'delivered' });
  const open = item();
  assert.deepEqual(queueOrder([pending, done, open]).map((i) => i.id), [open.id]);
});

test('closedAt is updatedAt for a resolved item and answer.at for one still sending', () => {
  assert.equal(closedAt(item({ state: 'resolved', resolvedReason: 'expired', createdAt: 1, updatedAt: 70 })), 70);
  assert.equal(closedAt(item({ state: 'answered', updatedAt: 90, answer: { delivery: 'pending', at: 80 } })), 80);
});

test('closedOrder sorts by when each item closed, newest first, not by when it was asked', () => {
  // Asked first, closed last: it leads.
  const askedFirst = item({ state: 'resolved', resolvedReason: 'delivered', createdAt: 1, updatedAt: 50 });
  const askedLast = item({ state: 'resolved', resolvedReason: 'dismissed', createdAt: 40, updatedAt: 45 });
  const sending = item({ state: 'answered', createdAt: 2, updatedAt: 99, answer: { delivery: 'pending', at: 48 } });
  const open = item({ createdAt: 0 });
  const fail = failed({ updatedAt: 100 });
  assert.deepEqual(closedOrder([askedLast, open, sending, fail, askedFirst]).map((i) => i.id),
    [askedFirst.id, sending.id, askedLast.id], 'open items and failed deliveries are not closed');
  const twinB = item({ id: 'ibx_b', state: 'resolved', updatedAt: 5 });
  const twinA = item({ id: 'ibx_a', state: 'resolved', updatedAt: 5 });
  assert.deepEqual(closedOrder([twinB, twinA]).map((i) => i.id), ['ibx_a', 'ibx_b'], 'id breaks a tie');
});

test('filteredList: Open is the queue, Closed the closed order, All the one then the other', () => {
  const blocked = item({ source: 'status', kind: 'blocked', createdAt: 9 });
  const normal = item({ createdAt: 1 });
  const fail = failed({ createdAt: 0 });
  const old = item({ state: 'resolved', resolvedReason: 'delivered', updatedAt: 10 });
  const recent = item({ state: 'resolved', resolvedReason: 'expired', updatedAt: 20 });
  const all = [old, fail, normal, recent, blocked];
  assert.deepEqual(filteredList('open', all).map((i) => i.id), [blocked.id, normal.id, fail.id]);
  assert.deepEqual(filteredList('closed', all).map((i) => i.id), [recent.id, old.id]);
  assert.deepEqual(filteredList('all', all).map((i) => i.id), [blocked.id, normal.id, fail.id, recent.id, old.id]);
  assert.deepEqual(filteredList('bogus', all).map((i) => i.id), filteredList('open', all).map((i) => i.id), 'an unknown filter is Open');
});

test('closedLabel says when it closed, or that it is sending', () => {
  assert.equal(closedLabel(item({ state: 'resolved', updatedAt: 0 }), 5 * 60_000), 'closed 5m ago');
  assert.equal(closedLabel(item({ state: 'answered', answer: { delivery: 'pending', at: 0 } }), 5 * 60_000), 'sending');
});

test("sessionName falls back to the core card's label, then name, then the short id", () => {
  const inbox = { items: [], sessions: {} };
  assert.equal(sessionName({ inbox, sessions: [{ sessionId: 'b4c9473a-7111', label: 'Fix the login page' }] }, 'b4c9473a-7111'), 'Fix the login page');
  assert.equal(sessionName({ inbox, sessions: [{ sessionId: 'b4c9473a-7111', name: 'Named' }] }, 'b4c9473a-7111'), 'Named');
  assert.equal(sessionName({ inbox, sessions: [{ sessionId: 'b4c9473a-7111', label: '  ' }] }, 'b4c9473a-7111'), 'b4c9473a');
  const withInbox = { inbox: { items: [], sessions: { s: { name: 'Ours' } } }, sessions: [{ sessionId: 's', label: 'Core' }] };
  assert.equal(sessionName(withInbox, 's'), 'Ours', "graph.inbox's name comes first");
  const long = 'x'.repeat(80);
  const clipped = sessionName({ inbox, sessions: [{ sessionId: 's', label: long }] }, 's');
  assert.equal(clipped.length, 60);
  assert.ok(clipped.endsWith('…'));
});

test('labels', () => {
  assert.equal(kindLabel('blocked'), 'Blocked');
  assert.equal(kindLabel('approval'), 'Approval');
  const reasons = {
    delivered: 'answered', withdrawn: 'withdrawn by agent', 'answered-elsewhere': 'answered in the session',
    'status-cleared': 'resolved in the session', dismissed: 'dismissed', 'session-archived': 'session archived', expired: 'expired',
  };
  for (const [reason, label] of Object.entries(reasons)) assert.equal(resolvedLabel({ state: 'resolved', resolvedReason: reason }), label);
  assert.equal(resolvedLabel({ state: 'answered' }), 'sending');
});

test('ages read as waiting time', () => {
  assert.equal(ageLabel(0, 30_000), '<1m');
  assert.equal(ageLabel(0, 12 * 60_000), '12m');
  assert.equal(ageLabel(0, 3 * 3_600_000), '3h');
  assert.equal(ageLabel(0, 50 * 3_600_000), '2d');
  assert.equal(waitingLabel({ createdAt: 0 }, 12 * 60_000), 'waiting 12m');
});

test('session meta and spawned-by come from graph.inbox.sessions, falling back to core sessions', () => {
  const graph = {
    sessions: [{ sessionId: 'orch', name: 'Orchestrator' }],
    inbox: { items: [], sessions: { s1: { name: 'Worker', taskName: 'Auth', spawnedBy: 'orch' } } },
  };
  assert.equal(sessionMeta(graph, { sessionId: 's1' }), 'Worker · Auth');
  assert.equal(spawnedByLabel(graph, { sessionId: 's1', source: 'status' }), 'spawned by Orchestrator');
  assert.equal(spawnedByLabel(graph, { sessionId: 's1', source: 'agent' }), '');
});

test('nextAfter picks the item that followed the one that left', () => {
  const ids = (xs) => xs.map((id) => ({ id }));
  assert.equal(nextAfter(['a', 'b', 'c'], 'b', ids(['a', 'c'])), 'c');
  assert.equal(nextAfter(['a', 'b', 'c'], 'c', ids(['a', 'b'])), 'b');
  assert.equal(nextAfter(['a', 'b'], 'a', ids(['x', 'b'])), 'b');
  assert.equal(nextAfter(['a'], 'a', []), null);
});

test('answerPayload mirrors the store rules', () => {
  const opts = [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }];
  const choiceOnly = item({ options: opts, allowFreeText: false });
  assert.equal(answerPayload(choiceOnly, {}), null);
  assert.deepEqual(answerPayload(choiceOnly, { optionId: 'yes', text: ' because ' }), { type: 'inbox-answer', id: choiceOnly.id, optionId: 'yes', text: 'because' });
  assert.equal(answerPayload(choiceOnly, { optionId: 'nope' }), null);
  assert.deepEqual(answerPayload(choiceOnly, { text: ' another approach ' }), { type: 'inbox-answer', id: choiceOnly.id, text: 'another approach' });
  assert.equal(answerPayload(choiceOnly, { text: ' \n ' }), null);
  assert.equal(answerPayload(choiceOnly, { text: 'x'.repeat(4000) }).text.length, 4000);
  assert.equal(answerPayload(choiceOnly, { text: 'x'.repeat(4001) }), null);
  assert.equal(answerPayload(choiceOnly, { optionId: 'nope', text: 'another approach' }), null);
  assert.deepEqual(answerPayload(choiceOnly, { optionId: 'yes', text: '  \n ' }), { type: 'inbox-answer', id: choiceOnly.id, optionId: 'yes' });
  assert.equal(answerPayload(choiceOnly, { optionId: 'yes', text: 'x'.repeat(4001) }), null);
  assert.equal(answerPayload(choiceOnly, { optionId: 'yes', text: 'x'.repeat(4000) }).text.length, 4000);
  const both = item({ options: opts, allowFreeText: true });
  assert.equal(answerPayload(both, { optionId: 'nope', text: 'a note' }), null);
  assert.deepEqual(answerPayload(both, { optionId: 'no', text: ' because ' }), { type: 'inbox-answer', id: both.id, optionId: 'no', text: 'because' });
  assert.deepEqual(answerPayload(both, { text: 'neither' }), { type: 'inbox-answer', id: both.id, text: 'neither' });
  const text = item();
  assert.equal(answerPayload(text, { text: '   ' }), null);
  assert.equal(answerPayload(text, { text: 'x'.repeat(4001) }), null);
});

test('only blocked and blocking items stop work', () => {
  assert.equal(stopsWork(item({ source: 'status', kind: 'blocked', blocking: true })), true);
  assert.equal(stopsWork(item({ blocking: true })), true);
  assert.equal(stopsWork(item({ blocking: false })), false);
});

test('a status item is labelled by its cause; only real failures are red', () => {
  const s = (cause, waitingReason = null) => item({ source: 'status', kind: 'blocked', status: { waitingFor: 'x', waitingReason, episode: 'e', ...(cause ? { cause } : {}) } });
  const table = [
    ['permission', 'Permission', false, 'cause-permission'],
    ['question', 'Question', false, 'cause-question'],
    ['trust', 'Trust', false, 'cause-trust'],
    ['sign-in', 'Sign-in', false, 'cause-sign-in'],
    ['update', 'Restart', false, 'cause-update'],
    ['container', 'Blocked', true, 'cause-container'],
    ['api-error', 'Blocked', true, 'cause-api-error'],
    ['other', 'Waiting', false, 'cause-other'],
  ];
  for (const [cause, label, red, icon] of table) {
    const it = s(cause, cause === 'api-error' ? 'api-error-blocking' : null);
    assert.equal(causeOf(it), cause);
    assert.equal(itemLabel(it), label, cause);
    assert.equal(isAlarm(it), red, cause);
    assert.equal(itemIconKey(it), icon);
    assert.ok(ICONS[icon], `${icon} has an icon`);
    assert.match(guidanceFor(it), /Open the session/);
  }
  assert.equal(itemLabel(s('api-error', 'api-error')), 'Error', 'a transient API error');
  assert.equal(isAlarm(s('api-error', 'api-error')), true);
  // Made before 0.1.2, or a value we don't know: 'other'.
  assert.equal(causeOf(s(null)), 'other');
  assert.equal(itemLabel(s(null)), 'Waiting');
  assert.equal(causeOf(s('bogus')), 'other');
  // An agent request keeps its kind's label and is never red.
  assert.equal(itemLabel(item({ kind: 'approval' })), 'Approval');
  assert.equal(itemIconKey(item({ kind: 'approval' })), 'approval');
  assert.equal(isAlarm(item()), false);
});

test('the guidance sentence per cause', () => {
  const g = (cause) => guidanceFor({ source: 'status', status: { cause } });
  assert.equal(g('question'), 'The agent asked you a question in its terminal. Open the session to answer it.');
  assert.equal(g('trust'), 'The agent is asking whether to trust this folder. Open the session to confirm.');
  assert.equal(g('other'), 'The session is waiting for you. Open the session to see what it needs.');
});

test("terminalText leaves out core's bare phrases", () => {
  for (const phrase of ['permission prompt', 'input needed', 'trust dialog', ' Input needed ']) assert.equal(terminalText({ body: phrase }), '');
  assert.equal(terminalText({ body: 'Bash: npm publish' }), 'Bash: npm publish');
  assert.equal(terminalText({ body: '' }), '');
});

test('urgency marks only an agent request', () => {
  assert.equal(isUrgent(item({ urgency: 'high' })), true);
  assert.equal(isUrgent(item()), false);
  assert.equal(isUrgent(item({ source: 'status', kind: 'blocked', urgency: 'high' })), false);
});

test('Done is for an action with no options and sends "done", with any note', () => {
  const a = item({ kind: 'action' });
  assert.equal(hasDone(a), true);
  assert.equal(hasDone(item({ kind: 'action', options: [{ id: 'x', label: 'X' }] })), false);
  assert.equal(hasDone(item({ kind: 'question' })), false);
  assert.deepEqual(donePayload(a), { type: 'inbox-answer', id: a.id, text: 'done' });
  assert.deepEqual(donePayload(a, ' installed on staging too '), { type: 'inbox-answer', id: a.id, text: 'done\n\ninstalled on staging too' });
  assert.equal(donePayload(a, 'x'.repeat(4000)), null);
});

test('a failed delivery reads in plain words with the session name', () => {
  const graph = { sessions: [], inbox: { items: [], sessions: { s1: { name: 'Old spike' } } } };
  const f = (deliveryError) => item({ state: 'answered', answer: { delivery: 'failed', deliveryError, at: 1 } });
  assert.deepEqual(deliveryProblem(graph, f('Session s1 is archived; restore it')), {
    archived: true, text: 'Not delivered: Old spike is archived. Restore it from the archive, then retry, or dismiss this.',
  });
  assert.deepEqual(deliveryProblem(graph, f('no tmux')), { archived: false, text: 'Not delivered: no tmux' });
  assert.equal(deliveryProblem({ ...graph, history: [{ sessionId: 's1' }] }, f('refused')).archived, true);
  assert.equal(waitingLabel(f('x'), 3 * 60_000), 'answered 2m ago');
});
