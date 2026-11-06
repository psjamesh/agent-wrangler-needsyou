import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presentItems, loadPreferences, savePreferences } from './inbox-presentation.js';
import { item, statusItem, graphOf } from '../test/fixtures/inbox.js';

const ids = (groups) => groups.flatMap((g) => g.items.map((i) => i.id));
const prefs = (sort, direction = 'asc', group = 'none') => ({ group, sort, direction });

test('recommended preserves each filter order; explicit sorts use visible labels and elapsed waiting', () => {
  const items = [
    item({ id: 'question', kind: 'question', createdAt: 30 }),
    statusItem({ id: 'permission', createdAt: 20 }),
    item({ id: 'action', kind: 'action', createdAt: 10 }),
    item({ id: 'closed', kind: 'approval', state: 'resolved', createdAt: 40, updatedAt: 50 }),
  ];
  const graph = graphOf(items);
  assert.deepEqual(ids(presentItems(items, graph, 'all', prefs('recommended'))), ['permission', 'action', 'question', 'closed']);
  assert.deepEqual(ids(presentItems(items, graph, 'all', prefs('type'))), ['action', 'closed', 'permission', 'question']);
  assert.deepEqual(ids(presentItems(items, graph, 'all', prefs('type', 'desc'))), ['question', 'permission', 'closed', 'action']);
  assert.deepEqual(ids(presentItems(items, graph, 'open', prefs('waiting'))), ['question', 'permission', 'action']);
  assert.deepEqual(ids(presentItems(items, graph, 'open', prefs('waiting', 'desc'))), ['action', 'permission', 'question']);
  assert.deepEqual(ids(presentItems(items, graph, 'closed', prefs('type'))), ['closed']);
  assert.deepEqual(items.map((i) => i.id), ['question', 'permission', 'action', 'closed']);
});

test('equal sort values use stable ids in either direction independent of graph order', () => {
  const items = [item({ id: 'b' }), item({ id: 'a' })];
  for (const sort of ['waiting', 'type']) for (const direction of ['asc', 'desc']) {
    assert.deepEqual(ids(presentItems(items, graphOf(items), 'open', prefs(sort, direction))), ['a', 'b']);
    assert.deepEqual(ids(presentItems([...items].reverse(), graphOf(items), 'open', prefs(sort, direction))), ['a', 'b']);
  }
});

test('type groups are alphabetic visible labels with direction applying only within groups', () => {
  const items = [statusItem({ id: 'p', createdAt: 10 }), item({ id: 'q', kind: 'question' }),
    statusItem({ id: 'q2', createdAt: 20, status: { cause: 'question' } }),
    statusItem({ id: 's', status: { cause: 'sign-in' } })];
  const groups = presentItems(items, graphOf(items), 'open', prefs('waiting', 'desc', 'type'));
  assert.deepEqual(groups.map((g) => g.label), ['Permission', 'Question', 'Sign-in']);
  assert.deepEqual(ids(groups), ['p', 'q2', 'q', 's']);
});

test('task groups use current session identity, separate duplicate names, and handle absent metadata', () => {
  const items = [item({ id: 'one', sessionId: 's1', taskId: 'old' }), item({ id: 'two', sessionId: 's2' }),
    item({ id: 'none', sessionId: 's3', taskId: 'old' }), item({ id: 'missing', sessionId: 'gone', taskId: 'old' })];
  const sessions = { s1: { taskId: 't1', taskName: 'Same' }, s2: { taskId: 't2', taskName: 'Same' }, s3: { taskId: null } };
  const graph = graphOf(items, { sessions });
  const groups = presentItems(items, graph, 'open', prefs('type', 'asc', 'task'));
  assert.deepEqual(groups.map((g) => [g.label, g.items.map((i) => i.id)]), [['No task', ['missing', 'none']], ['Same', ['one']], ['Same', ['two']]]);
  assert.equal(new Set(groups.map((g) => g.key)).size, 3);
  sessions.s1 = { taskId: 't2', taskName: 'Renamed' };
  sessions.s2.taskName = 'Renamed';
  assert.deepEqual(presentItems(items, graph, 'open', prefs('recommended', 'asc', 'task')).map((g) => g.label), ['No task', 'Renamed']);
  assert.deepEqual(presentItems([], graph, 'open', prefs('recommended', 'asc', 'task')), []);
});

test('preferences round trip and validate missing, corrupt or unavailable storage', () => {
  const values = new Map();
  const storage = { getItem: (k) => values.get(k), setItem: (k, v) => values.set(k, v) };
  const defaults = { group: 'none', sort: 'recommended', direction: 'asc' };
  assert.deepEqual(loadPreferences(storage), defaults);
  savePreferences(storage, prefs('waiting', 'desc', 'task'));
  assert.deepEqual(loadPreferences(storage), prefs('waiting', 'desc', 'task'));
  const key = [...values.keys()][0];
  for (const bad of ['{', 'null', '[]', '42', '"task"']) {
    values.set(key, bad);
    assert.deepEqual(loadPreferences(storage), defaults);
  }
  values.set(key, JSON.stringify({ group: 'type', sort: 'bogus', direction: 'sideways' }));
  assert.deepEqual(loadPreferences(storage), { ...defaults, group: 'type' });
  const denied = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } };
  assert.deepEqual(loadPreferences(denied), defaults);
  assert.deepEqual(loadPreferences(null), defaults);
  assert.doesNotThrow(() => savePreferences(denied, prefs('type')));
  assert.doesNotThrow(() => savePreferences(null, prefs('type')));
});
