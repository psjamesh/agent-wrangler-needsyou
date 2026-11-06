import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preferTerminal, temporarilyPreferTerminal, wantsTerminal, SESSION_VIEW_KEY } from './inbox-session-view.js';

function memory(initial) {
  const m = new Map(initial === undefined ? [] : [[SESSION_VIEW_KEY, initial]]);
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), read: () => JSON.parse(m.get(SESSION_VIEW_KEY)) };
}

test('preferTerminal sets the session to terminal and keeps the others', () => {
  const s = memory(JSON.stringify({ a: 'chat', b: 'chat' }));
  preferTerminal('b', s);
  assert.deepEqual(s.read(), { a: 'chat', b: 'terminal' });
});

test('preferTerminal starts afresh on a missing or corrupt value', () => {
  for (const v of [undefined, 'not json', '"x"', '[1]', 'null']) {
    const s = memory(v);
    preferTerminal('a', s);
    assert.deepEqual(s.read(), { a: 'terminal' });
  }
});

test('preferTerminal never throws when storage does', () => {
  const s = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.doesNotThrow(() => preferTerminal('a', s));
});

test('only an open status item wants the terminal', () => {
  assert.equal(wantsTerminal({ source: 'status', state: 'open' }), true);
  assert.equal(wantsTerminal({ source: 'status', state: 'resolved' }), false);
  assert.equal(wantsTerminal({ source: 'agent', state: 'open' }), false);
});


test('temporary terminal preference restores exactly, including missing and malformed storage', () => {
  for (const raw of [undefined, '{ "a": "chat", "other": "terminal" }', 'not json', '[1]', 'null']) {
    const s = memory(raw);
    const restore = temporarilyPreferTerminal('a', s);
    assert.equal(s.read().a, 'terminal');
    restore();
    assert.equal(s.getItem(SESSION_VIEW_KEY), raw ?? null);
    restore();
    assert.equal(s.getItem(SESSION_VIEW_KEY), raw ?? null, 'restoration is idempotent');
  }
});

test('temporary terminal preference preserves other sessions and a human tab change', () => {
  const s = memory(JSON.stringify({ a: 'chat', b: 'chat' }));
  const restore = temporarilyPreferTerminal('a', s);
  s.setItem(SESSION_VIEW_KEY, JSON.stringify({ a: 'terminal', b: 'terminal', c: 'chat' }));
  restore();
  assert.deepEqual(s.read(), { a: 'chat', b: 'terminal', c: 'chat' });
  const restoreAgain = temporarilyPreferTerminal('a', s);
  s.setItem(SESSION_VIEW_KEY, JSON.stringify({ a: 'chat', b: 'terminal', c: 'chat' }));
  restoreAgain();
  assert.deepEqual(s.read(), { a: 'chat', b: 'terminal', c: 'chat' });
});

test('temporary terminal preference removes only its new entry when other sessions changed', () => {
  const s = memory();
  const restore = temporarilyPreferTerminal('a', s);
  s.setItem(SESSION_VIEW_KEY, JSON.stringify({ a: 'terminal', b: 'chat' }));
  restore();
  assert.deepEqual(s.read(), { b: 'chat' });
});

test('temporary preference storage errors do not escape mount or cleanup', () => {
  const s = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  let restore;
  assert.doesNotThrow(() => { restore = temporarilyPreferTerminal('a', s); });
  assert.doesNotThrow(() => restore());
});

test('returning to Terminal inside a temporary view still restores the earlier saved tab', () => {
  const s = memory(JSON.stringify({ a: 'chat' }));
  const restore = temporarilyPreferTerminal('a', s);
  s.setItem(SESSION_VIEW_KEY, JSON.stringify({ a: 'chat' }));
  s.setItem(SESSION_VIEW_KEY, JSON.stringify({ a: 'terminal' }));
  restore();
  assert.deepEqual(s.read(), { a: 'chat' });
});
