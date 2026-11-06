import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAgentRequest, normaliseItem, validateAnswer, newItemId, isUnread, needsAction, LIMITS, STATUS_CAUSES } from './item.js';

const ok = (args) => {
  const r = validateAgentRequest(args);
  assert.equal(r.ok, true, r.error);
  return r.value;
};
const bad = (args, re) => {
  const r = validateAgentRequest(args);
  assert.equal(r.ok, false);
  assert.match(r.error, re);
};

test('newItemId is ibx_ plus 12 hex', () => {
  assert.match(newItemId(), /^ibx_[0-9a-f]{12}$/);
  assert.notEqual(newItemId(), newItemId());
});

test('validateAgentRequest fills defaults and maps snake_case', () => {
  assert.deepEqual(ok({ kind: 'question', title: '  Which DB?  ' }), {
    kind: 'question', title: 'Which DB?', body: '', options: [], allowFreeText: true, blocking: true,
    urgency: 'normal', dedupeKey: null, expiresInMinutes: null,
  });
  const v = ok({
    kind: 'decision', title: 'Pick', body: ' why ', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', description: 'bee' }],
    allow_free_text: true, blocking: false, urgency: 'high', dedupe_key: 'k', expires_in_minutes: 60,
  });
  assert.equal(v.body, 'why');
  assert.deepEqual(v.options, [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', description: 'bee' }]);
  assert.deepEqual([v.allowFreeText, v.blocking, v.urgency, v.dedupeKey, v.expiresInMinutes], [true, false, 'high', 'k', 60]);
});

test('titles collapse newlines to spaces', () => {
  assert.equal(ok({ kind: 'action', title: 'Line one\n\r\n  line two\tend' }).title, 'Line one line two end');
});

test('all requests allow free text regardless of the compatibility flag', () => {
  for (const flag of [undefined, false, true]) {
    assert.equal(ok({ kind: 'decision', title: 't', options: [{ id: 'a', label: 'A' }], allow_free_text: flag }).allowFreeText, true);
    assert.equal(normaliseItem(base({ options: [{ id: 'a', label: 'A' }], allowFreeText: flag })).allowFreeText, true);
  }
  assert.equal(ok({ kind: 'decision', title: 't', options: [], allow_free_text: false }).allowFreeText, true);
  assert.equal(ok({ kind: 'decision', title: 't', options: [{ id: 'x', label: 'X' }] }).allowFreeText, true);
});

test('options get unique ids', () => {
  const v = ok({ kind: 'decision', title: 't', options: [{ label: 'Ship it!' }, { label: 'Ship it' }, { label: '!!!' }, { id: 'option-4', label: 'x' }, { label: 'y' }] });
  const ids = v.options.map((o) => o.id);
  assert.deepEqual(ids.slice(0, 3), ['ship-it', 'option-2', 'option-3']);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ok({ kind: 'decision', title: 't', options: [{ label: 'A' }, { id: 'a', label: 'B' }] }).options.map((o) => o.id), ['option-1', 'a']);
  bad({ kind: 'decision', title: 't', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }, /used twice/);
});

test('validateAgentRequest enforces every limit', () => {
  const long = (n) => 'x'.repeat(n);
  bad(null, /object/);
  bad({ kind: 'blocked', title: 't' }, /kind/);
  bad({ kind: 'nope', title: 't' }, /kind/);
  bad({ kind: 'question' }, /title is required/);
  bad({ kind: 'question', title: ' \n ' }, /must not be empty/);
  bad({ kind: 'question', title: long(LIMITS.title + 1) }, /at most 120/);
  ok({ kind: 'question', title: long(LIMITS.title) });
  bad({ kind: 'question', title: 't', body: long(LIMITS.body + 1) }, /body/);
  bad({ kind: 'question', title: 't', body: 3 }, /body must be a string/);
  bad({ kind: 'decision', title: 't', options: 'a' }, /options must be an array/);
  bad({ kind: 'decision', title: 't', options: Array.from({ length: 7 }, (_, i) => ({ label: `o${i}` })) }, /at most 6/);
  bad({ kind: 'decision', title: 't', options: [{ id: 'A', label: 'a' }] }, /id must match/);
  bad({ kind: 'decision', title: 't', options: [{ id: '-a', label: 'a' }] }, /id must match/);
  bad({ kind: 'decision', title: 't', options: [{ id: long(33), label: 'a' }] }, /id must match/);
  bad({ kind: 'decision', title: 't', options: [{ id: 'a' }] }, /label is required/);
  bad({ kind: 'decision', title: 't', options: [{ id: 'a', label: long(81) }] }, /label must be at most 80/);
  bad({ kind: 'decision', title: 't', options: [{ id: 'a', label: 'a', description: long(301) }] }, /description/);
  bad({ kind: 'decision', title: 't', allow_free_text: 'yes' }, /allow_free_text/);
  bad({ kind: 'decision', title: 't', blocking: 1 }, /blocking/);
  bad({ kind: 'decision', title: 't', urgency: 'urgent' }, /urgency/);
  bad({ kind: 'decision', title: 't', dedupe_key: '' }, /dedupe_key/);
  bad({ kind: 'decision', title: 't', dedupe_key: long(121) }, /dedupe_key/);
  for (const m of [4, 10081, 5.5, '60']) bad({ kind: 'decision', title: 't', expires_in_minutes: m }, /expires_in_minutes/);
  ok({ kind: 'decision', title: 't', expires_in_minutes: 5 });
  ok({ kind: 'decision', title: 't', expires_in_minutes: 10080 });
});

const base = (over = {}) => ({
  id: 'ibx_000000000001', source: 'agent', kind: 'decision', sessionId: 's1', title: 't', dedupeKey: 'agent:s1:k',
  state: 'open', createdAt: 10, updatedAt: 10, ...over,
});

test('normaliseItem fills a complete item and clips text', () => {
  const item = normaliseItem(base({ title: `a\nb${'x'.repeat(200)}`, body: 'y'.repeat(9000), options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'dup' }, { id: 'BAD', label: 'b' }], extra: 1 }));
  assert.equal(item.title.length, LIMITS.title);
  assert.ok(item.title.startsWith('a b') && item.title.endsWith('…'));
  assert.equal(item.body.length, LIMITS.body);
  assert.deepEqual(item.options, [{ id: 'a', label: 'A' }]);
  assert.equal(item.allowFreeText, true);
  assert.equal(item.blocking, true);
  assert.equal('extra' in item, false);
  assert.deepEqual(Object.keys(item), [
    'id', 'source', 'kind', 'sessionId', 'taskId', 'title', 'body', 'options', 'allowFreeText', 'blocking', 'urgency',
    'dedupeKey', 'state', 'resolvedReason', 'createdAt', 'updatedAt', 'readAt', 'expiresAt', 'answer',
  ]);
});

