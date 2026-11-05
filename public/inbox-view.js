// The "Needs you" view: a triage queue (list pane) and the selected item
// (detail pane), worked one item at a time: answering or dismissing moves on,
// and `n` jumps to the top item. The list shows Open, Closed or All (0.1.4,
// C2). A closed row opens read-only: what was asked, what was chosen, how and
// when it closed, with no buttons but the header's session link. At two panes
// an X (or Escape) closes the detail (C1).
//
// Two rules hold everywhere in this file:
// - Agent-written text (titles, option labels, notes, waitingFor, session and
//   task names) goes into the DOM with textContent only. The one exception is
//   the body, which goes through the board's sanitising api.ui.markdownPreview
//   into its own `.ibx-body` container.
// - The ~4 s graph tick patches in place. Queue rows are keyed (inbox-dom.js),
//   and the detail pane is rebuilt only when what it shows changes, so scroll,
//   focus and a half-typed answer survive a tick.
import { ICONS, kindIcon } from './icons.js';
import { patchList, setText, setAttr, setClass } from './inbox-dom.js';
import { preferTerminal, wantsTerminal } from './inbox-session-view.js';
import {
  queueOrder, closedOrder, closedAt, closedLabel, FILTERS, itemLabel, itemIconKey, isAlarm, isUrgent, guidanceFor,
  terminalText, resolvedLabel, waitingLabel, ageLabel, sessionMeta, sessionName, spawnedByLabel, inboxOf, isUnread,
  isFailed, nextAfter, answerPayload, hasDone, donePayload, deliveryProblem,
} from './inbox-model.js';

export { queueOrder } from './inbox-model.js';

const LEAVE_MS = 250;
const SEND_TIMEOUT_MS = 10000;
const DISMISS_WARNING = 'The agent will not be told.';
const TWO_PANES_PX = 900; // styles.css: the narrow layout is a container query below this
const FILTER_KEY = 'needsyou.filter';

const EMPTY_TEXT = {
  open: 'Nothing needs you right now.',
  closed: 'Nothing closed in the last 24 hours.',
  all: 'Nothing in the last 24 hours.',
};
const LIST_LABEL = { open: 'Open items', closed: 'Closed items', all: 'All items' };

const SHELL_HTML = `
  <section class="ibx-list-pane" aria-label="Needs you queue">
    <header class="ibx-head">
      <h2 class="ibx-heading">Needs you</h2>
      <span class="ibx-count" hidden></span>
      <div class="ibx-filters" role="group" aria-label="Show">
        <button type="button" class="ibx-filter" data-filter="open" aria-pressed="true">Open</button>
        <button type="button" class="ibx-filter" data-filter="closed" aria-pressed="false">Closed</button>
        <button type="button" class="ibx-filter" data-filter="all" aria-pressed="false">All</button>
      </div>
    </header>
    <div class="ibx-queue" role="listbox" tabindex="-1" aria-label="Open items"></div>
    <p class="ibx-empty" role="status">Nothing needs you right now.</p>
  </section>
  <section class="ibx-detail-pane" aria-label="Selected item">
    <button type="button" class="ibx-btn ibx-back">${ICONS.back}<span>Back</span></button>
    <div class="ibx-detail"></div>
    <div class="ibx-terminal" hidden></div>
  </section>`;

// Resolved, or answered and still on its way: nothing left to do but look.
const isReadOnly = (item) => item.state !== 'open' && !isFailed(item);

// The remembered filter (per browser). Storage can be missing or throw (a
// private window, blocked site data): then it is Open, and nothing is kept.
function loadFilter(storage) {
  try {
    const v = storage?.getItem(FILTER_KEY);
    return FILTERS.includes(v) ? v : 'open';
  } catch { return 'open'; }
}

function saveFilter(storage, filter) {
  try { storage?.setItem(FILTER_KEY, filter); } catch { /* not remembered, still shown */ }
}

function isTyping(target) {
  return Boolean(target?.closest?.('textarea, input, select, [contenteditable=""], [contenteditable="true"]'));
}

