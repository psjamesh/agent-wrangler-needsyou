import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createInboxView } from './inbox-view.js';
import { item, statusItem, failedItem, graphOf } from '../test/fixtures/inbox.js';

const MIN = 60_000;
const XSS = '<img src=x onerror="globalThis.pwned=1">';

// Mounted the way slots.js mounts a `view`: an `.ext-view` host the board
// toggles `hidden` on, holding the contribution's own `.ext-slot` element.
function mountView({ api: over = {}, twoPanes, storage, beforeMount } = {}) {
  const window = new Window({ url: 'http://localhost:7777/' });
  const { document } = window;
  const host = document.createElement('div');
  host.className = 'ext-view';
  document.body.appendChild(host);
  const el = document.createElement('div');
  el.className = 'ext-slot';
  host.appendChild(el);
  const sent = [];
  const opened = [];
  const mounts = [];
  const timers = [];
  const api = {
    send: (frame) => sent.push(frame),
    openSession: (sid) => opened.push(sid),
    // Stands in for the board's sanitising renderer, marked so a test can see
    // where rendered markdown landed.
    ui: { markdownPreview: (md) => `<p class="md">${md.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>` },
    mountSession: (target, sid) => {
      const m = { target, sid, unmounted: false };
      mounts.push(m);
      return { sessionId: sid, show() { return true; }, unmount() { m.unmounted = true; } };
    },
    ...over,
  };
  let clock = 20 * MIN;
  beforeMount?.(window);
  const view = createInboxView(el, api, {
    now: () => clock, leaveMs: 0,
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    cancel: () => {},
    twoPanes,
    ...(storage !== undefined ? { storage } : {}),
  });
  const root = el.querySelector('.ibx-root');
  const press = (key, opts = {}) => {
    const target = document.activeElement && root.contains(document.activeElement) ? document.activeElement : root;
    const ev = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
    target.dispatchEvent(ev);
    return ev;
  };
  return {
    window, document, host, el, root, view, api, sent, opened, mounts, timers, press,
    tick: (ms) => { clock += ms; },
    rows: () => [...el.querySelectorAll('.ibx-queue .ibx-row:not(.ibx-leaving)')],
    filter: (name) => el.querySelector(`.ibx-filter[data-filter="${name}"]`),
    q: (sel) => el.querySelector(sel),
  };
}

const ids = (rows) => rows.map((r) => r.dataset.id);
const text = (node) => node?.textContent ?? null;

test('the queue renders in cost-of-waiting order with kind, meta, age, unread dot and failed tag', () => {
  const v = mountView();
  const nb = item({ blocking: false, createdAt: 0, title: 'FYI-ish' });
  const fail = failedItem({ createdAt: 0 });
  const dec = item({ createdAt: 8 * MIN, readAt: 9 * MIN });
  const blocked = statusItem({ createdAt: 10 * MIN });
  v.view.update(graphOf([nb, fail, dec, blocked]));
  const rows = v.rows();
  assert.deepEqual(ids(rows), [blocked.id, dec.id, nb.id, fail.id]);
  assert.equal(text(rows[0].querySelector('.ibx-row-kind-label')), 'Permission');
  assert.equal(text(rows[0].querySelector('.ibx-row-title')), 'Permission prompt');
  assert.equal(text(rows[0].querySelector('.ibx-row-meta')), 'Worker · Auth');
  assert.equal(text(rows[0].querySelector('.ibx-row-age')), 'waiting 10m');
  assert.ok(rows[0].classList.contains('ibx-unread'));
  assert.ok(!rows[1].classList.contains('ibx-unread'), 'a read item has no dot');
  assert.equal(text(rows[3].querySelector('.ibx-tag-failed')), 'Not delivered');
  assert.equal(text(rows[3].querySelector('.ibx-row-age')), 'answered 19m ago', 'a failed answer is no longer waiting');
  assert.ok(rows[3].classList.contains('ibx-failed'));
  assert.equal(text(v.q('.ibx-count')), '4 open', 'C3: the count matches the Open filter');
  assert.equal(v.q('.ibx-count').hidden, false);
  assert.equal(v.q('.ibx-empty').hidden, true);
});

test('a status item of a spawned session says who spawned it', () => {
  const v = mountView();
  const s = statusItem({ sessionId: 'w1' });
  v.view.update(graphOf([s], {
    sessions: { w1: { name: 'Worker', taskName: '', spawnedBy: 'o1', canAsk: false }, o1: { name: 'Orchestrator', spawnedBy: null } },
  }));
  assert.equal(text(v.rows()[0].querySelector('.ibx-row-meta')), 'Worker · spawned by Orchestrator');
});

test('the empty state shows when nothing needs the human', () => {
  const v = mountView();
  v.view.update(graphOf([]));
  assert.equal(v.q('.ibx-empty').hidden, false);
  assert.equal(text(v.q('.ibx-empty')), 'Nothing needs you right now.');
  assert.equal(v.q('.ibx-next'), null, 'no Next button (0.1.3): the n key does its job');
  assert.equal(v.q('.ibx-recent'), null, 'the Recently resolved strip is gone (0.1.4)');
  assert.equal(v.q('.ibx-count').hidden, true, 'no count when nothing is open');
});

test('the Closed filter lists closed items by when they closed, with how and "closed Nm ago"', () => {
  const v = mountView();
  const gone = [
    // Asked first but closed last: it leads.
    item({ state: 'resolved', resolvedReason: 'delivered', createdAt: 1 * MIN, updatedAt: 19 * MIN, title: 'A' }),
    item({ state: 'resolved', resolvedReason: 'withdrawn', createdAt: 10 * MIN, updatedAt: 17 * MIN, title: 'B' }),
    statusItem({ state: 'resolved', resolvedReason: 'status-cleared', createdAt: 5 * MIN, updatedAt: 16 * MIN, title: 'C' }),
    item({ state: 'answered', createdAt: 2 * MIN, updatedAt: 18 * MIN, title: 'D', answer: { optionId: null, text: 'ok', at: 18 * MIN, delivery: 'pending' } }),
  ];
  v.view.update(graphOf(gone));
  assert.equal(v.rows().length, 0, 'Open shows nothing');
  v.filter('closed').click();
  const rows = v.rows();
  assert.deepEqual(rows.map((r) => text(r.querySelector('.ibx-row-title'))), ['A', 'D', 'B', 'C']);
  assert.deepEqual(rows.map((r) => text(r.querySelector('.ibx-closed-reason'))), ['answered', '', 'withdrawn by agent', 'resolved in the session']);
  assert.deepEqual(rows.map((r) => text(r.querySelector('.ibx-row-age'))), ['closed 1m ago', 'sending', 'closed 3m ago', 'closed 4m ago']);
  assert.ok(rows.every((r) => r.classList.contains('ibx-closed-row')));
  // The same layout as an open row: kind, title, session.
  assert.equal(text(rows[3].querySelector('.ibx-row-kind-label')), 'Permission');
  assert.equal(text(rows[3].querySelector('.ibx-row-meta')), 'Worker · Auth');
  assert.equal(v.q('.ibx-empty').hidden, true);
  assert.equal(v.q('.ibx-queue').getAttribute('aria-label'), 'Closed items');
});

test('the filter buttons: a "Show" group, aria-pressed, counts, and each empty state', () => {
  const v = mountView();
  v.view.update(graphOf([]));
  const group = v.q('.ibx-filters');
  assert.equal(group.getAttribute('role'), 'group');
  assert.equal(group.getAttribute('aria-label'), 'Show');
  const pressed = () => [...v.el.querySelectorAll('.ibx-filter')].map((b) => b.getAttribute('aria-pressed'));
  const labels = () => [...v.el.querySelectorAll('.ibx-filter')].map((b) => text(b));
  assert.deepEqual(pressed(), ['true', 'false', 'false'], 'it opens on Open');
  assert.deepEqual(labels(), ['Open (0)', 'Closed (0)', 'All (0)']);
  assert.equal(text(v.q('.ibx-empty')), 'Nothing needs you right now.');
  v.filter('closed').click();
  assert.deepEqual(pressed(), ['false', 'true', 'false']);
  assert.equal(text(v.q('.ibx-empty')), 'Nothing closed in the last 24 hours.');
  v.filter('all').click();
  assert.deepEqual(pressed(), ['false', 'false', 'true']);
  assert.equal(text(v.q('.ibx-empty')), 'Nothing in the last 24 hours.');
  assert.equal(v.q('.ibx-empty').hidden, false);

  const open = item({ createdAt: 1, title: 'open' });
  const fail = failedItem({ createdAt: 0, title: 'failed' });
  const old = item({ state: 'resolved', resolvedReason: 'expired', updatedAt: 10 * MIN, title: 'old' });
  const fresh = item({ state: 'resolved', resolvedReason: 'dismissed', updatedAt: 15 * MIN, title: 'fresh' });
  v.view.update(graphOf([old, fail, fresh, open]));
  assert.deepEqual(labels(), ['Open (2)', 'Closed (2)', 'All (4)']);
  assert.deepEqual(v.rows().map((r) => text(r.querySelector('.ibx-row-title'))), ['open', 'failed', 'fresh', 'old'],
    'All: the Open list, then the Closed list');
  assert.deepEqual(v.rows().map((r) => r.classList.contains('ibx-closed-row')), [false, false, true, true]);
  v.filter('open').click();
  assert.deepEqual(v.rows().map((r) => text(r.querySelector('.ibx-row-title'))), ['open', 'failed'], 'Open includes a failed delivery');
  assert.equal(text(v.q('.ibx-count')), '2 open');
});