test('normaliseItem keeps the status/source invariants', () => {
  const status = normaliseItem(base({ source: 'status', kind: 'blocked', options: [{ id: 'a', label: 'A' }], blocking: false, expiresAt: 5, status: { waitingFor: 'permission', waitingReason: null, episode: 'e1' } }));
  assert.deepEqual([status.options, status.allowFreeText, status.blocking, status.expiresAt], [[], true, true, null]);
  assert.deepEqual(status.status, { waitingFor: 'permission', waitingReason: null, episode: 'e1', cause: 'other' });
  assert.throws(() => normaliseItem(base({ kind: 'blocked' })), /blocked/);
  assert.throws(() => normaliseItem(base({ source: 'status', kind: 'decision', status: { episode: 'e' } })), /blocked/);
  assert.throws(() => normaliseItem(base({ source: 'status', kind: 'blocked' })), /needs its status/);
  assert.throws(() => normaliseItem(base({ source: 'status', kind: 'blocked', state: 'answered', answer: {}, status: { episode: 'e' } })), /cannot be answered/);
  assert.throws(() => normaliseItem(base({ state: 'resolved' })), /resolvedReason/);
  assert.throws(() => normaliseItem(base({ state: 'answered' })), /needs its answer/);
  assert.throws(() => normaliseItem(base({ id: 'x' })), /id/);
  assert.throws(() => normaliseItem(base({ sessionId: '' })), /sessionId/);
  assert.throws(() => normaliseItem(base({ title: '  ' })), /title/);
  assert.throws(() => normaliseItem(base({ dedupeKey: undefined })), /dedupeKey/);
  assert.equal(normaliseItem(base({ answer: { text: 'x' } })).answer, null);
});

