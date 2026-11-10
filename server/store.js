import { writeJsonAtomic, readJsonOrQuarantine } from './atomic-json.js';
import { newItemId, normaliseItem, validateAnswer, RESOLVED_REASONS, DELIVERIES, LIMITS, singleLine } from './item.js';

export const MAX_ITEMS = 500;
export const DEFAULT_MAX_OPEN_PER_SESSION = 5;
const FILE_VERSION = 1;

// Fields a caller may hand create(); the rest of an Item is the store's to set.
const CREATE_FIELDS = ['source', 'kind', 'sessionId', 'taskId', 'title', 'body', 'options', 'allowFreeText', 'blocking', 'urgency', 'dedupeKey', 'expiresAt', 'status'];
const UPDATE_FIELDS = ['title', 'body', 'options', 'allowFreeText', 'blocking', 'urgency', 'expiresAt', 'status'];
const AGENT_UPDATE_FIELDS = UPDATE_FIELDS.filter((k) => k !== 'status');
const STATUS_UPDATE_FIELDS = ['title', 'body', 'urgency', 'status'];

const isOverride = (v) => v === true || v === false;

// The single source of truth for inbox items (docs/specs/01-contracts.md §3).
// Every method is synchronous and has persisted before it returns; misuse
// throws a human-readable Error, which the control router turns into a toast.
// Callers `await host.rebuild()` afterwards.
//
// `getSettings()` returns the extension's setting VALUES (a plain object). It is
// read on every call that needs one, so a change in Settings lands without a
// restart.
export class InboxStore {
  constructor({ file, now = Date.now, idGen = newItemId, getSettings = () => ({}), log = () => {} } = {}) {
    if (!file) throw new Error('InboxStore needs a file');
    this.file = file;
    this.now = now;
    this.idGen = idGen;
    this.getSettings = getSettings;
    this.log = log;
    this.items = [];
    this.canAsk = Object.create(null);
    // Seeded from the clock so a restart never hands a tab a rev it already saw.
    this._rev = now();
    this._load();
  }

  _load() {
    const raw = readJsonOrQuarantine(this.file, {
      now: this.now,
      log: this.log,
      accept: (d) => d && typeof d === 'object' && d.version === FILE_VERSION && Array.isArray(d.items),
    });
    if (!raw) return;
    const seen = new Set();
    for (const r of raw.items) {
      try {
        const item = normaliseItem(r);
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        this.items.push(item);
      } catch (err) {
        this.log(`dropped an unreadable inbox item: ${err.message}`);
      }
    }
    if (raw.canAsk && typeof raw.canAsk === 'object') {
      for (const [sid, v] of Object.entries(raw.canAsk)) if (isOverride(v)) this.canAsk[sid] = v;
    }
  }

  _save() {
    writeJsonAtomic(this.file, { version: FILE_VERSION, items: this.items, canAsk: this.canAsk });
    this._rev++;
  }

  _find(id) {
    const item = this.items.find((i) => i.id === id);
    if (!item) throw new Error('unknown inbox item');
    return item;
  }

  maxOpenPerSession() {
    const v = this.getSettings()?.maxOpenPerSession;
    return Number.isInteger(v) && v >= 1 && v <= 20 ? v : DEFAULT_MAX_OPEN_PER_SESSION;
  }

  rev() {
    return this._rev;
  }

  // Newest first; ties keep the later-created item first.
  snapshot() {
    return this.items
      .map((item, i) => [item, i])
      .sort(([a, ai], [b, bi]) => b.createdAt - a.createdAt || bi - ai)
      .map(([item]) => structuredClone(item));
  }

  get(id) {
    const item = this.items.find((i) => i.id === id);
    return item ? structuredClone(item) : null;
  }

  openForSession(sessionId) {
    return this.snapshot().filter((i) => i.sessionId === sessionId && i.state === 'open');
  }

  findOpenByDedupe(dedupeKey) {
    const item = this.items.find((i) => i.dedupeKey === dedupeKey && i.state === 'open');
    return item ? structuredClone(item) : null;
  }

  create(fields = {}) {
    for (const k of Object.keys(fields)) if (!CREATE_FIELDS.includes(k)) throw new Error(`create() does not take "${k}"`);
    const t = this.now();
    const id = this.idGen();
    if (this.items.some((i) => i.id === id)) throw new Error('inbox item id collision');
    const item = normaliseItem({
      ...fields,
      id,
      // An agent request without its own key gets one no other request shares.
      dedupeKey: fields.dedupeKey ?? (fields.source === 'agent' && fields.sessionId ? `agent:${fields.sessionId}:${id}` : undefined),
      state: 'open',
      resolvedReason: null,
      resolvedNote: null,
      createdAt: t,
      updatedAt: t,
      readAt: null,
      answer: null,
    });
    if (this.items.some((i) => i.dedupeKey === item.dedupeKey && i.state === 'open')) {
      throw new Error('an open inbox item already has this dedupeKey');
    }
    if (item.source === 'agent') {
      const max = this.maxOpenPerSession();
      const open = this.items.filter((i) => i.source === 'agent' && i.sessionId === item.sessionId && i.state === 'open').length;
      if (open >= max) throw new Error(`this session already has ${open} open inbox requests (the limit is ${max})`);
    }
    this._makeRoom();
    this.items.push(item);
    this._save();
    return structuredClone(item);
  }