export function createInboxView(el, api, {
  now = () => Date.now(), leaveMs = LEAVE_MS, schedule = setTimeout, cancel = clearTimeout,
  twoPanes = null, storage,
} = {}) {
  const doc = el.ownerDocument;
  if (storage === undefined) {
    try { storage = doc.defaultView?.localStorage ?? null; } catch { storage = null; }
  }
  const root = doc.createElement('div');
  root.className = 'ibx-root';
  root.tabIndex = -1;
  root.innerHTML = SHELL_HTML;
  el.appendChild(root);

  const isTwoPanes = twoPanes || (() => root.clientWidth >= TWO_PANES_PX);
  const q = (sel) => root.querySelector(sel);
  const countEl = q('.ibx-count');
  const queueEl = q('.ibx-queue');
  const emptyEl = q('.ibx-empty');
  const filterBtns = [...root.querySelectorAll('.ibx-filter')];
  const detailEl = q('.ibx-detail');
  const terminalEl = q('.ibx-terminal');
  const backBtn = q('.ibx-back');

  let graph = null;
  let items = [];
  let order = []; // the open queue
  let closed = []; // closed items, newest close first
  let prevOrderIds = [];
  let filter = loadFilter(storage);
  let selectedId = null;
  // The selection is the list's first item, picked for a two-pane layout,
  // not one the human opened: it is not marked read, and `n` starts on it.
  let autoPicked = false;
  // The human closed the detail (C1): no auto-pick until they pick a row,
  // press n, or a new item arrives.
  let userClosed = false;
  const seenIds = new Set();
  let pendingId = null;
  let detailOpen = false;
  let wantFocus = false;
  let confirming = null;
  let detailKey = null;
  let terminal = null; // { id, handle }
  const readSent = new Set();
  const drafts = new Map();
  const choices = new Map();
  const sending = new Map(); // id -> { stamp, timer }

  const byId = (id) => items.find((i) => i.id === id) || null;
  const selected = () => (selectedId ? order.find((i) => i.id === selectedId) || closed.find((i) => i.id === selectedId) || null : null);
  const selectable = (id) => order.some((i) => i.id === id) || closed.some((i) => i.id === id);
  // The list showing, which is also what j/k walk.
  const shown = () => (filter === 'closed' ? closed : filter === 'all' ? [...order, ...closed] : order);
  const isShown = (id) => shown().some((i) => i.id === id);
  const visible = () => el.isConnected && !el.closest('.hidden');

  // ── queue rows ──────────────────────────────────────────────────────────
  function createRow() {
    const row = doc.createElement('div');
    row.setAttribute('role', 'option');
    row.tabIndex = -1;
    row.innerHTML = `
      <span class="ibx-row-kind"><span class="ibx-row-icon"></span><span class="ibx-row-kind-label"></span></span>
      <span class="ibx-row-main"><span class="ibx-row-title"></span><span class="ibx-row-meta"></span></span>
      <span class="ibx-row-side"><span class="ibx-dot" aria-hidden="true"></span><span class="ibx-tag ibx-tag-urgent"></span><span class="ibx-tag ibx-tag-failed"></span><span class="ibx-closed-reason"></span><span class="ibx-row-age"></span></span>`;
    return row;
  }

  // The kind column: a cause icon and label for a status item, else the kind's.
  function updateKind(row, item) {
    const icon = row.querySelector('.ibx-row-icon');
    const key = itemIconKey(item);
    if (icon.dataset.kind !== key) { icon.innerHTML = kindIcon(key); icon.dataset.kind = key; }
    setText(row.querySelector('.ibx-row-kind-label'), itemLabel(item));
  }

  function rowClass(item, extra = []) {
    return ['ibx-row', ...extra, `ibx-kind-${item.kind}`, isAlarm(item) ? 'ibx-alarm' : '',
      item.id === selectedId ? 'ibx-selected' : ''].filter(Boolean).join(' ');
  }

  // One row layout for both: an open row has its dot, tags and waiting age; a
  // closed row, toned down, has how it closed and "closed 5m ago" (C2).
  function updateRow(row, item) {
    const failed = isFailed(item);
    const unread = isUnread(item);
    const done = isReadOnly(item);
    setClass(row, rowClass(item, [unread ? 'ibx-unread' : '', failed ? 'ibx-failed' : '', done ? 'ibx-closed-row' : '']));
    row.dataset.id = item.id;
    setAttr(row, 'aria-selected', String(item.id === selectedId));
    updateKind(row, item);
    const title = row.querySelector('.ibx-row-title');
    setText(title, item.title);
    setAttr(title, 'title', item.title);
    setText(row.querySelector('.ibx-row-meta'), [sessionMeta(graph, item), spawnedByLabel(graph, item)].filter(Boolean).join(' · '));
    setText(row.querySelector('.ibx-tag-urgent'), isUrgent(item) && !failed && !done ? 'Urgent' : '');
    setText(row.querySelector('.ibx-tag-failed'), failed ? 'Not delivered' : '');
    // "sending" is the age itself, so it is not said twice.
    setText(row.querySelector('.ibx-closed-reason'), done && item.state === 'resolved' ? resolvedLabel(item) : '');
    setText(row.querySelector('.ibx-row-age'), done ? closedLabel(item, now()) : waitingLabel(item, now()));
    setAttr(row.querySelector('.ibx-dot'), 'title', unread ? 'Unread' : null);
  }

  // The head's age: how long a live item has waited, or when a read-only one
  // was asked.
  const headAge = (item) => (isReadOnly(item) ? `asked ${ageLabel(item.createdAt, now())} ago` : waitingLabel(item, now()));

  // ── detail pane ─────────────────────────────────────────────────────────
  function make(tag, className, text) {
    const n = doc.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function button(className, label, onClick, { disabled = false, title } = {}) {
    const b = make('button', `ibx-btn ${className}`, label);
    b.type = 'button';
    b.disabled = disabled;
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderDetailKey(item) {
    if (!item) return 'none';
    const s = inboxOf(graph)?.sessions?.[item.sessionId];
    return JSON.stringify([isTwoPanes(), item.id, item.kind, item.source, item.title, item.body, item.options, item.allowFreeText,
      item.state, item.resolvedReason, item.answer, item.status, item.blocking, item.urgency, s?.name, s?.taskName, sessionMeta(graph, item),
      isFailed(item) ? deliveryProblem(graph, item).text : null,
      spawnedByLabel(graph, item), choices.get(item.id) ?? null, confirming === item.id, sending.has(item.id), terminal?.id === item.id]);
  }

  function renderDetail() {
    const item = selected();
    setClass(root, ['ibx-root', detailOpen && item ? 'ibx-detail-open' : ''].filter(Boolean).join(' '));
    const key = renderDetailKey(item);
    if (key === detailKey) {
      const age = detailEl.querySelector('.ibx-d-age');
      if (age && item) setText(age, headAge(item));
      const closedAge = detailEl.querySelector('.ibx-d-closed-age');
      if (closedAge && item) setText(closedAge, `${ageLabel(closedAt(item), now())} ago`);
      if (!item) setText(detailEl.querySelector('.ibx-d-placeholder'), placeholderText());
      return;
    }
    detailKey = key;
    const active = doc.activeElement;
    const hadFocus = detailEl.contains(active);
    const focusRole = hadFocus ? active.dataset?.ibxRole || null : null;
    const caret = hadFocus && active.tagName === 'TEXTAREA' ? [active.selectionStart, active.selectionEnd] : null;
    detailEl.replaceChildren();
    if (!item) {
      detailEl.appendChild(make('p', 'ibx-d-placeholder', placeholderText()));
      return;
    }
    detailEl.appendChild(detailHead(item));
    if (item.source === 'status') statusText(item);
    else if (item.body) {
      const body = make('div', 'ibx-body chat-prose');
      body.innerHTML = api.ui?.markdownPreview ? api.ui.markdownPreview(item.body) : '';
      detailEl.appendChild(body);
    }
    if (isReadOnly(item)) detailEl.appendChild(readOnlyDetail(item));
    else if (item.source === 'status') detailEl.appendChild(statusActions(item));
    else if (item.state === 'open') detailEl.appendChild(agentOpenActions(item));
    else detailEl.appendChild(agentAnsweredActions(item));
    if (focusRole) {
      const target = detailEl.querySelector(`[data-ibx-role="${focusRole}"]`);
      if (target && !target.disabled) {
        target.focus({ preventScroll: true });
        if (caret && target.tagName === 'TEXTAREA') target.setSelectionRange(caret[0], caret[1]);
      } else root.focus({ preventScroll: true });
    }
  }

  // A status item: what to do (one sentence per cause), then what the
  // terminal said, once. reconcile stores it as escaped markdown, so it goes
  // through the board's sanitiser like any other body.
  function placeholderText() {
    return shown().length ? 'Select an item, or press n for the top one.' : '';
  }

  function statusText(item) {
    if (!isReadOnly(item)) detailEl.appendChild(make('p', 'ibx-d-guidance', guidanceFor(item)));
    const said = terminalText(item);
    if (!said) return;
    const box = make('section', 'ibx-from-terminal');
    box.setAttribute('aria-label', 'From the terminal');
    box.appendChild(make('h4', 'ibx-from-terminal-head', 'From the terminal'));
    const body = make('div', 'ibx-body ibx-terminal-text chat-prose');
    body.innerHTML = api.ui?.markdownPreview ? api.ui.markdownPreview(said) : '';
    box.appendChild(body);
    detailEl.appendChild(box);
  }

  function detailHead(item) {
    const head = make('header', 'ibx-d-head');
    const kinds = make('div', 'ibx-d-kinds');
    const kind = make('span', `ibx-d-kind ibx-kind-${item.kind}${isAlarm(item) ? ' ibx-alarm' : ''}`);
    kind.innerHTML = kindIcon(itemIconKey(item));
    kind.appendChild(make('span', null, itemLabel(item)));
    kinds.appendChild(kind);
    if (isUrgent(item) && !isReadOnly(item)) kinds.appendChild(make('span', 'ibx-tag ibx-tag-urgent', 'Urgent'));
    // Two panes only: at one pane, Back does this (C1).
    if (isTwoPanes()) {
      const x = button('ibx-close', '', () => closeDetail(), { title: 'Close (Esc)' });
      x.innerHTML = ICONS.close;
      x.setAttribute('aria-label', 'Close');
      x.dataset.ibxRole = 'close';
      kinds.appendChild(x);
    }
    head.appendChild(kinds);
    head.appendChild(make('h3', 'ibx-d-title', item.title));
    const meta = make('div', 'ibx-d-meta');
    const sessionBtn = button('ibx-link ibx-d-session', sessionName(graph, item.sessionId), () => openSession(item), { title: 'Open session' });
    meta.appendChild(sessionBtn);
    const task = inboxOf(graph)?.sessions?.[item.sessionId]?.taskName;
    if (task) meta.appendChild(make('span', 'ibx-d-task', task));
    meta.appendChild(make('span', 'ibx-d-age', headAge(item)));
    head.appendChild(meta);
    const spawned = spawnedByLabel(graph, item);
    if (spawned) head.appendChild(make('div', 'ibx-d-spawned', spawned));
    if (item.source === 'agent' && item.state === 'open' && !item.blocking) {
      head.appendChild(make('p', 'ibx-d-working', 'The agent is still working.'));
    }
    return head;
  }

  function dismissControls(item, actions, { primary = false } = {}) {
    if (confirming === item.id) {
      const box = make('div', 'ibx-confirm');
      box.appendChild(make('p', 'ibx-confirm-text', DISMISS_WARNING));
      const yes = button('ibx-danger ibx-confirm-yes', 'Dismiss', () => dismiss(item));
      yes.dataset.ibxRole = 'confirm-yes';
      const no = button('ibx-confirm-no', 'Cancel', () => { confirming = null; renderDetail(); focusRole('dismiss'); });
      no.dataset.ibxRole = 'confirm-no';
      box.append(yes, no);
      actions.appendChild(box);
      return;
    }
    const b = button(`${primary ? 'ibx-primary ' : ''}ibx-dismiss`, 'Dismiss', () => startDismiss(), { disabled: sending.has(item.id), title: 'Dismiss (e)' });
    b.dataset.ibxRole = 'dismiss';
    if (primary) { b.classList.add('ibx-lead'); actions.prepend(b); } else actions.appendChild(b);
  }

  function statusActions(item) {
    const wrap = make('div', 'ibx-d-status');
    const actions = make('div', 'ibx-actions');
    const open = button('ibx-primary ibx-open-session', 'Open session', () => openSession(item));
    open.dataset.ibxRole = 'primary';
    actions.appendChild(open);
    if (typeof api.mountSession === 'function') {
      const on = terminal?.id === item.id;
      const t = button('ibx-terminal-toggle', on ? 'Hide terminal' : 'Show terminal here', () => toggleTerminal(item));
      t.setAttribute('aria-pressed', String(on));
      t.dataset.ibxRole = 'terminal';
      actions.appendChild(t);
    }
    dismissControls(item, actions);
    wrap.appendChild(actions);
    return wrap;
  }

  function agentOpenActions(item) {
    const wrap = make('div', 'ibx-d-answer');
    const busy = sending.has(item.id);
    const choice = choices.get(item.id) || null;
    if (item.options.length) {
      const group = make('div', 'ibx-options');
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-label', 'Options');
      item.options.forEach((opt, i) => {
        const b = make('button', 'ibx-option');
        b.type = 'button';
        b.disabled = busy;
        b.dataset.ibxRole = `option-${i + 1}`;
        b.dataset.optionId = opt.id;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(choice === opt.id));
        if (choice === opt.id) b.classList.add('ibx-chosen');
        b.appendChild(make('span', 'ibx-option-num', String(i + 1)));
        const text = make('span', 'ibx-option-text');
        text.appendChild(make('span', 'ibx-option-label', opt.label));
        if (opt.description) text.appendChild(make('span', 'ibx-option-desc', opt.description));
        b.appendChild(text);
        b.addEventListener('click', () => choose(item, opt.id));
        group.appendChild(b);
      });
      wrap.appendChild(group);
    }
    const done = hasDone(item);
    const field = make('div', 'ibx-field');
    const ta = make('textarea', 'ibx-text');
    ta.id = `ibx-text-${item.id}`;
    const label = make('label', 'ibx-text-label', item.options.length || done ? 'Add a note (optional)' : 'Your answer');
    label.htmlFor = ta.id;
    ta.rows = 3;
    ta.maxLength = 4000;
    ta.disabled = busy;
    ta.dataset.ibxRole = 'text';
    ta.value = drafts.get(item.id) || '';
    ta.addEventListener('input', () => {
      drafts.set(item.id, ta.value);
      const send = detailEl.querySelector('.ibx-send');
      if (send) send.disabled = busy || !answerPayload(item, { optionId: choices.get(item.id), text: ta.value });
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); send(item); }
    });
    field.append(label, ta);
    wrap.appendChild(field);
    const actions = make('div', 'ibx-actions');
    if (done) {
      const doneBtn = button('ibx-primary ibx-done', 'Done', () => sendDone(item), { disabled: busy, title: 'Tell the agent it is done' });
      doneBtn.dataset.ibxRole = 'done';
      actions.appendChild(doneBtn);
    }
    const payload = answerPayload(item, { optionId: choice, text: drafts.get(item.id) || '' });
    const sendBtn = button(`${done ? '' : 'ibx-primary '}ibx-send`, busy ? 'Sending…' : 'Send', () => send(item), { disabled: busy || !payload });
    sendBtn.dataset.ibxRole = 'send';
    actions.appendChild(sendBtn);
    actions.appendChild(make('span', 'ibx-hint', '⌘/Ctrl+Enter sends'));
    dismissControls(item, actions);
    wrap.appendChild(actions);
    return wrap;
  }

  // Only a failed delivery gets here; a sending or resolved item is read-only.
  function agentAnsweredActions(item) {
    const wrap = make('div', 'ibx-d-answered');
    const a = item.answer || {};
    const opt = item.options.find((o) => o.id === a.optionId);
    if (opt) wrap.appendChild(make('p', 'ibx-answer-choice', `You chose: ${opt.label}`));
    if (a.text) wrap.appendChild(make('p', 'ibx-answer-note', `Note: ${a.text}`));
    const problem = deliveryProblem(graph, item);
    wrap.appendChild(make('p', 'ibx-delivery ibx-delivery-failed', problem.text));
    const actions = make('div', 'ibx-actions');
    const busy = sending.has(item.id);
    // Retrying an archived session can't work until it is restored, so there
    // Dismiss leads and Retry stays for after a restore.
    const retry = button(`${problem.archived ? '' : 'ibx-primary '}ibx-retry`, busy ? 'Retrying…' : 'Retry', () => retryItem(item), { disabled: busy });
    if (!problem.archived) retry.dataset.ibxRole = 'primary';
    actions.appendChild(retry);
    dismissControls(item, actions, { primary: problem.archived });
    wrap.appendChild(actions);
    return wrap;
  }

  // A resolved (or still-sending) item: what was asked and how it ended.
  // Nothing here can answer, dismiss or retry.
  function readOnlyDetail(item) {
    const wrap = make('div', 'ibx-d-readonly');
    const a = item.answer || {};
    if (item.options.length) {
      const list = make('ul', 'ibx-ro-options');
      list.setAttribute('aria-label', 'Options');
      for (const opt of item.options) {
        const chosen = a.optionId === opt.id;
        const li = make('li', `ibx-ro-option${chosen ? ' ibx-chosen' : ''}`);
        const text = make('span', 'ibx-option-text');
        text.appendChild(make('span', 'ibx-option-label', opt.label));
        if (opt.description) text.appendChild(make('span', 'ibx-option-desc', opt.description));
        li.appendChild(text);
        if (chosen) li.appendChild(make('span', 'ibx-ro-chosen', 'Your choice'));
        list.appendChild(li);
      }
      wrap.appendChild(list);
    }
    if (a.text) wrap.appendChild(make('p', 'ibx-answer-note', `Your note: ${a.text}`));

    const closed = make('p', 'ibx-d-closed');
    const how = item.state === 'answered' ? 'Answer sending' : `Closed: ${resolvedLabel(item)}`;
    closed.appendChild(make('span', 'ibx-d-closed-reason', how));
    closed.appendChild(doc.createTextNode(' · '));
    const when = closedAt(item);
    const at = make('time', 'ibx-d-closed-at', new Date(when).toLocaleString());
    at.setAttribute('datetime', new Date(when).toISOString());
    closed.appendChild(at);
    closed.appendChild(doc.createTextNode(' ('));
    closed.appendChild(make('span', 'ibx-d-closed-age', `${ageLabel(when, now())} ago`));
    closed.appendChild(doc.createTextNode(')'));
    wrap.appendChild(closed);
    return wrap;
  }

  // ── actions ─────────────────────────────────────────────────────────────
  function findRow(list, id) {
    return list.querySelector(`.ibx-row[data-id="${CSS_escape(id)}"]:not(.ibx-leaving)`);
  }

  function markSending(item) {
    const prev = sending.get(item.id);
    if (prev) cancel(prev.timer);
    const timer = schedule(() => { sending.delete(item.id); renderDetail(); }, SEND_TIMEOUT_MS);
    sending.set(item.id, { stamp: item.updatedAt, state: item.state, timer });
  }

  function send(item) {
    if (sending.has(item.id)) return;
    const payload = answerPayload(item, { optionId: choices.get(item.id), text: drafts.get(item.id) || '' });
    if (!payload) return;
    markSending(item);
    api.send(payload);
    renderDetail();
  }

  function sendDone(item) {
    if (sending.has(item.id)) return;
    const payload = donePayload(item, drafts.get(item.id) || '');
    if (!payload) return;
    markSending(item);
    api.send(payload);
    renderDetail();
  }

  function retryItem(item) {
    if (sending.has(item.id)) return;
    markSending(item);
    api.send({ type: 'inbox-retry', id: item.id });
    renderDetail();
  }

  function dismiss(item) {
    confirming = null;
    markSending(item);
    api.send({ type: 'inbox-dismiss', id: item.id });
    renderDetail();
    root.focus({ preventScroll: true });
  }

  function startDismiss() {
    const item = selected();
    if (!item || isReadOnly(item) || sending.has(item.id)) return;
    if (item.source === 'status') { dismiss(item); return; }
    confirming = item.id;
    renderDetail();
    focusRole('confirm-yes');
  }

  function choose(item, optionId) {
    choices.set(item.id, optionId);
    renderDetail();
    focusRole('send');
  }

  // A blocked session opens on its Terminal, where the prompt is.
  function openSession(item) {
    if (wantsTerminal(item)) preferTerminal(item.sessionId, storage);
    api.openSession?.(item.sessionId);
  }

  function toggleTerminal(item) {
    if (terminal?.id === item.id) closeTerminal();
    else {
      closeTerminal();
      terminalEl.hidden = false;
      preferTerminal(item.sessionId, storage);
      const handle = api.mountSession(terminalEl, item.sessionId);
      if (handle) terminal = { id: item.id, handle };
      else terminalEl.hidden = true;
    }
    renderDetail();
  }

  function closeTerminal() {
    if (!terminal) return;
    try { terminal.handle.unmount(); } catch { /* the board reports its own */ }
    terminal = null;
    terminalEl.hidden = true;
    terminalEl.replaceChildren();
  }

  function focusRole(role) {
    const target = detailEl.querySelector(`[data-ibx-role="${role}"]`);
    if (target && !target.disabled) target.focus({ preventScroll: true });
  }

  function primaryControl() {
    const item = selected();
    if (!item) return null;
    const pick = (sel) => detailEl.querySelector(sel);
    // A read-only item has no buttons (F11); its header's session link is all there is.
    if (isReadOnly(item)) return pick('.ibx-d-session');
    if (item.source === 'status') return pick('[data-ibx-role="primary"]');
    if (isFailed(item)) return pick('[data-ibx-role="primary"]') || pick('[data-ibx-role="dismiss"]');
    if (hasDone(item) && !choices.get(item.id)) return pick('[data-ibx-role="done"]');
    const chosen = choices.get(item.id);
    if (chosen) return pick('[data-ibx-role="send"]');
    return pick('.ibx-option') || pick('[data-ibx-role="text"]') || pick('[data-ibx-role="send"]');
  }

  function focusPrimary() {
    const target = primaryControl();
    if (target && !target.disabled) target.focus({ preventScroll: true });
    else root.focus({ preventScroll: true });
  }

  function markRead() {
    const item = selected();
    if (!item || autoPicked || !visible() || !isUnread(item) || readSent.has(item.id)) return;
    readSent.add(item.id);
    api.send({ type: 'inbox-mark-read', ids: [item.id] });
  }

  // ── selection ───────────────────────────────────────────────────────────
  function setSelected(id) {
    if (id === selectedId) return;
    if (terminal && terminal.id !== id) closeTerminal();
    confirming = null;
    selectedId = id;
    autoPicked = false;
  }

  // Two panes and nothing selected: show the list's first item rather than a
  // blank pane (F5), unless the human closed the detail (C1). Focus stays put
  // and nothing is marked read.
  function autoPick() {
    const list = shown();
    if (selectedId || userClosed || !list.length || !isTwoPanes()) return;
    setSelected(list[0].id);
    autoPicked = true;
  }

  // The X, or Escape at two panes: nothing selected, and no auto-pick after.
  // Focus goes to the row that was selected, else the list.
  function closeDetail() {
    const was = selectedId;
    setSelected(null);
    userClosed = true;
    detailOpen = false;
    render();
    const row = was ? findRow(queueEl, was) : null;
    (row || queueEl).focus({ preventScroll: true });
  }

  function setFilter(next, { keepSelection = false } = {}) {
    if (!FILTERS.includes(next)) return;
    if (next !== filter) {
      filter = next;
      saveFilter(storage, filter);
    }
    if (!keepSelection && selectedId && !isShown(selectedId)) {
      setSelected(null);
      detailOpen = false;
    }
  }

  function select(id, { open = true, focus = false } = {}) {
    if (!selectable(id)) {
      pendingId = id;
      wantFocus = focus;
      return false;
    }
    pendingId = null;
    // A row the list isn't showing (a card pill, say): show a list that has it.
    if (!isShown(id)) setFilter(order.some((i) => i.id === id) ? 'open' : 'closed', { keepSelection: true });
    setSelected(id);
    userClosed = false;
    autoPicked = false; // the human picked it, even if it was already shown
    if (open) detailOpen = true;
    render();
    if (focus) {
      if (visible()) focusPrimary();
      else wantFocus = true;
    }
    return true;
  }

  // The top OPEN item, whatever the filter: from Closed or All it shows Open.
  function next() {
    if (!order.length) return;
    if (filter !== 'open') setFilter('open');
    const top = order[0].id;
    const target = selectedId === top && !autoPicked && order.length > 1 ? order[1].id : top;
    select(target, { open: true, focus: true });
  }

  function move(delta) {
    const list = shown();
    if (!list.length) return;
    const at = list.findIndex((i) => i.id === selectedId);
    const to = at < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, at + delta));
    const id = list[to].id;
    setSelected(id);
    userClosed = false;
    render();
    findRow(queueEl, id)?.focus({ preventScroll: false });
  }

  function chooseByNumber(n) {
    const item = selected();
    if (!item || item.source !== 'agent' || item.state !== 'open' || sending.has(item.id)) return false;
    const opt = item.options[n - 1];
    if (!opt) return false;
    detailOpen = true;
    choose(item, opt.id);
    return true;
  }

  // ── events ──────────────────────────────────────────────────────────────
  queueEl.addEventListener('click', (e) => {
    const row = e.target.closest('.ibx-row');
    if (row && !row.classList.contains('ibx-leaving')) select(row.dataset.id, { open: true });
  });
  for (const b of filterBtns) {
    b.addEventListener('click', () => { setFilter(b.dataset.filter); render(); });
  }
  backBtn.addEventListener('click', () => {
    detailOpen = false;
    render();
    queueEl.querySelector('.ibx-row.ibx-selected')?.focus({ preventScroll: true });
  });

  root.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    // A handled key stops here, so the board's window-level shortcuts never
    // see it as well.
    const consume = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'Escape') {
      if (confirming) { confirming = null; renderDetail(); focusRole('dismiss'); consume(); return; }
      if (isTyping(e.target)) { root.focus({ preventScroll: true }); consume(); return; }
      if (isTwoPanes()) { if (selectedId) { closeDetail(); consume(); } } else if (detailOpen) { backBtn.click(); consume(); }
      return;
    }
    if (isTyping(e.target)) return;
    let handled = true;
    switch (e.key) {
      case 'n': next(); break;
      case 'j': case 'ArrowDown': move(1); break;
      case 'k': case 'ArrowUp': move(-1); break;
      case 'e': startDismiss(); break;
      case 'Enter':
        // A focused button answers Enter itself.
        if (e.target.closest('button')) { handled = false; break; }
        if (selected()) { detailOpen = true; render(); focusPrimary(); } else next();
        break;
      default:
        if (/^[1-6]$/.test(e.key)) handled = chooseByNumber(Number(e.key));
        else handled = false;
    }
    if (handled) consume();
  });

  // The view's host toggles `hidden` as the human switches views. Coming on
  // screen is when a pending focus lands and the selected item counts as read.
  const host = el.parentElement;
  const Observer = doc.defaultView?.MutationObserver;
  let watcher = null;
  if (host && Observer) {
    watcher = new Observer(() => {
      if (!visible()) return;
      if (!selectedId && shown().length) render();
      markRead();
      if (wantFocus) { wantFocus = false; focusPrimary(); return; }
      const active = doc.activeElement;
      if (!active || active === doc.body || active.closest?.('.layouts')) root.focus({ preventScroll: true });
    });
    watcher.observe(host, { attributes: true, attributeFilter: ['class'] });
  }

  // ── render ──────────────────────────────────────────────────────────────
  function render() {
    const n = order.length;
    autoPick();
    setText(countEl, n ? `${n} open` : '');
    countEl.hidden = n === 0;
    const counts = { open: n, closed: closed.length, all: n + closed.length };
    const names = { open: 'Open', closed: 'Closed', all: 'All' };
    for (const b of filterBtns) {
      const f = b.dataset.filter;
      setText(b, `${names[f]} (${counts[f]})`);
      setAttr(b, 'aria-pressed', String(f === filter));
    }
    const list = shown();
    setAttr(queueEl, 'aria-label', LIST_LABEL[filter]);
    setText(emptyEl, EMPTY_TEXT[filter]);
    emptyEl.hidden = list.length > 0;
    patchList(queueEl, list, { key: (i) => i.id, create: createRow, update: updateRow, leaveMs, schedule });
    renderDetail();
    markRead();
  }

  function update(nextGraph) {
    graph = nextGraph;
    items = inboxOf(graph)?.items ?? [];
    for (const [id, choice] of choices) {
      if (!byId(id)?.options.some((opt) => opt.id === choice)) choices.delete(id);
    }
    const hadFocus = root.contains(doc.activeElement);
    order = queueOrder(items);
    closed = closedOrder(items);
    // A new open item lifts the human's "closed" (C1).
    if (order.some((i) => !seenIds.has(i.id))) userClosed = false;
    for (const i of items) seenIds.add(i.id);
    for (const [id, s] of [...sending]) {
      const item = byId(id);
      if (!item || item.updatedAt !== s.stamp || item.state !== s.state) { cancel(s.timer); sending.delete(id); }
    }
    let advanced = false;
    // A queued item that left the queue moves the selection on. A closed
    // item the human opened stays put while it is still listed.
    const wasQueued = selectedId != null && prevOrderIds.includes(selectedId);
    if (selectedId && !order.some((i) => i.id === selectedId) && (wasQueued || !closed.some((i) => i.id === selectedId))) {
      const wasAuto = autoPicked;
      setSelected(nextAfter(prevOrderIds, selectedId, order));
      autoPicked = wasAuto && selectedId != null;
      advanced = wasQueued;
      if (!selectedId) detailOpen = false;
    }
    if (pendingId && selectable(pendingId)) {
      const focus = wantFocus;
      wantFocus = false;
      prevOrderIds = order.map((i) => i.id);
      select(pendingId, { open: true, focus });
      return;
    }
    prevOrderIds = order.map((i) => i.id);
    render();
    if (advanced && hadFocus && visible()) focusPrimary();
  }

  function unmount() {
    watcher?.disconnect();
    for (const s of sending.values()) cancel(s.timer);
    sending.clear();
    closeTerminal();
    root.remove();
  }

  return { update, select, next, unmount, get selectedId() { return selectedId; } };
}

// CSS.escape where the platform has it; item ids are `ibx_<hex>`, so the
// fallback only needs to quote what a selector string could trip on.
function CSS_escape(s) {
  const g = globalThis.CSS;
  return g?.escape ? g.escape(s) : String(s).replace(/["\\]/g, '\\$&');
}
