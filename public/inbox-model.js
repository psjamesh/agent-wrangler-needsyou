// Pure helpers over graph.inbox (contracts §2, §4), shared by the view, the
// toasts and the card pill. No DOM here, so every rule is a plain unit test.

export const VIEW_ID = 'inbox';
export const VIEW_HASH = '#view=ext:needsyou:inbox';

const KIND_LABELS = { blocked: 'Blocked', decision: 'Decision', approval: 'Approval', question: 'Question', action: 'Action' };

const RESOLVED_LABELS = {
  delivered: 'answered',
  withdrawn: 'withdrawn by agent',
  'answered-elsewhere': 'answered in the session',
  'status-cleared': 'resolved in the session',
  dismissed: 'dismissed',
  'session-archived': 'session archived',
  expired: 'expired',
};

export function kindLabel(kind) {
  return KIND_LABELS[kind] || 'Request';
}

// A status item's cause (contracts §2 `status.cause`, 0.1.2). An item made
// before 0.1.2, or with a value we don't know, reads as 'other'.
export const CAUSES = ['permission', 'question', 'trust', 'sign-in', 'update', 'container', 'api-error', 'other'];

export function causeOf(item) {
  const cause = item?.status?.cause;
  return CAUSES.includes(cause) ? cause : 'other';
}

const CAUSE_LABELS = {
  permission: 'Permission', question: 'Question', trust: 'Trust', 'sign-in': 'Sign-in',
  update: 'Restart', container: 'Blocked', 'api-error': 'Blocked', other: 'Waiting',
};

// One plain-English sentence per cause: what the human should do (F2).
const CAUSE_GUIDANCE = {
  permission: 'The agent wants to do this and needs your approval. Open the session to allow or deny it.',
  question: 'The agent asked you a question in its terminal. Open the session to answer it.',
  trust: 'The agent is asking whether to trust this folder. Open the session to confirm.',
  'sign-in': 'The agent needs you to sign in. Open the session to finish signing in.',
  update: 'The agent was updated and needs a restart. Open the session to restart it.',
  container: "The session's container did not start. Open the session to see the error.",
  'api-error': 'The agent hit an API error that it cannot retry. Open the session to see it.',
  other: 'The session is waiting for you. Open the session to see what it needs.',
};

// The label a row and the detail head show: the cause for a status item, the
// kind for an agent request. A transient API error reads "Error".
export function itemLabel(item) {
  if (item?.source !== 'status') return kindLabel(item?.kind);
  const cause = causeOf(item);
  if (cause === 'api-error' && item.status?.waitingReason === 'api-error') return 'Error';
  return CAUSE_LABELS[cause];
}

// The icon key (icons.js): the cause for a status item, else the kind.
export function itemIconKey(item) {
  return item?.source === 'status' ? `cause-${causeOf(item)}` : item?.kind;
}

// Only real failures are red.
export const isAlarm = (item) => item?.source === 'status' && (causeOf(item) === 'container' || causeOf(item) === 'api-error');
export const isUrgent = (item) => item?.source === 'agent' && item.urgency === 'high';

export const guidanceFor = (item) => CAUSE_GUIDANCE[causeOf(item)];

// Core's own phrases for a need, which say nothing the label doesn't
// (reconcile leaves body empty for them from 0.1.2; older items still carry one).
const CORE_PHRASES = new Set(['permission prompt', 'input needed', 'trust dialog']);

// The terminal text a status item shows once, under "From the terminal".
export function terminalText(item) {
  const text = String(item?.body ?? '').trim();
  return text && !CORE_PHRASES.has(text.toLowerCase()) ? text : '';
}

export function resolvedLabel(item) {
  if (item?.state === 'answered') return 'sending';
  return RESOLVED_LABELS[item?.resolvedReason] || 'resolved';
}

export const isFailed = (item) => item?.state === 'answered' && item.answer?.delivery === 'failed';
export const needsAction = (item) => item?.state === 'open' || isFailed(item);
export const isUnread = (item) => item?.state === 'open' && item.readAt === null;
// Only what stops a session interrupts the human (spec "Interrupt only when work has stopped").
export const stopsWork = (item) => item?.kind === 'blocked' || item?.blocking === true;

export function inboxOf(graph) {
  const inbox = graph?.inbox;
  return inbox && Array.isArray(inbox.items) ? inbox : null;
}

// The cost-of-waiting tier: lower waits less well. A high-urgency request
// sorts with the stopped sessions (F4).
export function queueTier(item) {
  if (isFailed(item)) return 3;
  if (item.kind === 'blocked' || item.source === 'status' || item.urgency === 'high') return 0;
  return item.blocking ? 1 : 2;
}

// The queue: everything that needs action, by tier, oldest first within a
// tier, id as the last tie-break so the order is total and stable.
export function queueOrder(items = []) {
  return items
    .filter(needsAction)
    .map((item) => ({ item, tier: queueTier(item) }))
    .sort((a, b) => a.tier - b.tier
      || (a.item.createdAt ?? 0) - (b.item.createdAt ?? 0)
      || String(a.item.id).localeCompare(String(b.item.id)))
    .map((e) => e.item);
}

// When an item closed. The store sets `updatedAt` on every close and never
// changes it afterwards (`update` takes only open items; `markRead` leaves it
// alone), so for a resolved item it is the close time. An answer still on its
// way closed when the human answered: `answer.at`.
export function closedAt(item) {
  if (item?.state === 'answered') return item.answer?.at ?? item.updatedAt ?? 0;
  return item?.updatedAt ?? 0;
}

export const isClosed = (item) => item?.state === 'resolved' || (item?.state === 'answered' && !isFailed(item));