  // Drops the oldest resolved items until one more fits; never an open or
  // answered one, so a full inbox of live asks refuses instead.
  _makeRoom() {
    if (this.items.length < MAX_ITEMS) return;
    const resolved = this.items.filter((i) => i.state === 'resolved').sort((a, b) => a.updatedAt - b.updatedAt);
    const drop = new Set(resolved.slice(0, this.items.length - MAX_ITEMS + 1));
    if (this.items.length - drop.size >= MAX_ITEMS) throw new Error(`the inbox is full (${MAX_ITEMS} items need you); resolve some first`);
    this.items = this.items.filter((i) => !drop.has(i));
  }

  // The same need, restated: an agent asking its question again, a status
  // item's waitingFor changing. Keeps the id and readAt, so it is not new mail.
  update(id, patch = {}) {
    const item = this._find(id);
    for (const k of Object.keys(patch)) if (!UPDATE_FIELDS.includes(k)) throw new Error(`update() does not take "${k}"`);
    if (item.state !== 'open') throw new Error(`this item is ${item.state}, not open`);
    const own = item.source === 'status' ? STATUS_UPDATE_FIELDS : AGENT_UPDATE_FIELDS;
    for (const k of Object.keys(patch)) if (!own.includes(k)) throw new Error(`${item.source === 'agent' ? 'an agent request' : 'a status item'} has no "${k}" to update`);
    const next = normaliseItem({ ...item, ...patch, status: patch.status ? { ...item.status, ...patch.status } : item.status, updatedAt: this.now() });
    Object.assign(item, next);
    this._save();
    return structuredClone(item);
  }

  markRead(ids = []) {
    const want = new Set(ids);
    const t = this.now();
    let n = 0;
    for (const item of this.items) {
      if (want.has(item.id) && item.readAt === null) {
        item.readAt = t;
        n++;
      }
    }
    if (n) this._save();
    return n;
  }

  answer(id, { optionId, text } = {}) {
    const item = this._find(id);
    if (item.source !== 'agent') throw new Error('only an agent request can be answered');
    if (item.state !== 'open') throw new Error(`this request is ${item.state}, not open`);
    const a = validateAnswer(item, { optionId, text });
    const t = this.now();
    item.state = 'answered';
    item.answer = { ...a, at: t, delivery: 'pending', deliveryError: null, attempts: 0 };
    item.readAt ??= t;
    item.updatedAt = t;
    this._save();
    return structuredClone(item);
  }

  // Records one delivery attempt's outcome (or 'pending' before a retry).
  // 'delivered' resolves the item; 'failed' leaves it answered, needing action.
  setDelivery(id, { delivery, deliveryError = null } = {}) {
    const item = this._find(id);
    if (item.state !== 'answered') throw new Error(`this request is ${item.state}, not answered`);
    if (!DELIVERIES.includes(delivery)) throw new Error(`delivery must be one of ${DELIVERIES.join(', ')}`);
    const t = this.now();
    item.answer.delivery = delivery;
    item.answer.deliveryError = delivery === 'failed' ? String(deliveryError ?? 'delivery failed').slice(0, LIMITS.deliveryError) : null;
    if (delivery !== 'pending') item.answer.attempts++;
    if (delivery === 'delivered') {
      item.state = 'resolved';
      item.resolvedReason = 'delivered';
    }
    item.updatedAt = t;
    this._save();
    return structuredClone(item);
  }

  _close(item, reason, t, note = null) {
    item.state = 'resolved';
    item.resolvedReason = reason;
    item.resolvedNote = note;
    item.updatedAt = t;
  }

  // `note` is a short why, in the closer's words (an agent's withdraw reason).
  resolve(id, reason, { note } = {}) {
    if (!RESOLVED_REASONS.includes(reason)) throw new Error(`unknown resolve reason "${reason}"`);
    const item = this._find(id);
    if (item.state === 'resolved') return null;
    const why = typeof note === 'string' ? singleLine(note) : '';
    this._close(item, reason, this.now(), why ? why.slice(0, LIMITS.resolvedNote) : null);
    this._save();
    return structuredClone(item);
  }

  // `pred` sees a copy of each unresolved item.
  resolveWhere(pred, reason) {
    if (!RESOLVED_REASONS.includes(reason)) throw new Error(`unknown resolve reason "${reason}"`);
    const t = this.now();
    const hit = this.items.filter((i) => i.state !== 'resolved' && pred(structuredClone(i)));
    for (const item of hit) this._close(item, reason, t);
    if (hit.length) this._save();
    return hit.map((i) => structuredClone(i));
  }

  remove(ids = []) {
    const drop = new Set(ids);
    const before = this.items.length;
    this.items = this.items.filter((i) => !drop.has(i.id));
    const n = before - this.items.length;
    if (n) this._save();
    return n;
  }

  canAskOverride(sessionId) {
    return Object.hasOwn(this.canAsk, sessionId) && isOverride(this.canAsk[sessionId]) ? this.canAsk[sessionId] : null;
  }

  setCanAskOverride(sessionId, value) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId must be a card id');
    if (value !== null && !isOverride(value)) throw new Error('allowed must be true, false or null');
    if (this.canAskOverride(sessionId) === value) return;
    if (value === null) delete this.canAsk[sessionId];
    else this.canAsk[sessionId] = value;
    this._save();
  }

  forgetSession(sessionId) {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.sessionId !== sessionId);
    const had = Object.hasOwn(this.canAsk, sessionId);
    delete this.canAsk[sessionId];
    if (had || this.items.length !== before) this._save();
  }
}
