import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInboxToasts } from './inbox-toasts.js';
import { sessionMeta } from './inbox-model.js';

function notify(title, name, taskName = '') {
  const notifications = [];
  const toasts = createInboxToasts({
    settings: () => ({ toastNotifications: true }),
    ui: { notify: (value) => { notifications.push(value); }, withdraw() {} },
  }, () => {});
  toasts.update({ inbox: { items: [] } });
  const item = { id: 'request', sessionId: 'session', title, state: 'open' };
  const graph = { inbox: { items: [item], sessions: { session: { name, taskName } } } };
  toasts.update(graph);
  return { ...notifications[0], meta: sessionMeta(graph, item) };
}

test('short toast text stays intact', () => {
  const toast = notify('Choose a release', 'Worker', 'Release');
  assert.equal(toast.title, 'Choose a release');
  assert.equal(toast.body, 'Worker · Release');
});

test('exact-boundary title and body need no ellipsis', () => {
  const toast = notify('t'.repeat(120), 's'.repeat(73), 'Task');
  assert.equal(toast.title, 't'.repeat(120));
  assert.equal(toast.body, `${'s'.repeat(73)} · Task`);
  assert.equal(toast.body.length, 80);
});

test('long toast text cuts at words and preserves the task', () => {
  const title = 'Choose the release '.repeat(10).trim();
  const name = 'Investigate the deployment '.repeat(10).trim();
  const toast = notify(title, name, 'Release');
  assert.equal(toast.title, `${'Choose the release '.repeat(6).trim()}…`);
  assert.equal(toast.body, 'Investigate the deployment Investigate the deployment Investigate the… · Release');
  assert.ok(toast.body.length <= 80);
  assert.equal(toast.meta, `${name} · Release`);
});

test('unbroken names and long tasks still fit the toast body', () => {
  const toast = notify('t'.repeat(121), 's'.repeat(100), 'k'.repeat(100));
  assert.equal(toast.title, `${'t'.repeat(119)}…`);
  assert.ok(toast.body.length <= 80);
  assert.match(toast.body, / · k+…$/);
});

test('toast text collapses line breaks and repeated whitespace', () => {
  const toast = notify('Choose\n a\t release', 'Worker\n brief', 'Release\n task');
  assert.equal(toast.title, 'Choose a release');
  assert.equal(toast.body, 'Worker brief · Release task');
});

test('a long session without a task is truncated', () => {
  assert.equal(notify('Title', 's'.repeat(81)).body, `${'s'.repeat(79)}…`);
});

test('a short opening word does not discard a long URL', () => {
  const name = `Fix https://example.com/${'path'.repeat(30)}`;
  assert.equal(notify('Title', name).body, `${name.slice(0, 79)}…`);
});

test('hard cuts preserve complete emoji', () => {
  const emoji = String.fromCodePoint(0x1f600);
  const toast = notify(emoji.repeat(70), emoji.repeat(50));
  assert.equal(toast.title, `${emoji.repeat(59)}…`);
  assert.equal(toast.body, `${emoji.repeat(39)}…`);
});