// The Closed list (0.1.4, C2): resolved in the last 24 h (the graph already
// windows them) plus answers still on their way, by when each CLOSED, newest
// first, not by when it was asked. Id breaks ties so the order is total.
export function closedOrder(items = []) {
  return items
    .filter(isClosed)
    .sort((a, b) => closedAt(b) - closedAt(a) || String(a.id).localeCompare(String(b.id)));
}

// The list filters (C2). All is the Open list, then the Closed list, each in
// its own order.
export const FILTERS = ['open', 'closed', 'all'];

export function filteredList(filter, items = []) {
  if (filter === 'closed') return closedOrder(items);
  if (filter === 'all') return [...queueOrder(items), ...closedOrder(items)];
  return queueOrder(items);
}

export function ageLabel(from, now = Date.now()) {
  const mins = Math.floor(Math.max(0, now - (from ?? now)) / 60000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// A closed row's age: how long ago it closed, or "sending" for an answer on its way.
export function closedLabel(item, now = Date.now()) {
  if (item?.state === 'answered') return 'sending';
  return `closed ${ageLabel(closedAt(item), now)} ago`;
}

// How long a live item has waited, or, once the human answered (a failed
// delivery), how long ago they did.
export function waitingLabel(item, now = Date.now()) {
  if (isFailed(item)) return `answered ${ageLabel(item.answer?.at ?? item.updatedAt, now)} ago`;
  return `waiting ${ageLabel(item.createdAt, now)}`;
}

const NAME_MAX = 60;

// Core's graph session carries `label`, the name the board shows on the card
// (0.1.4, C4); `name` is a fallback. A long one is clipped.
function coreSessionName(graph, sessionId) {
  const list = graph?.sessions;
  const found = Array.isArray(list) ? list.find((s) => s?.sessionId === sessionId) : list?.[sessionId];
  const name = [found?.label, found?.name].find((v) => typeof v === 'string' && v.trim()) || '';
  const trimmed = name.trim();
  return trimmed.length > NAME_MAX ? `${trimmed.slice(0, NAME_MAX - 1)}…` : trimmed;
}

export function sessionName(graph, sessionId) {
  return inboxOf(graph)?.sessions?.[sessionId]?.name || coreSessionName(graph, sessionId) || shortId(sessionId);
}

// Whether the board lists the session as archived: core's `history` list
// (archived cards), or a core session entry flagged archived.
export function isArchivedSession(graph, sessionId) {
  const history = Array.isArray(graph?.history) ? graph.history : [];
  if (history.some((s) => s?.sessionId === sessionId)) return true;
  const list = graph?.sessions;
  const found = Array.isArray(list) ? list.find((s) => s?.sessionId === sessionId) : list?.[sessionId];
  return found?.archived === true;
}

// A failed delivery, in plain words, with the session's name (F3).
export function deliveryProblem(graph, item) {
  const error = item?.answer?.deliveryError || '';
  const archived = isArchivedSession(graph, item.sessionId) || /\barchived\b/i.test(error);
  if (archived) {
    return {
      archived,
      text: `Not delivered: ${sessionName(graph, item.sessionId)} is archived. Restore it from the archive, then retry, or dismiss this.`,
    };
  }
  return { archived, text: error ? `Not delivered: ${error}` : 'Not delivered.' };
}

export function shortId(id) {
  return typeof id === 'string' ? id.slice(0, 8) : '';
}

// "session name · task name", without a dangling separator.
export function sessionMeta(graph, item) {
  const s = inboxOf(graph)?.sessions?.[item.sessionId];
  return [sessionName(graph, item.sessionId), s?.taskName || ''].filter(Boolean).join(' · ');
}

// "spawned by <spawner>" for a status item whose session another session launched.
export function spawnedByLabel(graph, item) {
  if (item.source !== 'status') return '';
  const spawner = inboxOf(graph)?.sessions?.[item.sessionId]?.spawnedBy;
  return spawner ? `spawned by ${sessionName(graph, spawner)}` : '';
}

// The id to select after the selected one left the queue: the first item that
// followed it before and is still queued, else whatever now sits at its index.
export function nextAfter(prevOrder, removedId, order) {
  if (!order.length) return null;
  const ids = new Set(order.map((i) => i.id));
  const at = prevOrder.indexOf(removedId);
  if (at >= 0) {
    for (const id of prevOrder.slice(at + 1)) if (ids.has(id)) return id;
    return order[Math.min(at, order.length - 1)].id;
  }
  return order[0].id;
}

// What Send would carry, or null when it would be refused (mirrors the
// store's validateAnswer so the button can say so before a round trip).
export function answerPayload(item, { optionId = null, text = '' } = {}) {
  const choice = optionId && item.options?.some((o) => o.id === optionId) ? optionId : null;
  if (optionId && !choice) return null;
  const note = String(text ?? '').trim();
  if (!choice && !item.allowFreeText) return null;
  if (!choice && !note) return null;
  if (note.length > 4000) return null;
  return { type: 'inbox-answer', id: item.id, ...(choice ? { optionId: choice } : {}), ...(note ? { text: note } : {}) };
}

// An action request with no options gets a Done button (F9).
export const hasDone = (item) => item?.source === 'agent' && item.kind === 'action' && !item.options?.length;

// What Done sends: free text `done`, with the human's note after it if any.
export function donePayload(item, text = '') {
  const note = String(text ?? '').trim();
  const body = note ? `done\n\n${note}` : 'done';
  if (body.length > 4000) return null;
  return { type: 'inbox-answer', id: item.id, text: body };
}
