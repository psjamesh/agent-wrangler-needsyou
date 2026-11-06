import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { InboxStore, MAX_ITEMS } from './store.js';
import { tempStoreFile, seq, clock } from './test-helpers.js';

function make({ file = tempStoreFile(), settings = {}, now = clock(), idGen = seq(), log } = {}) {
  const logs = [];
  const store = new InboxStore({ file, now, idGen, getSettings: () => settings, log: log ?? ((m) => logs.push(m)) });
  return { store, file, now, logs, settings };
}

const agent = (over = {}) => ({ source: 'agent', kind: 'decision', sessionId: 's1', taskId: 't1', title: 'Pick a DB', body: 'why', options: [{ id: 'pg', label: 'Postgres' }, { id: 'my', label: 'MySQL' }], allowFreeText: true, ...over });
const status = (over = {}) => ({ source: 'status', kind: 'blocked', sessionId: 's1', title: 'Waiting on permission', dedupeKey: 'status:s1:e1', status: { waitingFor: 'permission', waitingReason: 'permission', episode: 'e1' }, ...over });

test('create fills the store-owned fields and a per-request dedupeKey', () => {
  const { store, now } = make();
  const item = store.create(agent());
  assert.equal(item.id, 'ibx_000000000001');
  assert.deepEqual(
    [item.state, item.resolvedReason, item.createdAt, item.updatedAt, item.readAt, item.answer, item.dedupeKey, item.blocking, item.urgency],
    ['open', null, now(), now(), null, null, 'agent:s1:ibx_000000000001', true, 'normal'],
  );
  assert.deepEqual(store.get(item.id), item);
  assert.throws(() => store.create({ ...agent(), state: 'resolved' }), /does not take "state"/);
  assert.throws(() => store.create(agent({ kind: 'blocked' })), /blocked/);
  assert.throws(() => store.create(status({ dedupeKey: undefined })), /dedupeKey/);
});

test('returned items are copies', () => {
  const { store } = make();
  const item = store.create(agent());
  item.title = 'changed';
  store.snapshot()[0].options.push({ id: 'x', label: 'x' });
  assert.equal(store.get(item.id).title, 'Pick a DB');
  assert.equal(store.get(item.id).options.length, 2);
});

test('answer -> deliver resolves as delivered', () => {
  const { store, now } = make();
  const { id } = store.create(agent());
  now.tick(5);
  const answered = store.answer(id, { optionId: 'pg', text: 'go' });
  assert.equal(answered.state, 'answered');
  assert.deepEqual(answered.answer, { optionId: 'pg', text: 'go', at: now(), delivery: 'pending', deliveryError: null, attempts: 0 });
  now.tick(5);
  const done = store.setDelivery(id, { delivery: 'delivered' });
  assert.deepEqual([done.state, done.resolvedReason, done.answer.delivery, done.answer.attempts, done.updatedAt], ['resolved', 'delivered', 'delivered', 1, now()]);
});

test('a failed delivery stays answered with its error, and can be retried', () => {
  const { store } = make();
  const { id } = store.create(agent());
  store.answer(id, { optionId: 'my' });
  const failed = store.setDelivery(id, { delivery: 'failed', deliveryError: 'x'.repeat(900) });
  assert.deepEqual([failed.state, failed.answer.delivery, failed.answer.deliveryError.length, failed.answer.attempts], ['answered', 'failed', 500, 1]);
  assert.equal(store.setDelivery(id, { delivery: 'pending' }).answer.attempts, 1);
  assert.equal(store.setDelivery(id, { delivery: 'failed', deliveryError: 'again' }).answer.attempts, 2);
  assert.equal(store.setDelivery(id, { delivery: 'delivered' }).answer.attempts, 3);
});

