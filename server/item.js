import crypto from 'node:crypto';

// The item model (docs/specs/01-contracts.md §2). Every limit lives here and
// nowhere else: validateAgentRequest REJECTS (an agent is told what to fix),
// normaliseItem COERCES what the store builds or reads back off disk and throws
// only on what cannot be repaired, and validateAnswer gates the human's answer.

export const KINDS = ['decision', 'approval', 'question', 'action', 'blocked'];
export const AGENT_KINDS = KINDS.filter((k) => k !== 'blocked');
export const SOURCES = ['agent', 'status'];
export const STATES = ['open', 'answered', 'resolved'];
export const RESOLVED_REASONS = [
  'delivered', 'withdrawn', 'answered-elsewhere', 'status-cleared', 'dismissed', 'session-archived', 'expired',
];
export const DELIVERIES = ['pending', 'delivered', 'failed'];
export const URGENCIES = ['normal', 'high'];
export const STATUS_CAUSES = ['permission', 'question', 'trust', 'sign-in', 'update', 'container', 'api-error', 'other'];
export const OPTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const LIMITS = Object.freeze({
  title: 120,
  body: 8000,
  options: 6,
  optionLabel: 80,
  optionDescription: 300,
  dedupeKey: 120,
  answerText: 4000,
  deliveryError: 500,
  resolvedNote: 200,
  statusString: 500,
  expiresInMinutes: { min: 5, max: 10080 },
});

const ITEM_ID_RE = /^ibx_[A-Za-z0-9_-]{1,40}$/;
const MAX_REF = 200;
const MAX_STORED_DEDUPE = 2 * MAX_REF + LIMITS.dedupeKey;

export const newItemId = () => `ibx_${crypto.randomBytes(6).toString('hex')}`;

export const singleLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const isStr = (v) => typeof v === 'string';
const isTime = (v) => typeof v === 'number' && Number.isFinite(v);
const has = (v) => v !== undefined && v !== null;
// The tool hands snake_case args; an internal caller may already hold camelCase.
const pick = (o, snake, camel) => (has(o[snake]) ? o[snake] : o[camel]);

function slugFor(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
}

function agentRequest(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object');
  const { kind } = args;
  if (!AGENT_KINDS.includes(kind)) throw new Error(`kind must be one of ${AGENT_KINDS.join(', ')}`);

  if (!isStr(args.title)) throw new Error('title is required');
  const title = singleLine(args.title);
  if (!title) throw new Error('title must not be empty');
  if (title.length > LIMITS.title) throw new Error(`title must be at most ${LIMITS.title} characters`);

  if (has(args.body) && !isStr(args.body)) throw new Error('body must be a string');
  const body = has(args.body) ? args.body.trim() : '';
  if (body.length > LIMITS.body) throw new Error(`body must be at most ${LIMITS.body} characters`);

  const rawOptions = has(args.options) ? args.options : [];
  if (!Array.isArray(rawOptions)) throw new Error('options must be an array');
  if (rawOptions.length > LIMITS.options) throw new Error(`at most ${LIMITS.options} options`);
  const options = [];
  const ids = new Set();
  // Explicit ids are claimed first, so a derived one can never take an id the
  // agent chose for a later option.
  const explicit = new Set(rawOptions.map((o) => o?.id).filter((id) => isStr(id) && OPTION_ID_RE.test(id)));
  for (const [i, o] of rawOptions.entries()) {
    if (!o || typeof o !== 'object') throw new Error(`options[${i}] must be an object`);
    if (!isStr(o.label) || !singleLine(o.label)) throw new Error(`options[${i}].label is required`);
    const label = singleLine(o.label);
    if (label.length > LIMITS.optionLabel) throw new Error(`options[${i}].label must be at most ${LIMITS.optionLabel} characters`);
    let id;
    if (has(o.id)) {
      if (!isStr(o.id) || !OPTION_ID_RE.test(o.id)) throw new Error(`options[${i}].id must match ${OPTION_ID_RE}`);
      if (ids.has(o.id)) throw new Error(`options[${i}].id "${o.id}" is used twice`);
      id = o.id;
    } else {
      const taken = (c) => ids.has(c) || explicit.has(c);
      id = slugFor(label);
      if (!OPTION_ID_RE.test(id) || taken(id)) id = `option-${i + 1}`;
      for (let n = 2; taken(id); n++) id = `option-${i + 1}-${n}`;
    }
    ids.add(id);
    const option = { id, label };
    if (has(o.description)) {
      if (!isStr(o.description)) throw new Error(`options[${i}].description must be a string`);
      if (o.description.length > LIMITS.optionDescription) throw new Error(`options[${i}].description must be at most ${LIMITS.optionDescription} characters`);
      if (o.description.trim()) option.description = o.description.trim();
    }
    options.push(option);
  }

  const allowFree = pick(args, 'allow_free_text', 'allowFreeText');
  if (has(allowFree) && typeof allowFree !== 'boolean') throw new Error('allow_free_text must be a boolean');
  if (has(args.blocking) && typeof args.blocking !== 'boolean') throw new Error('blocking must be a boolean');
  if (has(args.urgency) && !URGENCIES.includes(args.urgency)) throw new Error(`urgency must be one of ${URGENCIES.join(', ')}`);

  const key = pick(args, 'dedupe_key', 'dedupeKey');
  if (has(key) && (!isStr(key) || !key.trim())) throw new Error('dedupe_key must be a non-empty string');
  if (has(key) && key.length > LIMITS.dedupeKey) throw new Error(`dedupe_key must be at most ${LIMITS.dedupeKey} characters`);

  const expires = pick(args, 'expires_in_minutes', 'expiresInMinutes');
  const { min, max } = LIMITS.expiresInMinutes;
  if (has(expires) && !(Number.isInteger(expires) && expires >= min && expires <= max)) {
    throw new Error(`expires_in_minutes must be a whole number from ${min} to ${max}`);
  }

  return {
    kind,
    title,
    body,
    options,
    allowFreeText: true,
    blocking: args.blocking !== false,
    urgency: args.urgency ?? 'normal',
    dedupeKey: has(key) ? key.trim() : null,
    expiresInMinutes: has(expires) ? expires : null,
  };
}