test('the chosen filter is remembered per browser, and storage that fails means Open', () => {
  const stored = new Map();
  const storage = { getItem: (k) => stored.get(k) ?? null, setItem: (k, val) => stored.set(k, val) };
  const v = mountView({ storage });
  v.view.update(graphOf([]));
  v.filter('closed').click();
  assert.equal(stored.get('needsyou.filter'), 'closed');
  const again = mountView({ storage });
  again.view.update(graphOf([]));
  assert.equal(again.filter('closed').getAttribute('aria-pressed'), 'true', 'a new view opens on the remembered filter');

  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const b = mountView({ storage: broken });
  b.view.update(graphOf([]));
  assert.equal(b.filter('open').getAttribute('aria-pressed'), 'true');
  b.filter('all').click();
  assert.equal(b.filter('all').getAttribute('aria-pressed'), 'true', 'still switches when it cannot remember');

  stored.set('needsyou.filter', 'bogus');
  const odd = mountView({ storage });
  odd.view.update(graphOf([]));
  assert.equal(odd.filter('open').getAttribute('aria-pressed'), 'true', 'an unknown stored value is Open');

  // By default it is the window's localStorage.
  const w = mountView({ beforeMount: (win) => win.localStorage.setItem('needsyou.filter', 'all') });
  w.view.update(graphOf([]));
  assert.equal(w.filter('all').getAttribute('aria-pressed'), 'true');
});

test('n from Closed or All switches to Open and selects the top open item', () => {
  const v = mountView();
  const top = statusItem({ createdAt: 1 });
  const other = item({ createdAt: 2 });
  const gone = item({ state: 'resolved', resolvedReason: 'expired', updatedAt: 19 * MIN });
  v.view.update(graphOf([top, other, gone]));
  v.filter('closed').click();
  v.rows()[0].click();
  assert.equal(v.view.selectedId, gone.id);
  v.press('n');
  assert.equal(v.filter('open').getAttribute('aria-pressed'), 'true');
  assert.equal(v.view.selectedId, top.id);
  v.filter('all').click();
  v.view.select(gone.id);
  v.press('n');
  assert.equal(v.filter('open').getAttribute('aria-pressed'), 'true');
  assert.equal(v.view.selectedId, top.id);
});

