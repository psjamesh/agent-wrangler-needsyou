import { okResult, errorResult, NO_IDENTITY } from './result.js';

export const RECENT_MS = 24 * 60 * 60_000;

// The caller's own requests: open and answered ones, plus those closed in the
// last 24 hours, so an agent that lost a delivered answer (a compaction, a
// restart) can recover it. Read-only.
export function makeListMyHumanRequestsTool({ now = Date.now } = {}) {
  return {
    name: 'list_my_human_requests',
    description:
      'List your own requests in the human\'s "Needs you" queue: the open and answered ones, plus '
      + 'any closed in the last 24 hours, as {id, kind, title, state, resolvedReason, resolvedNote, answer}. Call it '
      + 'after a restart or a compaction to recover an answer you may have missed, or to find an id '
      + 'to withdraw. It reads only the session you are running in; there is no session parameter. '
      + 'Never for status updates, summaries, or "done" notices.',
    inputSchema: {},
    async handler({ host, caller }) {
      if (caller == null) return errorResult(NO_IDENTITY);
      const since = now() - RECENT_MS;
      const requests = host.stores.inbox.snapshot()
        .filter((i) => i.source === 'agent' && i.sessionId === caller && (i.state !== 'resolved' || i.updatedAt >= since))
        .map((i) => ({
          id: i.id,
          kind: i.kind,
          title: i.title,
          state: i.state,
          resolvedReason: i.resolvedReason,
          resolvedNote: i.resolvedNote,
          answer: i.answer ? { optionId: i.answer.optionId, text: i.answer.text } : null,
        }));
      return okResult({ requests });
    },
  };
}
