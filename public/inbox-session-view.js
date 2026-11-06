// Open a blocked session on its Terminal, not its Chat. The host API has no way
// to ask for a tab (openSession takes an id; mountSession takes only
// `view: 'diff'`), so this writes the board's own per-session choice before
// opening. That key is core's, not a contract: if it changes, the session just
// opens on whatever tab it would have anyway. Remove this once the host API
// takes `view: 'terminal'`.
export const SESSION_VIEW_KEY = 'cm-session-view';

export function preferTerminal(sessionId, storage = globalThis.localStorage) {
  try {
    let parsed = null;
    try { parsed = JSON.parse(storage.getItem(SESSION_VIEW_KEY)); } catch { /* corrupt: core reads {} too */ }
    const all = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    all[sessionId] = 'terminal';
    storage.setItem(SESSION_VIEW_KEY, JSON.stringify(all));
  } catch { /* storage unavailable: open on the remembered tab */ }
}

// Only an open status item is waiting on the terminal.
export function wantsTerminal(item) {
  return item?.source === 'status' && item.state === 'open';
}

export function temporarilyPreferTerminal(sessionId, storage = globalThis.localStorage) {
  try {
    const original = storage.getItem(SESSION_VIEW_KEY);
    const parse = (raw) => {
      try {
        const value = JSON.parse(raw);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      } catch { return {}; }
    };
    const before = parse(original);
    const applied = JSON.stringify({ ...before, [sessionId]: 'terminal' });
    storage.setItem(SESSION_VIEW_KEY, applied);
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      try {
        const current = storage.getItem(SESSION_VIEW_KEY);
        if (current === applied) {
          if (original === null) storage.removeItem(SESSION_VIEW_KEY);
          else storage.setItem(SESSION_VIEW_KEY, original);
          return;
        }
        const latest = parse(current);
        if (latest[sessionId] !== 'terminal') return;
        if (Object.hasOwn(before, sessionId)) latest[sessionId] = before[sessionId];
        else delete latest[sessionId];
        storage.setItem(SESSION_VIEW_KEY, JSON.stringify(latest));
      } catch {}
    };
  } catch { return () => {}; }
}