test('selecting an open item while Closed shows switches to Open (a card pill)', () => {
  const v = mountView();
  const a = item();
  v.view.update(graphOf([a]));
  v.filter('closed').click();
  v.view.select(a.id, { open: true });
  assert.equal(v.filter('open').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(v.rows().map((r) => r.dataset.id), [a.id]);
});

/* ── C1: an X closes the detail ───────────────────────────────────────────── */

test('two panes: the X clears the selection, shows the hint, and focuses the row', () => {
  const v = mountView({ twoPanes: () => true });
  const a = item({ createdAt: 1 });
  const b = item({ createdAt: 2 });
  v.view.update(graphOf([a, b]));
  v.view.select(b.id);
  const x = v.q('.ibx-close');
  assert.ok(x, 'an X at two panes');
  assert.equal(x.getAttribute('aria-label'), 'Close');
  assert.equal(x.title, 'Close (Esc)');
  assert.ok(x.querySelector('svg'), 'an icon, not a text glyph');
  x.click();
  assert.equal(v.view.selectedId, null);
  assert.equal(text(v.q('.ibx-d-placeholder')), 'Select an item, or press n for the top one.');
  assert.equal(v.document.activeElement, v.q(`.ibx-row[data-id="${b.id}"]`), 'focus returns to the row that was selected');
  // No auto-select on later ticks.
  v.view.update(graphOf([a, b]));
  v.view.update(graphOf([a, b]));
  assert.equal(v.view.selectedId, null, 'the next tick does not auto-select again');
  // A row the human picks selects again.
  v.rows()[0].click();
  assert.equal(v.view.selectedId, a.id);
});

test('two panes: Escape closes the detail; a new item, or n, selects again', () => {
  const v = mountView({ twoPanes: () => true });
  const a = item({ createdAt: 1 });
  v.view.update(graphOf([a]));
  assert.equal(v.view.selectedId, a.id, 'auto-picked');
  v.root.focus();
  v.press('Escape');
  assert.equal(v.view.selectedId, null);
  assert.equal(v.document.activeElement, v.q(`.ibx-row[data-id="${a.id}"]`));
  v.view.update(graphOf([a]));
  assert.equal(v.view.selectedId, null);
  v.press('n');
  assert.equal(v.view.selectedId, a.id, 'n selects again');
  v.press('Escape'); // n focused the answer box: the first Escape leaves it
  assert.equal(v.view.selectedId, a.id);
  v.press('Escape');
  assert.equal(v.view.selectedId, null);
  // An item seen before, coming back as a failed delivery, is not new.
  v.view.update(graphOf([{ ...a, state: 'answered', answer: { optionId: null, text: 'x', at: 1, delivery: 'pending' } }]));
  v.view.update(graphOf([{ ...a, state: 'answered', answer: { optionId: null, text: 'x', at: 1, delivery: 'failed', deliveryError: 'gone', attempts: 1 } }]));
  assert.equal(v.view.selectedId, null, 'a failed delivery of a seen item does not reselect');
  // A new id does.
  const b = item({ createdAt: 2 });
  v.view.update(graphOf([a, b]));
  assert.equal(v.view.selectedId, a.id, 'a new open item lifts the close and auto-selects the top');
});

test('two panes: Escape while typing or confirming does not close the detail', () => {
  const v = mountView({ twoPanes: () => true });
  const a = item({ allowFreeText: true });
  v.view.update(graphOf([a]));
  v.view.select(a.id, { focus: true });
  assert.equal(v.document.activeElement, v.q('.ibx-text'));
  v.press('Escape');
  assert.equal(v.view.selectedId, a.id, 'Escape in the box only leaves the box');
  v.press('e');
  assert.ok(v.q('.ibx-confirm'));
  v.press('Escape');
  assert.equal(v.q('.ibx-confirm'), null);
  assert.equal(v.view.selectedId, a.id, 'Escape on a confirm only cancels it');
});

test('two panes: a filter with nothing to show selects nothing and shows no hint', () => {
  const v = mountView({ twoPanes: () => true });
  const a = item();
  v.view.update(graphOf([a]));
  v.filter('closed').click();
  assert.equal(v.view.selectedId, null, 'nothing closed to show');
  assert.equal(text(v.q('.ibx-d-placeholder')), '', 'no hint when the list showing is empty');
});

test('one pane: no X, and Escape goes Back as before', () => {
  const v = mountView({ twoPanes: () => false });
  const a = item();
  v.view.update(graphOf([a]));
  v.rows()[0].click();
  assert.equal(v.q('.ibx-close'), null);
  assert.ok(v.root.classList.contains('ibx-detail-open'));
  v.root.focus();
  v.press('Escape');
  assert.ok(!v.root.classList.contains('ibx-detail-open'));
  assert.equal(v.view.selectedId, a.id, 'Back keeps the selection');
});

test('a status item detail: guidance, the terminal text once, Open session, terminal toggle, Dismiss without confirm', () => {
  const v = mountView();
  const s = statusItem();
  v.view.update(graphOf([s]));
  v.view.select(s.id);
  assert.equal(text(v.q('.ibx-d-guidance')), 'The agent wants to do this and needs your approval. Open the session to allow or deny it.');
  assert.equal(text(v.q('.ibx-from-terminal-head')), 'From the terminal');
  assert.equal(text(v.q('.ibx-terminal-text')), 'Approve a Bash command');
  assert.equal((v.q('.ibx-detail').textContent.match(/Approve a Bash command/g) || []).length, 1, 'the terminal text shows once');
  assert.equal(v.q('.ibx-d-waiting'), null);
  v.q('.ibx-open-session').click();
  assert.deepEqual(v.opened, ['s1']);
  assert.deepEqual(JSON.parse(v.window.localStorage.getItem('cm-session-view')), { s1: 'terminal' }, 'a blocked session opens on its Terminal');
  v.q('.ibx-terminal-toggle').click();
  assert.equal(v.mounts.length, 1);
  assert.equal(v.mounts[0].target, v.q('.ibx-terminal'));
  assert.equal(v.q('.ibx-terminal').hidden, false);
  assert.equal(text(v.q('.ibx-terminal-toggle')), 'Hide terminal');
  v.q('.ibx-dismiss').click();
  assert.deepEqual(v.sent.at(-1), { type: 'inbox-dismiss', id: s.id });
});

test('the embedded terminal is unmounted when the selection changes and on unmount', () => {
  const v = mountView();
  const a = statusItem({ createdAt: 1 });
  const b = statusItem({ createdAt: 2, sessionId: 's2' });
  v.view.update(graphOf([a, b]));
  v.view.select(a.id);
  v.q('.ibx-terminal-toggle').click();
  v.view.select(b.id);
  assert.equal(v.mounts[0].unmounted, true);
  assert.equal(v.q('.ibx-terminal').hidden, true);
  v.q('.ibx-terminal-toggle').click();
  v.view.unmount();
  assert.equal(v.mounts[1].unmounted, true);
});

test('an open agent item: options, a note box, Send only once valid, the note rides with the choice', () => {
  const v = mountView();
  const d = item({ options: [{ id: 'a', label: 'Rebase', description: 'Keep history linear' }, { id: 'b', label: 'Merge' }], allowFreeText: false });
  v.view.update(graphOf([d]));
  v.view.select(d.id);
  const opts = [...v.el.querySelectorAll('.ibx-option')];
  assert.equal(opts.length, 2);
  assert.equal(text(opts[0].querySelector('.ibx-option-label')), 'Rebase');
  assert.equal(text(opts[0].querySelector('.ibx-option-desc')), 'Keep history linear');
  assert.equal(v.q('.ibx-send').disabled, true);
  opts[1].click();
  assert.equal(v.q('.ibx-option[data-option-id="b"]').getAttribute('aria-checked'), 'true');
  const ta = v.q('.ibx-text');
  ta.value = 'because';
  ta.dispatchEvent(new v.window.Event('input', { bubbles: true }));
  v.q('.ibx-send').click();
  assert.deepEqual(v.sent.at(-1), { type: 'inbox-answer', id: d.id, optionId: 'b', text: 'because' });
  assert.equal(v.q('.ibx-send').disabled, true, 'disabled while sending');
  assert.ok([...v.el.querySelectorAll('.ibx-option')].every((b) => b.disabled));
});

test('clearing a choice preserves drafts through ticks and re-renders for text-only keyboard replies', () => {
  for (const modifier of ['ctrlKey', 'metaKey']) {
    const v = mountView();
    const d = item({ options: [{ id: 'a', label: 'A' }], allowFreeText: false });
    v.view.update(graphOf([d]));
    v.view.select(d.id);
    const ta = v.q('.ibx-text');
    assert.ok(ta, 'fixed choices offer an optional note');
    assert.equal(text(v.q('.ibx-text-label')), 'Your answer, or a note with your choice');
    assert.equal(ta.maxLength, 4000);
    assert.match(text(v.q('.ibx-hint')), /Enter sends/);
    ta.value = ' after lunch ';
    ta.dispatchEvent(new v.window.Event('input', { bubbles: true }));
    ta.focus();
    assert.equal(v.q('.ibx-send').disabled, false);
    assert.equal(v.sent.filter((f) => f.type === 'inbox-answer').length, 0);
    v.q('.ibx-option').click();
    const chosenField = v.q('.ibx-text');
    v.view.update(graphOf([{ ...d, readAt: 2 }]));
    assert.ok(v.q('.ibx-text') === chosenField, 'unchanged tick keeps the field');
    v.view.update(graphOf([{ ...d, body: 'More context', updatedAt: 2 }]));
    assert.equal(v.q('.ibx-text').value, ' after lunch ');
    assert.equal(v.q('.ibx-option').getAttribute('aria-checked'), 'true');
    assert.equal(v.q('.ibx-send').disabled, false);
    const clear = v.q('.ibx-clear-choice');
    assert.equal(text(clear), 'Clear');
    clear.click();
    assert.equal(v.q('.ibx-option').getAttribute('aria-checked'), 'false');
    assert.equal(v.q('.ibx-text').value, ' after lunch ');
    assert.equal(v.document.activeElement, v.q('.ibx-text'));
    const enter = v.press('Enter');
    assert.equal(enter.defaultPrevented, false, 'plain Enter stays in the note');
    assert.equal(v.sent.filter((f) => f.type === 'inbox-answer').length, 0);
    v.press('Enter', { [modifier]: true });
    assert.deepEqual(v.sent.at(-1), { type: 'inbox-answer', id: d.id, text: 'after lunch' });
    assert.equal(v.q('.ibx-text').disabled, true);
  }
});

test('removing choices clears the stale selection and keeps the note as a free-text answer', () => {
  const v = mountView();
  const d = item({ kind: 'question', options: [{ id: 'a', label: 'A' }], allowFreeText: false });
  v.view.update(graphOf([d]));
  v.view.select(d.id);
  v.q('.ibx-option').click();
  const ta = v.q('.ibx-text');
  ta.value = 'another approach';
  ta.dispatchEvent(new v.window.Event('input', { bubbles: true }));
  v.view.update(graphOf([{ ...d, options: [], allowFreeText: true, updatedAt: 2 }]));
  assert.equal(v.q('.ibx-option'), null);
  assert.equal(v.q('.ibx-text').value, 'another approach');
  assert.equal(v.q('.ibx-send').disabled, false);
  v.q('.ibx-text').focus();
  v.press('Enter', { ctrlKey: true });
  assert.deepEqual(v.sent.at(-1), { type: 'inbox-answer', id: d.id, text: 'another approach' });
});

test('a free-text item sends on Cmd/Ctrl+Enter', () => {
  const v = mountView();
  const qn = item({ kind: 'question', options: [], allowFreeText: true });
  v.view.update(graphOf([qn]));
  v.view.select(qn.id);
  const ta = v.q('.ibx-text');
  assert.equal(v.el.querySelectorAll('.ibx-option').length, 0);
  ta.value = 'Use port 8080';
  ta.dispatchEvent(new v.window.Event('input', { bubbles: true }));
  ta.dispatchEvent(new v.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
  assert.deepEqual(v.sent.at(-1), { type: 'inbox-answer', id: qn.id, text: 'Use port 8080' });
});

test('sending re-enables when the item comes back changed (a refused answer)', () => {
  const v = mountView();
  const qn = item({ allowFreeText: true });
  v.view.update(graphOf([qn]));
  v.view.select(qn.id);
  const ta = v.q('.ibx-text');
  ta.value = 'x';
  ta.dispatchEvent(new v.window.Event('input', { bubbles: true }));
  v.q('.ibx-send').click();
  assert.equal(v.q('.ibx-send').disabled, true);
  v.view.update(graphOf([{ ...qn, updatedAt: qn.updatedAt + 1 }]));
  assert.equal(v.q('.ibx-send').disabled, false);
  assert.equal(v.q('.ibx-text').value, 'x', 'the draft survives');
});

test('an answered item that failed to deliver shows the answer, the error and Retry', () => {
  const v = mountView();
  const f = failedItem({ options: [{ id: 'go', label: 'Go' }], answer: { optionId: 'go', text: 'now', at: 1, delivery: 'failed', deliveryError: 'tmux went away', attempts: 1 } });
  v.view.update(graphOf([f]));
  v.view.select(f.id);
  assert.equal(text(v.q('.ibx-answer-choice')), 'You chose: Go');
  assert.equal(text(v.q('.ibx-answer-note')), 'Note: now');
  assert.equal(text(v.q('.ibx-delivery')), 'Not delivered: tmux went away');
  assert.ok(v.q('.ibx-retry').classList.contains('ibx-primary'), 'Retry leads when retrying can work');
  assert.ok(!v.q('.ibx-dismiss').classList.contains('ibx-primary'));
  v.q('.ibx-retry').click();
  assert.deepEqual(v.sent.at(-1), { type: 'inbox-retry', id: f.id });
});

test('a failed delivery to an archived session names it, and Dismiss leads', () => {
  for (const [why, f, core] of [
    ['the error says archived', failedItem({ answer: { optionId: null, text: 'x', at: 1, delivery: 'failed', deliveryError: 'Session s1 is archived; restore it first', attempts: 1 } }), {}],
    ['the board lists it archived', failedItem({ answer: { optionId: null, text: 'x', at: 1, delivery: 'failed', deliveryError: 'refused', attempts: 1 } }), { history: [{ sessionId: 's1' }] }],
  ]) {
    const v = mountView();
    v.view.update({ ...graphOf([f]), ...core });
    v.view.select(f.id);
    assert.equal(text(v.q('.ibx-delivery')), 'Not delivered: Worker is archived. Restore it from the archive, then retry, or dismiss this.', why);
    assert.ok(!v.q('.ibx-delivery').textContent.includes('s1'), `${why}: no raw card id`);
    const buttons = [...v.q('.ibx-d-answered .ibx-actions').querySelectorAll('button')];
    assert.ok(buttons[0].classList.contains('ibx-dismiss') && buttons[0].classList.contains('ibx-primary'), `${why}: Dismiss is first and primary`);
    assert.ok(!v.q('.ibx-retry').classList.contains('ibx-primary'), `${why}: Retry is secondary`);
  }
});

test('dismissing an agent item asks first: the agent will not be told', () => {
  const v = mountView();
  const d = item();
  v.view.update(graphOf([d]));
  v.view.select(d.id);
  v.q('.ibx-dismiss').click();
  assert.equal(v.sent.filter((f) => f.type === 'inbox-dismiss').length, 0);
  assert.equal(text(v.q('.ibx-confirm-text')), 'The agent will not be told.');
  v.q('.ibx-confirm-no').click();
  assert.equal(v.q('.ibx-confirm'), null);
  v.q('.ibx-dismiss').click();
  v.q('.ibx-confirm-yes').click();
  assert.deepEqual(v.sent.at(-1), { type: 'inbox-dismiss', id: d.id });
});

test('markdown lands only in the body container; agent text elsewhere is inert text', () => {
  const v = mountView();
  const d = item({
    title: `Title ${XSS}`, body: `**bold** ${XSS}`,
    options: [{ id: 'a', label: `Opt ${XSS}`, description: XSS }], allowFreeText: true,
  });
  const s = statusItem({ title: XSS, sessionId: 's2', body: XSS, status: { waitingFor: XSS, waitingReason: null, episode: 'e' } });
  const graph = graphOf([d, s], { sessions: { s1: { name: XSS, taskName: XSS }, s2: { name: 'Other' } } });
  v.view.update(graph);
  v.view.select(d.id);
  assert.equal(v.el.querySelectorAll('img').length, 0);
  assert.equal(v.el.querySelectorAll('.md').length, 1);
  assert.ok(v.q('.ibx-body .md'), 'the rendered markdown is inside .ibx-body');
  assert.equal(text(v.q('.ibx-d-title')), `Title ${XSS}`);
  assert.equal(text(v.q('.ibx-option-label')), `Opt ${XSS}`);
  assert.equal(text(v.q('.ibx-d-session')), XSS);
  assert.ok(v.rows().some((r) => text(r.querySelector('.ibx-row-title')) === `Title ${XSS}`));
  v.view.select(s.id);
  assert.equal(text(v.q('.ibx-terminal-text')), XSS, 'terminal text goes through the sanitiser');
  assert.equal(v.el.querySelectorAll('img').length, 0);
  assert.equal(globalThis.pwned, undefined);
});

test('an unchanged tick keeps row nodes, scroll and the half-typed answer', () => {
  const v = mountView();
  const a = item({ createdAt: 1, allowFreeText: true });
  const b = statusItem({ createdAt: 0 });
  v.view.update(graphOf([a, b]));
  v.view.select(a.id);
  const before = v.rows();
  const ta = v.q('.ibx-text');
  ta.value = 'half a tho';
  ta.dispatchEvent(new v.window.Event('input', { bubbles: true }));
  ta.focus();
  const pane = v.q('.ibx-list-pane');
  pane.scrollTop = 40;
  v.tick(MIN);
  // A fresh graph object with equal items, as every rebuild sends; the mark-read
  // landing (readAt set) must not rebuild the detail either.
  v.view.update(graphOf([{ ...a, readAt: 5 }, { ...b }]));
  const after = v.rows();
  assert.equal(after.length, 2);
  assert.ok(after.every((r, i) => r === before[i]), 'same row elements');
  assert.equal(v.q('.ibx-text'), ta, 'same textarea');
  assert.equal(ta.value, 'half a tho');
  assert.equal(v.document.activeElement, ta);
  assert.equal(pane.scrollTop, 40);
  assert.equal(text(after[0].querySelector('.ibx-row-age')), 'waiting 21m', 'the age still moves');
});

test('mark-read is sent once per item, and only while the view is on screen', async () => {
  const v = mountView();
  const a = item();
  const b = item();
  v.host.classList.add('hidden');
  v.view.update(graphOf([a, b]));
  v.view.select(a.id);
  assert.equal(v.sent.filter((f) => f.type === 'inbox-mark-read').length, 0, 'not while hidden');
  v.host.classList.remove('hidden');
  await new Promise((r) => setTimeout(r, 0));
  v.view.update(graphOf([a, b]));
  v.view.update(graphOf([a, b]));
  v.view.select(b.id);
  v.view.select(a.id);
  v.view.update(graphOf([a, b]));
  assert.deepEqual(v.sent.filter((f) => f.type === 'inbox-mark-read'), [
    { type: 'inbox-mark-read', ids: [a.id] },
    { type: 'inbox-mark-read', ids: [b.id] },
  ]);
});

test('n jumps to the top item, and selection advances in queue order as items resolve', () => {
  const v = mountView();
  const blocked = statusItem({ createdAt: 5 });
  const high = item({ urgency: 'high', createdAt: 7 });
  const normal = item({ createdAt: 1 });
  const all = [normal, high, blocked];
  v.view.update(graphOf(all));
  v.press('n');
  assert.equal(v.view.selectedId, blocked.id, 'n selects the top item');
  v.press('n');
  assert.equal(v.view.selectedId, high.id, 'n on the top item moves on');
  v.view.select(blocked.id);
  // The blocked session went back to work while the human was looking at it.
  v.view.update(graphOf([normal, high, { ...blocked, state: 'resolved', resolvedReason: 'status-cleared' }]));
  assert.equal(v.view.selectedId, high.id, 'moves to the next item');
  // The human answers it; the answer is in flight.
  v.view.update(graphOf([normal, { ...high, state: 'answered', answer: { delivery: 'pending' } }]));
  assert.equal(v.view.selectedId, normal.id);
  v.view.update(graphOf([{ ...normal, state: 'resolved', resolvedReason: 'withdrawn' }]));
  assert.equal(v.view.selectedId, null);
  assert.equal(v.q('.ibx-empty').hidden, false);
});

test('the keyboard answers a decision with no mouse', () => {
  const v = mountView();
  const other = item({ createdAt: 9 });
  const d = item({ createdAt: 1, options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], allowFreeText: false });
  v.view.update(graphOf([other, d]));
  v.root.focus();
  v.press('n');
  assert.equal(v.view.selectedId, d.id);
  assert.equal(v.document.activeElement, v.q('.ibx-option'), 'focus on the primary control');
  v.press('2');
  assert.equal(v.q('.ibx-option[data-option-id="no"]').getAttribute('aria-checked'), 'true');
  assert.equal(v.document.activeElement, v.q('.ibx-send'));
  // Enter on a focused button is the button's own: the browser clicks it.
  const ev = v.press('Enter');
  assert.equal(ev.defaultPrevented, false);
  v.document.activeElement.click();
  assert.deepEqual(v.sent.filter((f) => f.type === 'inbox-answer'), [{ type: 'inbox-answer', id: d.id, optionId: 'no' }]);
  // The answer lands: selection and focus move to the next item.
  v.view.update(graphOf([other, { ...d, state: 'answered', answer: { delivery: 'pending' } }]));
  assert.equal(v.view.selectedId, other.id);
  assert.ok(v.root.contains(v.document.activeElement));
});

test('j/k and arrows move the selection; e dismisses; shortcuts ignore typing', () => {
  const v = mountView();
  const a = statusItem({ createdAt: 1 });
  const b = item({ createdAt: 2, allowFreeText: true });
  v.view.update(graphOf([a, b]));
  v.root.focus();
  v.press('j');
  assert.equal(v.view.selectedId, a.id);
  v.press('ArrowDown');
  assert.equal(v.view.selectedId, b.id);
  v.press('k');
  assert.equal(v.view.selectedId, a.id);
  v.press('e');
  assert.deepEqual(v.sent.at(-1), { type: 'inbox-dismiss', id: a.id }, 'a status item dismisses at once');
  v.view.select(b.id, { focus: true });
  assert.equal(v.document.activeElement, v.q('.ibx-text'));
  v.press('n');
  v.press('e');
  assert.equal(v.view.selectedId, b.id);
  assert.equal(v.q('.ibx-confirm'), null, 'typing "e" in the answer box is just typing');
  v.root.focus();
  v.press('e');
  assert.ok(v.q('.ibx-confirm'));
  assert.equal(v.document.activeElement, v.q('.ibx-confirm-yes'));
  v.press('Escape');
  assert.equal(v.q('.ibx-confirm'), null);
});

test('narrow layouts open the detail on selection and Back returns to the list', () => {
  const v = mountView();
  const a = item();
  v.view.update(graphOf([a]));
  assert.ok(!v.root.classList.contains('ibx-detail-open'));
  v.rows()[0].click();
  assert.ok(v.root.classList.contains('ibx-detail-open'));
  v.q('.ibx-back').click();
  assert.ok(!v.root.classList.contains('ibx-detail-open'));
});

test('selecting an item that has not arrived yet selects it when it does', () => {
  const v = mountView();
  const a = item();
  v.view.update(graphOf([]));
  assert.equal(v.view.select(a.id, { focus: true }), false);
  v.view.update(graphOf([a]));
  assert.equal(v.view.selectedId, a.id);
});

/* ── F15: a resolved item opens read-only ─────────────────────────────────── */

const ANSWER_CONTROLS = '.ibx-option, .ibx-text, .ibx-send, .ibx-dismiss, .ibx-confirm, .ibx-retry, .ibx-terminal-toggle';

test('a resolved agent item opens read-only: options with the choice marked, the note, how and when it closed', () => {
  const v = mountView();
  const live = item({ createdAt: 1 });
  const done = item({
    title: 'Ship it?', body: 'Context **here**', createdAt: 2 * MIN, updatedAt: 15 * MIN,
    state: 'resolved', resolvedReason: 'delivered',
    options: [{ id: 'yes', label: 'Yes', description: 'Ship now' }, { id: 'no', label: 'No' }],
    answer: { optionId: 'yes', text: 'after lunch', at: 14 * MIN, delivery: 'delivered', deliveryError: null, attempts: 1 },
  });
  v.view.update(graphOf([live, done]));
  v.filter('closed').click();
  v.el.querySelector(`.ibx-queue .ibx-row[data-id="${done.id}"]`).click();
  assert.equal(v.view.selectedId, done.id);
  assert.ok(v.q(`.ibx-queue .ibx-row[data-id="${done.id}"]`).classList.contains('ibx-selected'));
  assert.ok(v.q('.ibx-d-readonly'));
  assert.equal(text(v.q('.ibx-d-title')), 'Ship it?');
  assert.match(text(v.q('.ibx-d-kind')), /Decision/);
  assert.equal(text(v.q('.ibx-d-session')), 'Worker');
  assert.equal(text(v.q('.ibx-d-task')), 'Auth');
  assert.equal(text(v.q('.ibx-d-age')), 'asked 18m ago');
  assert.ok(v.q('.ibx-body .md'), 'the body is sanitised markdown, as for open items');
  const opts = [...v.el.querySelectorAll('.ibx-ro-option')];
  assert.deepEqual(opts.map((o) => text(o.querySelector('.ibx-option-label'))), ['Yes', 'No']);
  assert.ok(opts[0].classList.contains('ibx-chosen'));
  assert.equal(text(opts[0].querySelector('.ibx-ro-chosen')), 'Your choice');
  assert.ok(!opts[1].classList.contains('ibx-chosen'));
  assert.equal(text(v.q('.ibx-answer-note')), 'Your note: after lunch');
  assert.equal(text(v.q('.ibx-d-closed-reason')), 'Closed: answered');
  assert.equal(v.q('.ibx-d-closed-at').getAttribute('datetime'), new Date(15 * MIN).toISOString());
  assert.equal(text(v.q('.ibx-d-closed-age')), '5m ago');
  assert.equal(v.el.querySelectorAll(ANSWER_CONTROLS).length, 0, 'no answer, dismiss or retry controls');
  assert.equal(v.q('.ibx-d-readonly .ibx-actions'), null, 'no button row');
  assert.deepEqual([...v.q('.ibx-detail').querySelectorAll('button')].map((b) => b.className), ['ibx-btn ibx-link ibx-d-session'],
    'no buttons apart from the header session link');

  v.press('e');
  v.press('1');
  assert.equal(v.sent.filter((f) => f.type !== 'inbox-mark-read').length, 0, 'e and 1-6 do nothing on a read-only item');

  // The tick moves the relative time, and the selection stays put.
  v.tick(MIN);
  v.view.update(graphOf([live, done]));
  assert.equal(v.view.selectedId, done.id);
  assert.equal(text(v.q('.ibx-d-closed-age')), '6m ago');

  v.q('.ibx-d-session').click();
  assert.deepEqual(v.opened, ['s1'], 'the header link still opens the session');
});

test('a dismissed agent item shows how it closed and no answer', () => {
  const v = mountView();
  const d = item({ title: 'Never mind', state: 'resolved', resolvedReason: 'dismissed', updatedAt: 19 * MIN });
  v.view.update(graphOf([d]));
  assert.equal(v.view.select(d.id), true);
  assert.equal(text(v.q('.ibx-d-closed-reason')), 'Closed: dismissed');
  assert.equal(v.q('.ibx-ro-options'), null);
  assert.equal(v.q('.ibx-answer-note'), null);
  assert.equal(v.el.querySelectorAll(ANSWER_CONTROLS).length, 0);
  assert.equal(v.q('.ibx-d-readonly button'), null);
});

test('a cleared status item shows its terminal text, read-only, with no terminal toggle', () => {
  const v = mountView();
  const s = statusItem({ state: 'resolved', resolvedReason: 'status-cleared', updatedAt: 18 * MIN });
  v.view.update(graphOf([s]));
  v.view.select(s.id);
  assert.equal(text(v.q('.ibx-terminal-text')), 'Approve a Bash command');
  assert.equal(v.q('.ibx-d-guidance'), null, 'nothing left to do, so no guidance');
  assert.equal(text(v.q('.ibx-d-closed-reason')), 'Closed: resolved in the session');
  assert.equal(v.el.querySelectorAll(ANSWER_CONTROLS).length, 0);
  assert.equal(v.mounts.length, 0);
});

test('j/k walk the list that is showing', () => {
  const v = mountView();
  const a = item({ createdAt: 1 });
  const r1 = item({ state: 'resolved', resolvedReason: 'withdrawn', updatedAt: 19 * MIN });
  const r2 = item({ state: 'resolved', resolvedReason: 'expired', updatedAt: 18 * MIN });
  v.view.update(graphOf([a, r1, r2]));
  v.root.focus();
  v.press('j');
  v.press('j');
  assert.equal(v.view.selectedId, a.id, 'Open: the closed items are out of reach');
  v.filter('all').click();
  v.root.focus();
  v.press('j');
  assert.equal(v.view.selectedId, r1.id);
  assert.equal(v.document.activeElement, v.q(`.ibx-queue .ibx-row[data-id="${r1.id}"]`));
  v.press('j');
  assert.equal(v.view.selectedId, r2.id);
  v.press('j');
  assert.equal(v.view.selectedId, r2.id, 'stops at the end');
  v.press('k');
  v.press('k');
  assert.equal(v.view.selectedId, a.id);
  v.filter('closed').click();
  assert.equal(v.view.selectedId, null, 'an open item is not shown under Closed');
  v.root.focus();
  v.press('j');
  assert.equal(v.view.selectedId, r1.id);
  // Enter on a read-only item focuses its header's session link.
  v.root.focus();
  v.press('Enter');
  assert.equal(v.document.activeElement, v.q('.ibx-d-session'));
});

test('agent text in a read-only item stays inert', () => {
  const v = mountView();
  const d = item({
    title: XSS, body: XSS, state: 'resolved', resolvedReason: 'delivered',
    options: [{ id: 'a', label: XSS, description: XSS }],
    answer: { optionId: 'a', text: XSS, at: 1, delivery: 'delivered', deliveryError: null, attempts: 1 },
  });
  const s = statusItem({ title: XSS, body: XSS, state: 'resolved', resolvedReason: 'status-cleared', status: { waitingFor: XSS, waitingReason: null, episode: 'e' } });
  v.view.update(graphOf([d, s], { sessions: { s1: { name: XSS, taskName: XSS } } }));
  v.filter('closed').click();
  v.view.select(d.id);
  assert.equal(v.el.querySelectorAll('img').length, 0);
  assert.equal(text(v.q('.ibx-ro-option .ibx-option-label')), XSS);
  assert.equal(text(v.q('.ibx-answer-note')), `Your note: ${XSS}`);
  v.view.select(s.id);
  assert.equal(v.el.querySelectorAll('img').length, 0);
  assert.equal(text(v.q('.ibx-terminal-text')), XSS);
  assert.equal(globalThis.pwned, undefined);
});

test('rows and the detail show the cause label, and only failures are red', () => {
  const v = mountView();
  const perm = statusItem({ createdAt: 1 });
  const box = statusItem({ createdAt: 2, sessionId: 's2', status: { waitingFor: 'container bring-up failed', waitingReason: null, episode: 'e', cause: 'container' } });
  const old = statusItem({ createdAt: 3, sessionId: 's3', status: { waitingFor: 'x', waitingReason: null, episode: 'e' } });
  v.view.update(graphOf([perm, box, old]));
  const rows = v.rows();
  assert.deepEqual(rows.map((r) => text(r.querySelector('.ibx-row-kind-label'))), ['Permission', 'Blocked', 'Waiting']);
  assert.deepEqual(rows.map((r) => r.classList.contains('ibx-alarm')), [false, true, false]);
  assert.equal(rows[0].querySelector('.ibx-row-icon').dataset.kind, 'cause-permission');
  v.view.select(box.id);
  assert.equal(text(v.q('.ibx-d-kind')), 'Blocked');
  assert.ok(v.q('.ibx-d-kind').classList.contains('ibx-alarm'));
  assert.equal(text(v.q('.ibx-d-guidance')), "The session's container did not start. Open the session to see the error.");
});

test("a status item whose body is only core's phrase shows guidance and no terminal box", () => {
  const v = mountView();
  const s = statusItem({ body: '', status: { waitingFor: 'input needed', waitingReason: null, episode: 'e', cause: 'question' } });
  const legacy = statusItem({ sessionId: 's2', body: 'trust dialog', status: { waitingFor: 'trust dialog', waitingReason: null, episode: 'e', cause: 'trust' } });
  v.view.update(graphOf([s, legacy]));
  for (const it of [s, legacy]) {
    v.view.select(it.id);
    assert.ok(v.q('.ibx-d-guidance'));
    assert.equal(v.q('.ibx-from-terminal'), null);
    assert.equal(v.q('.ibx-body'), null);
  }
});

test('an urgent request carries an Urgent tag on its row and in its detail', () => {
  const v = mountView();
  const u = item({ urgency: 'high', title: 'Force-push?' });
  const n = item({ title: 'Normal' });
  v.view.update(graphOf([n, u]));
  const [first, second] = v.rows();
  assert.equal(first.dataset.id, u.id, 'urgent sorts first');
  assert.equal(text(first.querySelector('.ibx-tag-urgent')), 'Urgent');
  assert.equal(text(second.querySelector('.ibx-tag-urgent')), '');
  v.view.select(u.id);
  assert.equal(text(v.q('.ibx-d-head .ibx-tag-urgent')), 'Urgent');
});

test('two panes: the queue opens on its first item, without focus or marking it read', () => {
  const v = mountView({ twoPanes: () => true });
  v.view.update(graphOf([]));
  assert.equal(v.view.selectedId, null, 'an empty queue selects nothing');
  const a = statusItem({ createdAt: 1 });
  const b = item({ createdAt: 2 });
  v.view.update(graphOf([a, b]));
  assert.equal(v.view.selectedId, a.id);
  assert.equal(text(v.q('.ibx-d-title')), a.title);
  assert.ok(!v.root.contains(v.document.activeElement) || v.document.activeElement === v.root || v.document.activeElement === v.document.body);
  assert.equal(v.sent.filter((f) => f.type === 'inbox-mark-read').length, 0, 'not marked read');
  // n starts on the item shown, then moves on.
  v.press('n');
  assert.equal(v.view.selectedId, a.id);
  assert.deepEqual(v.sent.filter((f) => f.type === 'inbox-mark-read'), [{ type: 'inbox-mark-read', ids: [a.id] }]);
  v.press('n');
  assert.equal(v.view.selectedId, b.id);
});

test('one pane: nothing is selected until the human picks', () => {
  const v = mountView({ twoPanes: () => false });
  v.view.update(graphOf([item()]));
  assert.equal(v.view.selectedId, null);
});

test('n jumps back to the top item from lower down the queue', () => {
  const v = mountView();
  const a = item({ createdAt: 1 });
  const b = item({ createdAt: 2 });
  const c = item({ createdAt: 3 });
  v.view.update(graphOf([a, b, c]));
  v.view.select(c.id);
  v.press('n');
  assert.equal(v.view.selectedId, a.id, 'from the third item, n goes to the top, not the item below');
});

test('the answer box has a visible label', () => {
  const v = mountView();
  const open = item({ kind: 'question' });
  const withOpts = item({ options: [{ id: 'a', label: 'A' }], allowFreeText: true });
  v.view.update(graphOf([open, withOpts]));
  v.view.select(open.id);
  const label = v.q('.ibx-text-label');
  assert.equal(text(label), 'Your answer');
  assert.equal(label.htmlFor, v.q('.ibx-text').id);
  v.view.select(withOpts.id);
  assert.equal(text(v.q('.ibx-text-label')), 'Your answer, or a note with your choice');
});

test('an action has a main Done button that answers "done", with the note', () => {
  const v = mountView();
  const a = item({ kind: 'action', blocking: false, title: 'Install the app' });
  v.view.update(graphOf([a]));
  v.view.select(a.id, { focus: true });
  const done = v.q('.ibx-done');
  assert.ok(done.classList.contains('ibx-primary'));
  assert.ok(!v.q('.ibx-send').classList.contains('ibx-primary'), 'Send is secondary');
  assert.equal(text(v.q('.ibx-text-label')), 'Add a note (optional)');
  assert.equal(v.document.activeElement, done, 'Done is the primary control');
  const ta = v.q('.ibx-text');
  ta.value = 'also on staging';
  ta.dispatchEvent(new v.window.Event('input'));
  v.q('.ibx-done').click();
  assert.deepEqual(v.sent.at(-1), { type: 'inbox-answer', id: a.id, text: 'done\n\nalso on staging' });
});

test('a non-blocking request says the agent is still working', () => {
  const v = mountView();
  const nb = item({ blocking: false });
  const b = item();
  v.view.update(graphOf([nb, b]));
  v.view.select(nb.id);
  assert.equal(text(v.q('.ibx-d-working')), 'The agent is still working.');
  v.view.select(b.id);
  assert.equal(v.q('.ibx-d-working'), null);
});

test('an agent request opens its session on the remembered tab, not the Terminal', () => {
  const v = mountView();
  const a = item();
  v.view.update(graphOf([a]));
  v.view.select(a.id);
  v.q('.ibx-d-session').click();
  assert.equal(v.opened.length, 1);
  assert.equal(v.window.localStorage.getItem('cm-session-view'), null);
});

test('the session link of a blocked item and Show terminal here both ask for the Terminal', () => {
  const v = mountView();
  const s = statusItem();
  v.view.update(graphOf([s]));
  v.view.select(s.id);
  v.window.localStorage.setItem('cm-session-view', JSON.stringify({ other: 'chat' }));
  v.q('.ibx-terminal-toggle').click();
  assert.deepEqual(JSON.parse(v.window.localStorage.getItem('cm-session-view')), { other: 'chat', [s.sessionId]: 'terminal' });
  v.window.localStorage.removeItem('cm-session-view');
  v.q('.ibx-d-session').click();
  assert.deepEqual(JSON.parse(v.window.localStorage.getItem('cm-session-view')), { [s.sessionId]: 'terminal' });
});

const liveGraph = (items, core = [...new Set(items.map((i) => i.sessionId))].map((sessionId) => ({ sessionId, managed: true }))) => graphOf(items, { core });
const settleVisibility = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a desktop auto-pick has no terminal side effects; explicitly opening that same approval mounts once', () => {
  const v = mountView({ twoPanes: () => true });
  const s = statusItem({ title: 'Tool permission', status: { cause: 'permission', waitingReason: 'permission' } });
  const outside = v.document.createElement('input');
  v.document.body.append(outside);
  outside.focus();
  v.view.update(liveGraph([s]));
  assert.equal(v.view.selectedId, s.id);
  assert.equal(v.mounts.length, 0);
  assert.equal(v.window.localStorage.getItem('cm-session-view'), null);
  assert.deepEqual(v.sent, []);
  v.view.select(s.id);
  assert.equal(v.mounts.length, 1);
  assert.equal(v.mounts[0].sid, s.sessionId);
  assert.equal(v.mounts[0].target, v.q('.ibx-terminal'));
  assert.equal(v.q('.ibx-terminal').hidden, false);
  assert.equal(text(v.q('.ibx-terminal-toggle')), 'Hide terminal');
  assert.deepEqual(JSON.parse(v.window.localStorage.getItem('cm-session-view')), { s1: 'terminal' });
  assert.equal(v.document.activeElement, outside);
  assert.deepEqual(v.sent.filter((f) => f.type !== 'inbox-mark-read'), []);
  assert.deepEqual(v.opened, []);
  v.view.update(liveGraph([{ ...s, updatedAt: 2000, body: 'Restated prompt' }]));
  v.view.update(liveGraph([structuredClone(s)]));
  assert.equal(v.mounts.length, 1, 'restatements and graph copies do not remount');
  assert.equal(v.document.activeElement, outside);
});

