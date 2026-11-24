import { inboxOf, needsAction, sessionName } from './inbox-model.js';

function shortLine(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const prefix = text.slice(0, max - 1);
  const boundary = text[max - 1] === ' ' ? prefix.length : prefix.lastIndexOf(' ');
  const end = boundary >= max / 2 ? boundary : prefix.length;
  const cut = /[\uD800-\uDBFF]/.test(text[end - 1]) ? end - 1 : end;
  return `${text.slice(0, cut).trimEnd()}…`;
}

function toastBody(graph, item) {
  const name = sessionName(graph, item.sessionId);
  const task = shortLine(inboxOf(graph)?.sessions?.[item.sessionId]?.taskName, 60);
  return task ? `${shortLine(name, 80 - task.length - 3)} · ${task}` : shortLine(name, 80);
}

export function createInboxToasts(api, openItem) {
  const seen = new Set();
  const active = new Map();
  let initialised = false;
  const enabled = () => api.settings()?.toastNotifications === true;

  function withdraw(id) {
    active.delete(id);
    api.ui.withdraw(id);
  }

  api.settings.onChange?.(() => {
    if (!enabled()) for (const id of active.keys()) withdraw(id);
  });

  return {
    update(graph) {
      const inbox = inboxOf(graph);
      if (!inbox) return;
      const actionable = new Set(inbox.items.filter(needsAction).map((item) => item.id));
      const on = enabled();
      for (const id of active.keys()) {
        if (!on || !actionable.has(id)) withdraw(id);
      }
      for (const item of inbox.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        if (!initialised || !on || item.state !== 'open') continue;
        const token = {};
        active.set(item.id, token);
        try {
          Promise.resolve(api.ui.notify({
            id: item.id,
            title: shortLine(item.title, 120),
            body: toastBody(graph, item),
            actions: [{ id: 'view', label: 'View request', primary: true }],
          })).then((action) => {
            if (active.get(item.id) !== token) return;
            active.delete(item.id);
            if (action === 'view' && enabled()) openItem(item.id);
          }).catch(() => {
            if (active.get(item.id) === token) active.delete(item.id);
          });
        } catch {
          active.delete(item.id);
        }
      }
      initialised = true;
    },
  };
}