test('illegal transitions throw', () => {
  const { store } = make();
  const { id } = store.create(agent());
  assert.throws(() => store.setDelivery(id, { delivery: 'delivered' }), /not answered/);
  assert.throws(() => store.answer(id, { optionId: 'nope' }), /not one of/);
  store.answer(id, { optionId: 'pg' });
  assert.throws(() => store.answer(id, { optionId: 'pg' }), /answered, not open/);
  assert.throws(() => store.setDelivery(id, { delivery: 'sent' }), /delivery must be/);
  store.setDelivery(id, { delivery: 'delivered' });
  assert.throws(() => store.answer(id, { optionId: 'pg' }), /resolved, not open/);
  assert.throws(() => store.setDelivery(id, { delivery: 'failed' }), /not answered/);
  const s = store.create(status());
  assert.throws(() => store.answer(s.id, { text: 'x' }), /only an agent request/);
  assert.throws(() => store.answer('ibx_nope', { text: 'x' }), /unknown inbox item/);
  assert.throws(() => store.resolve(s.id, 'because'), /unknown resolve reason/);
});

test('resolve is idempotent; resolveWhere closes only matching unresolved items', () => {
  const { store, now } = make();
  const a = store.create(agent());
  const b = store.create(agent({ sessionId: 's2' }));
  const c = store.create(status());
  now.tick(10);
  const r = store.resolve(a.id, 'withdrawn');
  assert.deepEqual([r.state, r.resolvedReason, r.updatedAt], ['resolved', 'withdrawn', now()]);
  const rev = store.rev();
  assert.equal(store.resolve(a.id, 'dismissed'), null);
  assert.equal(store.get(a.id).resolvedReason, 'withdrawn');
  assert.equal(store.rev(), rev);
  assert.throws(() => store.resolve('ibx_missing', 'dismissed'), /unknown inbox item/);
  const hit = store.resolveWhere((i) => i.sessionId === 's1', 'session-archived');
  assert.deepEqual(hit.map((i) => i.id), [c.id]);
  assert.equal(store.get(b.id).state, 'open');
  assert.deepEqual(store.resolveWhere(() => true, 'expired').map((i) => i.id), [b.id]);
});

test('update patches title and status in place and never touches readAt', () => {
  const { store, now } = make();
  const s = store.create(status());
  store.markRead([s.id]);
  const readAt = store.get(s.id).readAt;
  now.tick(3);
  const u = store.update(s.id, { title: 'Waiting\non sign-in', status: { waitingFor: 'sign-in', cause: 'sign-in' } });
  assert.deepEqual([u.title, u.status, u.readAt, u.updatedAt, u.state], ['Waiting on sign-in', { waitingFor: 'sign-in', waitingReason: 'permission', episode: 'e1', cause: 'sign-in' }, readAt, now(), 'open']);
  assert.equal(store.update(s.id, { status: { waitingFor: 'x' } }).status.cause, 'sign-in', 'a patch without a cause keeps it');
  for (const k of ['state', 'id', 'readAt', 'sessionId', 'dedupeKey', 'answer']) assert.throws(() => store.update(s.id, { [k]: 'x' }), new RegExp(`does not take "${k}"`));
  assert.throws(() => store.update(s.id, { title: '' }), /title/);
  assert.throws(() => store.update(s.id, { options: [] }), /a status item has no "options"/);
  const a = store.create(agent());
  assert.throws(() => store.update(a.id, { status: { episode: 'x' } }), /an agent request has no "status"/);
});

test('update restates an open agent request in place, validated like create', () => {
  const { store, now } = make();
  const a = store.create(agent({ dedupeKey: 'agent:s1:db' }));
  store.markRead([a.id]);
  const { readAt } = store.get(a.id);
  now.tick(7);
  const u = store.update(a.id, {
    title: 'Pick a DB\nagain', body: 'more context', options: [{ id: 'pg', label: 'Postgres' }, { id: 'sq', label: 'SQLite' }, { id: 'BAD', label: 'x' }],
    allowFreeText: false, blocking: false, urgency: 'high', expiresAt: now() + 60_000,
  });
  assert.deepEqual(
    [u.id, u.readAt, u.createdAt, u.updatedAt, u.title, u.body, u.options.map((o) => o.id), u.allowFreeText, u.blocking, u.urgency, u.expiresAt, u.dedupeKey, u.state],
    [a.id, readAt, a.createdAt, now(), 'Pick a DB again', 'more context', ['pg', 'sq'], true, false, 'high', now() + 60_000, 'agent:s1:db', 'open'],
  );
  assert.equal(store.update(a.id, { options: [] }).allowFreeText, true);
  assert.deepEqual(store.get(a.id), store.findOpenByDedupe('agent:s1:db'));
});