test('automatic embedding restores focus even when the host mount focuses its terminal', () => {
  let mountedInput;
  const v = mountView({ twoPanes: () => true, api: { mountSession(target) {
    mountedInput = target.ownerDocument.createElement('textarea');
    target.append(mountedInput);
    mountedInput.focus();
    return { unmount() { mountedInput.remove(); } };
  } } });
  const outside = v.document.createElement('input');
  v.document.body.append(outside);
  outside.focus();
  const s = statusItem();
  v.view.update(liveGraph([s]));
  v.view.select(s.id);
  assert.ok(mountedInput, 'the host mounted');
  assert.equal(v.document.activeElement, outside);
});

test('Hide persists through ticks and view changes for this selection; each new approval selection opens', async () => {
  const v = mountView({ twoPanes: () => true });
  const a = statusItem({ createdAt: 1 });
  const b = statusItem({ createdAt: 2, sessionId: 's2' });
  v.view.update(liveGraph([a, b]));
  v.view.select(a.id);
  assert.equal(v.mounts.length, 1);
  v.q('.ibx-terminal-toggle').click();
  assert.equal(v.mounts[0].unmounted, true);
  v.view.update(liveGraph([{ ...a, updatedAt: 3000 }, b]));
  v.host.classList.add('hidden');
  await settleVisibility();
  v.host.classList.remove('hidden');
  await settleVisibility();
  assert.equal(v.mounts.length, 1);
  assert.equal(text(v.q('.ibx-terminal-toggle')), 'Show terminal here');
  v.view.select(b.id);
  assert.equal(v.mounts.length, 2);
  v.view.select(a.id);
  assert.equal(v.mounts[1].unmounted, true);
  assert.equal(v.mounts.length, 3);
  v.view.unmount();
  assert.equal(v.mounts[2].unmounted, true);
  v.view.update(liveGraph([a, b]));
  assert.equal(v.mounts.length, 3, 'unmounted view cannot reacquire the terminal');
});