test('validateAnswer checks options, free text and length', () => {
  const opts = normaliseItem(base({ options: [{ id: 'a', label: 'A' }] }));
  const free = normaliseItem(base({ options: [{ id: 'a', label: 'A' }], allowFreeText: true }));
  const text = normaliseItem(base());
  assert.deepEqual(validateAnswer(opts, { optionId: 'a' }), { optionId: 'a', text: null });
  assert.deepEqual(validateAnswer(free, { optionId: 'a', text: ' why ' }), { optionId: 'a', text: 'why' });
  assert.deepEqual(validateAnswer(free, { text: 'just text' }), { optionId: null, text: 'just text' });
  assert.deepEqual(validateAnswer(text, { text: 'go' }), { optionId: null, text: 'go' });
  assert.throws(() => validateAnswer(opts, { optionId: 'z' }), /not one of/);
  assert.deepEqual(validateAnswer(opts, { optionId: 'a', text: ' why ' }), { optionId: 'a', text: 'why' });
  assert.deepEqual(validateAnswer(opts, { optionId: 'a', text: '  \n ' }), { optionId: 'a', text: null });
  assert.equal(validateAnswer(opts, { optionId: 'a', text: 'x'.repeat(4000) }).text.length, 4000);
  assert.throws(() => validateAnswer(opts, { optionId: 'a', text: 'x'.repeat(4001) }), /at most 4000/);
  const legacy = { ...opts, allowFreeText: false };
  assert.deepEqual(validateAnswer(legacy, { text: ' another approach ' }), { optionId: null, text: 'another approach' });
  assert.equal(validateAnswer(legacy, { text: 'x'.repeat(4000) }).text.length, 4000);
  assert.throws(() => validateAnswer(legacy, { text: 'x'.repeat(4001) }), /at most 4000/);
  assert.throws(() => validateAnswer(legacy, { text: ' \n ' }), /choose an option/);
  assert.throws(() => validateAnswer(free, { optionId: 'z', text: 'a note' }), /not one of/);
  assert.throws(() => validateAnswer(opts, {}), /choose an option/);
  assert.throws(() => validateAnswer(text, { text: '  ' }), /needs some text/);
  assert.throws(() => validateAnswer(text, { optionId: 'a' }), /not one of/);
  assert.throws(() => validateAnswer(text, { text: 'x'.repeat(4001) }), /at most 4000/);
});

test('unread and needs-action', () => {
  const open = normaliseItem(base());
  assert.equal(isUnread(open), true);
  assert.equal(isUnread({ ...open, readAt: 1 }), false);
  assert.equal(needsAction(open), true);
  const answered = normaliseItem(base({ state: 'answered', answer: { delivery: 'failed', at: 1 } }));
  assert.equal(isUnread(answered), false);
  assert.equal(needsAction(answered), true);
  assert.equal(needsAction({ ...answered, answer: { ...answered.answer, delivery: 'pending' } }), false);
});

test('normaliseItem keeps a valid status cause and reads a missing or invalid one as other', () => {
  const withCause = (cause) => normaliseItem(base({ source: 'status', kind: 'blocked', status: { waitingFor: 'x', waitingReason: null, episode: 'e1', cause } })).status.cause;
  for (const c of STATUS_CAUSES) assert.equal(withCause(c), c);
  assert.deepEqual(STATUS_CAUSES, ['permission', 'question', 'trust', 'sign-in', 'update', 'container', 'api-error', 'other']);
  for (const bad of [undefined, null, '', 'Permission', 'blocked', 3, {}]) assert.equal(withCause(bad), 'other');
  assert.equal(normaliseItem(base()).status, undefined, 'an agent item has no status');
});
