import { filteredList, inboxOf, itemLabel } from './inbox-model.js';

const PREFERENCES_KEY = 'needsyou.presentation';
const DEFAULTS = { group: 'none', sort: 'recommended', direction: 'asc' };
const VALID = { group: ['none', 'task', 'type'], sort: ['recommended', 'type', 'waiting'], direction: ['asc', 'desc'] };

function preferences(value) {
  return Object.fromEntries(Object.entries(VALID).map(([key, allowed]) =>
    [key, allowed.includes(value?.[key]) ? value[key] : DEFAULTS[key]]));
}

export function loadPreferences(storage) {
  try { return preferences(JSON.parse(storage?.getItem(PREFERENCES_KEY) ?? 'null')); }
  catch { return { ...DEFAULTS }; }
}

export function savePreferences(storage, value) {
  try { storage?.setItem(PREFERENCES_KEY, JSON.stringify(preferences(value))); } catch { /* unavailable */ }
}

export function presentItems(items, graph, filter, value) {
  const { group, sort, direction } = preferences(value);
  const list = filteredList(filter, items);
  if (sort !== 'recommended') {
    const sign = direction === 'desc' ? -1 : 1;
    list.sort((a, b) => sign * (sort === 'type'
      ? itemLabel(a).localeCompare(itemLabel(b))
      : (b.createdAt ?? 0) - (a.createdAt ?? 0))
      || String(a.id).localeCompare(String(b.id)));
  }
  if (group === 'none') return list.length ? [{ key: 'none', label: '', items: list }] : [];
  const groups = new Map();
  for (const item of list) {
    const session = inboxOf(graph)?.sessions?.[item.sessionId];
    const task = session?.taskId && session?.taskName;
    const label = group === 'type' ? itemLabel(item) : task ? session.taskName : 'No task';
    const key = group === 'type' ? `type:${label}` : task ? `task:${session.taskId}` : 'no-task';
    if (!groups.has(key)) groups.set(key, { key, label, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}