test('hidden views never mount and release when hidden, then remount when visible', async () => {
  const v = mountView({ twoPanes: () => true });
  const s = statusItem();
  v.host.classList.add('hidden');
  v.view.update(liveGraph([s]));
  v.view.select(s.id);
  assert.equal(v.mounts.length, 0);
  v.host.classList.remove('hidden');
  await settleVisibility();
  assert.equal(v.mounts.length, 1, 'visibility alone opens the selected detail');
  v.host.classList.add('hidden');
  await settleVisibility();
  assert.equal(v.mounts[0].unmounted, true);
  v.view.update(liveGraph([s]));
  assert.equal(v.mounts.length, 1);
  v.host.classList.remove('hidden');
  await settleVisibility();
  assert.equal(v.mounts.length, 2);
});

test('phone list navigation never mounts offscreen details; Back releases and reopening mounts', () => {
  const v = mountView({ twoPanes: () => false });
  const a = statusItem({ createdAt: 1 });
  const b = statusItem({ createdAt: 2 });
  v.view.update(liveGraph([a, b]));
  v.press('j');
  assert.equal(v.view.selectedId, a.id);
  assert.equal(v.mounts.length, 0);
  v.view.select(a.id);
  assert.equal(v.mounts.length, 1);
  v.q('.ibx-back').click();
  assert.equal(v.mounts[0].unmounted, true);
  v.view.update(liveGraph([a, b]));
  assert.equal(v.mounts.length, 1);
  v.view.select(a.id);
  assert.equal(v.mounts.length, 2);
});

