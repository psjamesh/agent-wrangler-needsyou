import { z } from 'zod';
import { LIMITS } from '../item.js';
import { okResult, errorResult, NO_IDENTITY } from './result.js';

// Withdraw one of the caller's own requests: it no longer needs the human
// (the answer came another way, or the question went away). An answer that
// has not reached the session yet can be withdrawn too; a delivered one is
// already closed. The reason is shown to the human on the closed request.
export const withdrawHumanRequestTool = {
  name: 'withdraw_human_request',
  description:
    'Withdraw one of your own requests from the human\'s "Needs you" queue, by the id '
    + 'request_human_input returned, with a short reason the human will see on the closed request. Call it as soon as a request no longer needs the human: you got '
    + 'the answer another way (for example the human replied in your terminal), or the question went '
    + 'away. It acts only on requests made by the session you are running in; there is no session '
    + 'parameter. Never for status updates, summaries, or "done" notices. Those do not belong in the '
    + 'queue at all.',
  inputSchema: {
    id: z.string().min(1).max(64).describe('The request id, as returned by request_human_input or list_my_human_requests.'),
    reason: z.string().min(1).max(LIMITS.resolvedNote).describe(
      'One short sentence on why it no longer needs the human, for example "User answered in chat", '
      + '"Found the answer in the docs" or "No longer needed: the task was cancelled".',
    ),
  },
  async handler({ host, caller }, args = {}) {
    if (caller == null) return errorResult(NO_IDENTITY);
    const store = host.stores.inbox;
    const item = typeof args.id === 'string' ? store.get(args.id) : null;
    if (!item || item.source !== 'agent' || item.sessionId !== caller) return errorResult('not your request');
    if (item.state === 'resolved') return errorResult(`This request is already closed (${item.resolvedReason}).`);
    const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
    if (!reason) return errorResult('reason is required: one short sentence on why the request no longer needs the human');
    if (reason.length > LIMITS.resolvedNote) return errorResult(`reason must be at most ${LIMITS.resolvedNote} characters`);
    const done = store.resolve(item.id, 'withdrawn', { note: reason });
    await host.rebuild();
    return okResult({ id: done.id, state: done.state, resolvedReason: done.resolvedReason, resolvedNote: done.resolvedNote });
  },
};
