import { deliverAnswer } from '../answer.js';

// The human answering an agent request, retrying a failed delivery, and
// deciding who may ask. Only the human's browser sends these frames; a bad
// payload throws, which the router toasts.
export const MAX_DELIVERY_ATTEMPTS = 5;

function needId(msg, type) {
  const { id } = msg ?? {};
  if (typeof id !== 'string' || !id) throw new Error(`${type} needs an item id`);
  return id;
}

export const answerHandler = {
  type: 'inbox-answer',
  async handler(msg, host) {
    const id = needId(msg, 'inbox-answer');
    const store = host.stores.inbox;
    const item = store.get(id);
    if (!item) throw new Error('unknown inbox item');
    if (item.source !== 'agent') throw new Error('only an agent request can be answered');
    if (item.state !== 'open') throw new Error(`this request is ${item.state}, not open`);
    // store.answer checks the option, nonempty answer and text length.
    store.answer(id, { optionId: msg.optionId, text: msg.text });
    try {
      await deliverAnswer(host, store, id);
    } finally {
      await host.rebuild();
    }
  },
};

export const retryHandler = {
  type: 'inbox-retry',
  async handler(msg, host) {
    const id = needId(msg, 'inbox-retry');
    const store = host.stores.inbox;
    const item = store.get(id);
    if (!item) throw new Error('unknown inbox item');
    if (item.state !== 'answered' || item.answer?.delivery !== 'failed') throw new Error('only a failed delivery can be retried');
    if (item.answer.attempts >= MAX_DELIVERY_ATTEMPTS) throw new Error('delivery keeps failing — open the session');
    store.setDelivery(id, { delivery: 'pending' });
    try {
      await deliverAnswer(host, store, id);
    } finally {
      await host.rebuild();
    }
  },
};

export const setCanAskHandler = {
  type: 'inbox-set-can-ask',
  async handler(msg, host) {
    const { sessionId, allowed } = msg ?? {};
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('inbox-set-can-ask needs a sessionId');
    if (allowed !== true && allowed !== false && allowed !== null) throw new Error('allowed must be true, false or null');
    if (!host.sessions.get(sessionId)) throw new Error('unknown session');
    host.stores.inbox.setCanAskOverride(sessionId, allowed);
    await host.rebuild();
  },
};

export const answerHandlers = [answerHandler, retryHandler, setCanAskHandler];