test('closing detail, resolving, disappearing and becoming dormant all release embeds', () => {
  for (const change of ['close', 'resolved', 'missing', 'dormant', 'cause']) {
    const v = mountView({ twoPanes: () => true });
    const s = statusItem();
    v.view.update(liveGraph([s]));
    v.view.select(s.id);
    assert.equal(v.mounts.length, 1, change);
    if (change === 'close') v.q('.ibx-close').click();
    if (change === 'resolved') v.view.update(liveGraph([{ ...s, state: 'resolved', resolvedReason: 'status-cleared' }]));
    if (change === 'missing') v.view.update(liveGraph([]));
    if (change === 'dormant') v.view.update(liveGraph([s], [{ sessionId: s.sessionId, managed: false }]));
    if (change === 'cause') v.view.update(liveGraph([{ ...s, status: { cause: 'question' } }]));
    assert.equal(v.mounts[0].unmounted, true, change);
    assert.equal(v.q('.ibx-terminal').hidden, true, change);
    v.view.unmount();
  }
});

test('non-permission statuses, agent approvals, closed and unavailable sessions do not auto-mount', () => {
  const excluded = [
    ...['question', 'trust', 'sign-in', 'other', undefined].map((cause) => statusItem({ title: 'Codex requires your approval', status: { cause } })),
    item({ kind: 'approval', status: { cause: 'permission' } }),
    statusItem({ state: 'resolved', resolvedReason: 'status-cleared' }),
    statusItem({ state: 'answered', answer: { delivery: 'pending' } }),
  ];
  for (const s of excluded) {
    const v = mountView({ twoPanes: () => true });
    v.view.update(liveGraph([s]));
    v.view.select(s.id);
    assert.equal(v.mounts.length, 0, `${s.source} ${s.state} ${s.status?.cause}`);
    v.view.unmount();
  }
  for (const core of [[], [{ sessionId: 's1', managed: false }], [{ sessionId: 's1', managed: true, archived: true }]]) {
    const v = mountView({ twoPanes: () => true });
    const s = statusItem();
    v.view.update(liveGraph([s], core));
    v.view.select(s.id);
    assert.equal(v.mounts.length, 0, 'unavailable session is never resumed by viewing a prompt');
  }
});