test('update refuses an item that is not open', () => {
  const { store } = make();
  const a = store.create(agent());
  store.answer(a.id, { optionId: 'pg' });
  assert.throws(() => store.update(a.id, { title: 'x' }), /answered, not open/);
  const s = store.create(status());
  store.resolve(s.id, 'status-cleared');
  assert.throws(() => store.update(s.id, { title: 'x' }), /resolved, not open/);
  assert.throws(() => store.update('ibx_none', { title: 'x' }), /unknown inbox item/);
});

test('markRead counts only newly read items and ignores unknown ids', () => {
  const { store } = make();
  const a = store.create(agent());
  const b = store.create(agent({ sessionId: 's2' }));
  assert.equal(store.markRead([a.id, 'ibx_unknown']), 1);
  assert.equal(store.markRead([a.id, b.id]), 1);
  const rev = store.rev();
  assert.equal(store.markRead([a.id]), 0);
  assert.equal(store.rev(), rev);
});

test('dedupe lookup finds only the open item with that key', () => {
  const { store } = make();
  const a = store.create(agent({ dedupeKey: 'agent:s1:db' }));
  assert.equal(store.findOpenByDedupe('agent:s1:db').id, a.id);
  assert.equal(store.findOpenByDedupe('agent:s2:db'), null);
  assert.throws(() => store.create(agent({ dedupeKey: 'agent:s1:db' })), /already has this dedupeKey/);
  store.resolve(a.id, 'withdrawn');
  assert.equal(store.findOpenByDedupe('agent:s1:db'), null);
  const b = store.create(agent({ dedupeKey: 'agent:s1:db' }));
  assert.equal(store.findOpenByDedupe('agent:s1:db').id, b.id);
});

test('openForSession and snapshot order', () => {
  const { store, now } = make();
  const a = store.create(agent());
  now.tick();
  const b = store.create(status());
  const c = store.create(agent({ sessionId: 's2' }));
  store.resolve(a.id, 'withdrawn');
  assert.deepEqual(store.snapshot().map((i) => i.id), [c.id, b.id, a.id]);
  assert.deepEqual(store.openForSession('s1').map((i) => i.id), [b.id]);
});

test('per-session cap reads maxOpenPerSession live and falls back to 5', () => {
  const { store, settings } = make();
  for (let i = 0; i < 5; i++) store.create(agent());
  assert.throws(() => store.create(agent()), /already has 5 open inbox requests \(the limit is 5\)/);
  store.create(status());
  store.create(agent({ sessionId: 's2' }));
  settings.maxOpenPerSession = 6;
  store.create(agent());
  settings.maxOpenPerSession = 2;
  assert.throws(() => store.create(agent()), /limit is 2/);
  for (const bad of [0, 21, 2.5, '3', null]) {
    settings.maxOpenPerSession = bad;
    assert.equal(store.maxOpenPerSession(), 5);
  }
});

test('the total cap prunes the oldest resolved items, and throws when all are live', () => {
  const { store, now, settings } = make();
  settings.maxOpenPerSession = 20;
  const ids = [];
  for (let i = 0; i < MAX_ITEMS; i++) {
    now.tick();
    ids.push(store.create(status({ sessionId: `s${i}`, dedupeKey: `status:s${i}:e` })).id);
  }
  assert.throws(() => store.create(agent()), /inbox is full/);
  now.tick();
  store.resolve(ids[10], 'status-cleared');
  now.tick();
  store.resolve(ids[3], 'status-cleared');
  const x = store.create(agent());
  assert.equal(store.snapshot().length, MAX_ITEMS);
  assert.equal(store.get(ids[10]), null);
  assert.ok(store.get(ids[3]));
  assert.ok(store.get(x.id));
});