// -> { ok: true, value } | { ok: false, error }. `value` is the agent-chosen
// fields only: the caller adds sessionId/taskId, prefixes dedupeKey
// (`agent:<sid>:<key>`) and turns expiresInMinutes into expiresAt.
export function validateAgentRequest(args) {
  try {
    return { ok: true, value: agentRequest(args) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const optStr = (v, max) => (isStr(v) ? v.slice(0, max) : null);

function ref(v, name) {
  if (!isStr(v) || !v || v.length > MAX_REF) throw new Error(`inbox item ${name} must be a non-empty string`);
  return v;
}

function normaliseOptions(raw) {
  const out = [];
  const ids = new Set();
  for (const o of Array.isArray(raw) ? raw : []) {
    if (out.length === LIMITS.options) break;
    if (!o || !isStr(o.id) || !OPTION_ID_RE.test(o.id) || ids.has(o.id) || !isStr(o.label)) continue;
    const label = clip(singleLine(o.label), LIMITS.optionLabel);
    if (!label) continue;
    ids.add(o.id);
    const option = { id: o.id, label };
    if (isStr(o.description) && o.description.trim()) option.description = clip(o.description.trim(), LIMITS.optionDescription);
    out.push(option);
  }
  return out;
}

function normaliseAnswer(a) {
  if (!a || typeof a !== 'object') throw new Error('inbox item answer is missing');
  return {
    optionId: isStr(a.optionId) && OPTION_ID_RE.test(a.optionId) ? a.optionId : null,
    text: isStr(a.text) ? a.text.slice(0, LIMITS.answerText) : null,
    at: isTime(a.at) ? a.at : 0,
    delivery: DELIVERIES.includes(a.delivery) ? a.delivery : 'pending',
    deliveryError: optStr(a.deliveryError, LIMITS.deliveryError),
    attempts: Number.isInteger(a.attempts) && a.attempts >= 0 ? a.attempts : 0,
  };
}

// A complete, well-formed Item from `raw`: text clipped and single-lined,
// enums and invariants checked, fields that do not belong to the source
// dropped. Throws on what cannot be repaired (a bad id, kind, state, session).
export function normaliseItem(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('inbox item must be an object');
  if (!isStr(raw.id) || !ITEM_ID_RE.test(raw.id)) throw new Error(`inbox item id must match ${ITEM_ID_RE}`);
  if (!SOURCES.includes(raw.source)) throw new Error(`inbox item source must be one of ${SOURCES.join(', ')}`);
  const status = raw.source === 'status';
  if (!KINDS.includes(raw.kind)) throw new Error(`inbox item kind must be one of ${KINDS.join(', ')}`);
  if ((raw.kind === 'blocked') !== status) throw new Error('inbox item kind "blocked" is for status items only, and only "blocked"');
  if (!STATES.includes(raw.state)) throw new Error(`inbox item state must be one of ${STATES.join(', ')}`);
  if (status && raw.state === 'answered') throw new Error('a status item cannot be answered');

  const sessionId = ref(raw.sessionId, 'sessionId');
  const title = clip(singleLine(isStr(raw.title) ? raw.title : ''), LIMITS.title);
  if (!title) throw new Error('inbox item title must not be empty');
  const dedupeKey = ref(raw.dedupeKey ?? '', 'dedupeKey');
  if (dedupeKey.length > MAX_STORED_DEDUPE) throw new Error('inbox item dedupeKey is too long');

  const resolved = raw.state === 'resolved';
  if (resolved && !RESOLVED_REASONS.includes(raw.resolvedReason)) throw new Error(`inbox item resolvedReason must be one of ${RESOLVED_REASONS.join(', ')}`);

  const options = status ? [] : normaliseOptions(raw.options);
  const createdAt = isTime(raw.createdAt) ? raw.createdAt : 0;
  const item = {
    id: raw.id,
    source: raw.source,
    kind: raw.kind,
    sessionId,
    taskId: isStr(raw.taskId) && raw.taskId ? raw.taskId.slice(0, MAX_REF) : null,
    title,
    body: isStr(raw.body) ? clip(raw.body, LIMITS.body) : '',
    options,
    allowFreeText: true,
    blocking: status ? true : raw.blocking !== false,
    urgency: URGENCIES.includes(raw.urgency) ? raw.urgency : 'normal',
    dedupeKey,
    state: raw.state,
    resolvedReason: resolved ? raw.resolvedReason : null,
    // Why it closed, in the closer's words (an agent's withdraw reason).
    resolvedNote: resolved && isStr(raw.resolvedNote) && singleLine(raw.resolvedNote)
      ? clip(singleLine(raw.resolvedNote), LIMITS.resolvedNote) : null,
    createdAt,
    updatedAt: isTime(raw.updatedAt) ? raw.updatedAt : createdAt,
    readAt: isTime(raw.readAt) ? raw.readAt : null,
    expiresAt: !status && isTime(raw.expiresAt) ? raw.expiresAt : null,
    // An open item has never been answered; an answered one always has been. A
    // resolved one keeps whatever it had (a delivered answer, or none).
    answer: raw.state === 'open' || !has(raw.answer) ? null : normaliseAnswer(raw.answer),
  };
  if (raw.state === 'answered' && !item.answer) throw new Error('an answered inbox item needs its answer');
  if (status) {
    const s = raw.status;
    if (!s || typeof s !== 'object') throw new Error('a status item needs its status');
    item.status = {
      waitingFor: optStr(s.waitingFor, LIMITS.statusString),
      waitingReason: optStr(s.waitingReason, LIMITS.statusString),
      episode: ref(s.episode, 'status.episode'),
      // Items made before 0.1.2 have none: they read as 'other'.
      cause: STATUS_CAUSES.includes(s.cause) ? s.cause : 'other',
    };
  }
  return item;
}

// The human's answer to an agent item, checked against that item:
// -> { optionId, text } with blanks as null. Throws a message fit for a toast.
export function validateAnswer(item, { optionId, text } = {}) {
  if (has(optionId) && !isStr(optionId)) throw new Error('optionId must be a string');
  if (has(text) && !isStr(text)) throw new Error('text must be a string');
  const choice = has(optionId) && optionId !== '' ? optionId : null;
  const note = has(text) && text.trim() ? text.trim() : null;
  if (choice && !item.options.some((o) => o.id === choice)) throw new Error(`"${choice}" is not one of this request's options`);
  if (note && note.length > LIMITS.answerText) throw new Error(`the answer must be at most ${LIMITS.answerText} characters`);
  if (!choice && !note) throw new Error(item.options.length ? 'choose an option' : 'the answer needs some text');
  return { optionId: choice, text: note };
}

export const isUnread = (item) => item.state === 'open' && item.readAt === null;
export const needsAction = (item) => item.state === 'open' || (item.state === 'answered' && item.answer?.delivery === 'failed');