test('missing, null and throwing mount support preserve Open session without automatic retry storms', async () => {
  for (const mode of ['missing', 'null', 'throw']) {
    let attempts = 0;
    const v = mountView({ twoPanes: () => true, api: { mountSession: mode === 'missing' ? undefined : () => {
      attempts++;
      if (mode === 'throw') throw new Error('Embedding unavailable');
      return null;
    } } });
    const s = statusItem();
    assert.doesNotThrow(() => v.view.update(liveGraph([s])));
    v.view.update(liveGraph([s]));
    v.view.select(s.id);
    v.host.classList.add('hidden');
    await settleVisibility();
    v.host.classList.remove('hidden');
    await settleVisibility();
    assert.equal(attempts, mode === 'missing' ? 0 : 1);
    assert.equal(v.q('.ibx-terminal').hidden, true);
    v.q('.ibx-open-session').click();
    assert.deepEqual(v.opened, [s.sessionId]);
    if (mode !== 'missing') {
      assert.equal(text(v.q('.ibx-terminal-toggle')), 'Show terminal here');
      v.q('.ibx-terminal-toggle').click();
      assert.equal(attempts, 2, 'an explicit retry is allowed');
    }
    v.view.unmount();
  }
});

test('a pending approval selection mounts only after arrival and visibility', async () => {
  const v = mountView({ twoPanes: () => true });
  const s = statusItem();
  v.host.classList.add('hidden');
  assert.equal(v.view.select(s.id, { focus: true }), false);
  v.view.update(liveGraph([s]));
  assert.equal(v.mounts.length, 0);
  v.host.classList.remove('hidden');
  await settleVisibility();
  assert.equal(v.mounts.length, 1);
  assert.equal(v.document.activeElement, v.q('.ibx-open-session'));
  v.view.update(liveGraph([s]));
  assert.equal(v.mounts.length, 1);
});

test('native hidden releases an approval and prevents graph ticks from remounting', async () => {
  const v = mountView({ twoPanes: () => true });
  const s = statusItem();
  v.view.update(liveGraph([s]));
  v.view.select(s.id);
  v.host.hidden = true;
  await settleVisibility();
  assert.equal(v.mounts[0].unmounted, true);
  v.view.update(liveGraph([s]));
  assert.equal(v.mounts.length, 1);
  v.host.hidden = false;
  await settleVisibility();
  assert.equal(v.mounts.length, 2);
});