test('every mutation bumps rev', () => {
  const { store } = make();
  let rev = store.rev();
  const bumped = () => { const r = store.rev(); assert.ok(r > rev); rev = r; };
  const a = store.create(agent()); bumped();
  store.markRead([a.id]); bumped();
  store.answer(a.id, { optionId: 'pg' }); bumped();
  store.setDelivery(a.id, { delivery: 'failed', deliveryError: 'x' }); bumped();
  store.resolve(a.id, 'dismissed'); bumped();
  const s = store.create(status()); bumped();
  store.update(s.id, { title: 'T' }); bumped();
  store.resolveWhere(() => true, 'status-cleared'); bumped();
  store.setCanAskOverride('s9', true); bumped();
  store.remove([s.id]); bumped();
  store.forgetSession('s9'); bumped();
});

test('persistence round-trips items and can-ask overrides', () => {
  const { store, file } = make();
  const a = store.create(agent());
  store.answer(a.id, { optionId: 'pg', text: 'because' });
  store.setDelivery(a.id, { delivery: 'failed', deliveryError: 'pane gone' });
  store.create(status());
  store.setCanAskOverride('s1', false);
  store.setCanAskOverride('s2', true);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(disk), ['version', 'items', 'canAsk']);
  assert.equal(disk.version, 1);
  assert.deepEqual(disk.canAsk, { s1: false, s2: true });
  const again = new InboxStore({ file });
  assert.deepEqual(again.snapshot(), store.snapshot());
  assert.equal(again.canAskOverride('s1'), false);
  assert.equal(again.canAskOverride('s2'), true);
  assert.equal(again.canAskOverride('s3'), null);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['inbox.json']);
});

test('a corrupt file is moved aside once, logged, and the store starts empty', () => {
  for (const body of ['{not json', JSON.stringify({ version: 2, items: [] }), JSON.stringify([1, 2])]) {
    const file = tempStoreFile();
    fs.writeFileSync(file, body);
    const { store, logs, now } = make({ file });
    assert.deepEqual(store.snapshot(), []);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /moved it to .*inbox\.json\.corrupt-/);
    assert.equal(fs.readFileSync(`${file}.corrupt-${now()}`, 'utf8'), body);
    assert.equal(fs.existsSync(file), false);
    store.create(agent());
    assert.equal(new InboxStore({ file }).snapshot().length, 1);
  }
});

test('a missing or empty file is a quiet first run; unreadable items are dropped', () => {
  const file = tempStoreFile();
  assert.deepEqual(make({ file }).logs, []);
  fs.writeFileSync(file, '');
  assert.deepEqual(make({ file }).logs, []);
  const good = make({ file: tempStoreFile() });
  const a = good.store.create(agent());
  const disk = JSON.parse(fs.readFileSync(good.file, 'utf8'));
  disk.items.push({ id: 'bad' }, { ...disk.items[0] });
  disk.canAsk = { s1: 'yes', s2: true };
  fs.writeFileSync(good.file, JSON.stringify(disk));
  const { store, logs } = make({ file: good.file });
  assert.deepEqual(store.snapshot().map((i) => i.id), [a.id]);
  assert.equal(logs.length, 1);
  assert.deepEqual([store.canAskOverride('s1'), store.canAskOverride('s2')], [null, true]);
});

test('can-ask overrides: set, clear with null, validate', () => {
  const { store } = make();
  store.setCanAskOverride('s1', true);
  assert.equal(store.canAskOverride('s1'), true);
  store.setCanAskOverride('s1', null);
  assert.equal(store.canAskOverride('s1'), null);
  assert.equal(store.canAskOverride('__proto__'), null);
  assert.throws(() => store.setCanAskOverride('s1', 'yes'), /true, false or null/);
  assert.throws(() => store.setCanAskOverride('', true), /card id/);
});

test('forgetSession removes the session items and its override', () => {
  const { store } = make();
  store.create(agent());
  store.create(status());
  const other = store.create(agent({ sessionId: 's2' }));
  store.setCanAskOverride('s1', true);
  store.forgetSession('s1');
  assert.deepEqual(store.snapshot().map((i) => i.id), [other.id]);
  assert.equal(store.canAskOverride('s1'), null);
  assert.equal(store.remove([other.id, 'ibx_x']), 1);
  assert.deepEqual(store.snapshot(), []);
});