test('an approval opened with desktop keyboard navigation releases when resize hides its detail on phone', () => {
  let resize;
  let disconnected = false;
  let wide = true;
  const v = mountView({ twoPanes: () => wide, beforeMount(window) {
    window.ResizeObserver = class {
      constructor(callback) { resize = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    };
  } });
  v.view.update(liveGraph([statusItem()]));
  v.press('j');
  assert.equal(v.mounts.length, 1);
  wide = false;
  assert.equal(typeof resize, 'function');
  resize();
  assert.equal(v.mounts[0].unmounted, true);
  assert.equal(v.q('.ibx-terminal').hidden, true);
  wide = true;
  resize();
  assert.equal(v.mounts.length, 2);
  v.view.unmount();
  assert.equal(disconnected, true);
});

test('manual terminals for other statuses keep working, with no automatic default', () => {
  const v = mountView({ twoPanes: () => true });
  const s = statusItem({ status: { cause: 'question' } });
  v.view.update(liveGraph([s]));
  assert.equal(v.mounts.length, 0);
  v.q('.ibx-terminal-toggle').click();
  assert.equal(v.mounts.length, 1);
  v.view.update(liveGraph([s]));
  assert.equal(v.mounts.length, 1);
  v.q('.ibx-terminal-toggle').click();
  assert.equal(v.mounts[0].unmounted, true);
  v.view.update(liveGraph([s]));
  assert.equal(v.mounts.length, 1);
});

test('real host embed lends and releases its singleton without hidden-view takeover', { skip: !process.env.AW_REPO }, async () => {
  const { pathToFileURL } = await import('node:url');
  const { resolve } = await import('node:path');
  const { createSessionEmbed } = await import(pathToFileURL(resolve(process.env.AW_REPO, 'public/session-embed.js')).href);
  let embed;
  const v = mountView({ twoPanes: () => true, api: { mountSession: (target, sid) => embed.mount(target, sid) } });
  const home = v.document.createElement('div');
  const sidebar = v.document.createElement('div');
  const input = v.document.createElement('textarea');
  sidebar.append(input);
  home.append(sidebar);
  v.document.body.append(home);
  const shows = [];
  const releases = [];
  embed = createSessionEmbed({ document: v.document, parts: () => ({ sidebar }),
    show(sid) { shows.push(sid); input.focus(); }, release(o) { releases.push(o.sessionId); } });
  const outside = v.document.createElement('input');
  v.document.body.append(outside);
  outside.focus();
  const a = statusItem({ sessionId: 's1', createdAt: 1 });
  const b = statusItem({ sessionId: 's2', createdAt: 2 });
  v.view.update(liveGraph([a, b]));
  v.view.select(a.id);
  assert.ok(v.q('.ibx-terminal').contains(sidebar));
  assert.equal(v.document.activeElement, outside);
  v.view.update(liveGraph([a, b]));
  assert.deepEqual(shows, ['s1']);
  v.view.select(b.id);
  assert.deepEqual(releases, ['s1']);
  assert.deepEqual(shows, ['s1', 's2']);
  v.host.classList.add('hidden');
  await settleVisibility();
  assert.equal(sidebar.parentElement, home);
  assert.equal(embed.owner(), null);
  const other = v.document.createElement('div');
  v.document.body.append(other);
  const otherHandle = embed.mount(other, 'other');
  v.view.update(liveGraph([a, b]));
  assert.equal(embed.active().el, other);
  assert.equal(otherHandle.sessionId, 'other');
  otherHandle.unmount();
  v.host.classList.remove('hidden');
  await settleVisibility();
  assert.ok(v.q('.ibx-terminal').contains(sidebar));
  v.view.unmount();
  assert.equal(embed.owner(), null);
  assert.equal(sidebar.parentElement, home);
});

test('advancing after resolution only previews the next approval without mounting it', () => {
  const v = mountView({ twoPanes: () => true });
  const a = statusItem({ createdAt: 1 });
  const b = statusItem({ createdAt: 2, sessionId: 's2' });
  v.view.update(liveGraph([a, b]));
  v.view.select(a.id);
  assert.equal(v.mounts.length, 1);
  v.view.update(liveGraph([{ ...a, state: 'resolved', resolvedReason: 'status-cleared' }, b]));
  assert.equal(v.view.selectedId, b.id);
  assert.equal(v.mounts[0].unmounted, true);
  assert.equal(v.mounts.length, 1);
  assert.equal(v.window.localStorage.getItem('cm-session-view'), null);
  v.view.select(b.id);
  assert.equal(v.mounts.length, 2);
});

test('an automatic terminal preference lasts only for the embed and restores Chat on release', () => {
  const v = mountView({ twoPanes: () => true });
  const s = statusItem();
  v.window.localStorage.setItem('cm-session-view', JSON.stringify({ s1: 'chat', other: 'chat' }));
  v.view.update(liveGraph([s]));
  v.view.select(s.id);
  assert.deepEqual(JSON.parse(v.window.localStorage.getItem('cm-session-view')), { s1: 'terminal', other: 'chat' });
  v.view.update(liveGraph([s]));
  assert.equal(v.mounts.length, 1);
  v.q('.ibx-terminal-toggle').click();
  assert.deepEqual(JSON.parse(v.window.localStorage.getItem('cm-session-view')), { s1: 'chat', other: 'chat' });
  v.q('.ibx-terminal-toggle').click();
  v.view.unmount();
  assert.deepEqual(JSON.parse(v.window.localStorage.getItem('cm-session-view')), { s1: 'terminal', other: 'chat' }, 'manual Show keeps its existing permanent preference');
});

test('failed automatic mounts restore the exact original preference without tick retries', () => {
  for (const mode of ['null', 'throw']) {
    let attempts = 0;
    const v = mountView({ twoPanes: () => true, api: { mountSession() {
      attempts++;
      if (mode === 'throw') throw new Error('not available');
      return null;
    } } });
    const raw = '{ "s1": "chat", "other": "terminal" }';
    v.window.localStorage.setItem('cm-session-view', raw);
    const s = statusItem();
    v.view.update(liveGraph([s]));
    v.view.select(s.id);
    assert.equal(v.window.localStorage.getItem('cm-session-view'), raw);
    v.view.update(liveGraph([s]));
    assert.equal(attempts, 1);
  }
});

test('host selection stack acknowledges and unsnoozes only deliberately opened approvals', { skip: !process.env.AW_REPO }, async () => {
  const { readFile } = await import('node:fs/promises');
  const { pathToFileURL } = await import('node:url');
  const { resolve } = await import('node:path');
  const { createContext, runInContext } = await import('node:vm');
  const { createSessionEmbed } = await import(pathToFileURL(resolve(process.env.AW_REPO, 'public/session-embed.js')).href);
  const { viewForSession: resolveSessionView } = await import(pathToFileURL(resolve(process.env.AW_REPO, 'public/session-view.js')).href);
  const source = await readFile(resolve(process.env.AW_REPO, 'public/app.js'), 'utf8');
  const hostFunction = (name) => {
    const found = source.match(new RegExp(`^function ${name}\\([^]*?^}\\n`, 'm'));
    assert.ok(found, `host still defines ${name}`);
    return found[0];
  };
  let embed;
  const v = mountView({ twoPanes: () => true, api: { mountSession: (target, sid) => embed.mount(target, sid) } });
  const main = v.document.createElement('main');
  const home = v.document.createElement('div');
  const sidebar = v.document.createElement('div');
  const input = v.document.createElement('textarea');
  sidebar.append(input);
  home.append(sidebar);
  main.append(home);
  v.document.body.append(main);
  const a = statusItem({ createdAt: 1 });
  const b = statusItem({ createdAt: 2, sessionId: 's2' });
  const sessions = [a, b].map((i) => ({ sessionId: i.sessionId, managed: true, snooze: true, updatedAt: 1000 }));
  const hostSent = [];
  const views = [];
  const noop = () => {};
  const host = createContext({ document: v.document, localStorage: v.window.localStorage, latestSessions: sessions,
    selectedSessionId: null, currentView: 'needsyou', acknowledgedAt: new Map(), justFinished: new Set(),
    ACK_KEY: 'wrangler.acknowledged', CHAT_VIEW_KEY: 'cm-session-view', chatViewDefault: true, resolveSessionView,
    persistJustFinished: noop, isDiffPanelOpen: () => false, disarmChatHandoff: noop,
    setUnread: noop, renderPanel: noop, syncShellTerminal: noop, syncHash: noop,
    send: (frame) => hostSent.push(frame), resumeDormant: () => assert.fail('must not launch a session'),
  });
  // Run the host's selection and preference code with unrelated panel rendering stubbed.
  runInContext(['showEmbeddedSession', 'selectSession', 'applyEmbedView', 'acknowledge', 'persistAcknowledged', 'readSessionViews', 'viewForSession']
    .map(hostFunction).join('\n'), host);
  host.renderSidebar = (s) => { views.push(host.viewForSession(s.sessionId)); input.focus(); };
  embed = createSessionEmbed({ document: v.document, parts: () => ({ sidebar }),
    show: (sid, owner) => host.showEmbeddedSession(sid, owner), release: () => { host.selectedSessionId = null; } });
  const raw = '{ "s1": "chat", "s2": "chat" }';
  v.window.localStorage.setItem('cm-session-view', raw);
  v.view.update(liveGraph([a, b], sessions));
  assert.equal(v.window.localStorage.getItem('wrangler.acknowledged'), null);
  assert.equal(v.window.localStorage.getItem('cm-session-view'), raw);
  assert.deepEqual(hostSent, []);
  assert.deepEqual(views, []);
  v.view.select(a.id);
  assert.deepEqual(views, ['terminal']);
  assert.equal(JSON.parse(v.window.localStorage.getItem('wrangler.acknowledged')).s1, 1000);
  assert.deepEqual(hostSent.map((frame) => ({ ...frame })), [{ type: 'snooze-clear', sessionId: 's1' }]);
  v.view.update(liveGraph([{ ...a, state: 'resolved', resolvedReason: 'status-cleared' }, b], sessions));
  assert.equal(v.view.selectedId, b.id);
  assert.equal(v.window.localStorage.getItem('cm-session-view'), raw);
  assert.equal(hostSent.length, 1, 'the next automatic preview is not unsnoozed');
  assert.equal(JSON.parse(v.window.localStorage.getItem('wrangler.acknowledged')).s2, undefined);
  v.view.select(b.id);
  assert.deepEqual(views, ['terminal', 'terminal']);
  v.view.unmount();
  assert.equal(v.window.localStorage.getItem('cm-session-view'), raw);
});

test('manual Open session commits its existing permanent Terminal choice after an automatic embed', () => {
  const v = mountView({ twoPanes: () => true });
  const s = statusItem();
  v.window.localStorage.setItem('cm-session-view', JSON.stringify({ s1: 'chat' }));
  v.view.update(liveGraph([s]));
  v.view.select(s.id);
  v.q('.ibx-open-session').click();
  v.view.unmount();
  assert.deepEqual(JSON.parse(v.window.localStorage.getItem('cm-session-view')), { s1: 'terminal' });
});

test('pagehide restores a temporary preference and pageshow can remount the explicit detail', () => {
  const v = mountView({ twoPanes: () => true });
  const s = statusItem();
  const raw = '{ "s1": "chat" }';
  v.window.localStorage.setItem('cm-session-view', raw);
  v.view.update(liveGraph([s]));
  v.view.select(s.id);
  v.window.dispatchEvent(new v.window.Event('pagehide'));
  assert.equal(v.window.localStorage.getItem('cm-session-view'), raw);
  assert.equal(v.mounts[0].unmounted, true);
  v.view.update(liveGraph([s]));
  assert.equal(v.mounts.length, 1);
  v.window.dispatchEvent(new v.window.Event('pageshow'));
  assert.equal(v.mounts.length, 2);
  v.view.unmount();
  v.window.dispatchEvent(new v.window.Event('pageshow'));
  assert.equal(v.mounts.length, 2);
  assert.equal(v.window.localStorage.getItem('cm-session-view'), raw);
});

test('all agent kinds offer standalone text despite old false metadata', () => {
  for (const kind of ['decision', 'approval', 'question', 'action']) {
    const v = mountView();
    const d = item({ kind, options: [{ id: 'a', label: 'A' }], allowFreeText: false });
    v.view.update(graphOf([d]));
    v.view.select(d.id);
    const ta = v.q('.ibx-text');
    for (const value of ['  ', 'x'.repeat(4001)]) {
      ta.value = value;
      ta.dispatchEvent(new v.window.Event('input', { bubbles: true }));
      assert.equal(v.q('.ibx-send').disabled, true);
    }
    ta.value = 'x'.repeat(4000);
    ta.dispatchEvent(new v.window.Event('input', { bubbles: true }));
    assert.equal(v.q('.ibx-send').disabled, false);
    v.q('.ibx-send').click();
    assert.deepEqual(v.sent.at(-1), { type: 'inbox-answer', id: d.id, text: 'x'.repeat(4000) });
  }
});
