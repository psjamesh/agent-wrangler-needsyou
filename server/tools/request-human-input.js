import { z } from 'zod';
import { AGENT_KINDS, URGENCIES, LIMITS, validateAgentRequest } from '../item.js';
import { canAsk, refusalText } from '../can-ask.js';
import { okResult, errorResult, NO_IDENTITY } from './result.js';

// Raise a decision or action the human must take, as an item in their "Needs
// you" queue. The asking session is the caller's own card id, never an
// argument. The description is not how agents find this tool (the `inbox`
// skill is; agent-wrangler measured a tool description alone at 0/6), but it
// is what they read when they call it, so it says plainly what is NOT for it.

export const RATE_LIMIT = Object.freeze({ max: 3, windowMs: 10 * 60_000 });

export const DESCRIPTION =
  'Ask the human for a decision, approval, missing information or a manual action, as an item in '
  + 'their "Needs you" queue. Use only when you cannot proceed correctly without the human\'s decision '
  + 'or action. Never for status updates, summaries, or "done" notices. '
  + 'Good: "Migrate the users table in place or behind a copy?" with two options and your '
  + 'recommendation in the body, when the choice is irreversible. Bad: "Finished the refactor, all '
  + 'tests pass" (that is a status update: say it in chat). '
  + 'Give a one-line title, put context, trade-offs and your recommendation in the body, and offer '
  + '2-4 options where there is a choice. The human can always reply with standalone text instead, or add a note to a selected option. If you are about to end your turn by asking the human to '
  + 'choose (next steps, "should I proceed?"), call this, and also write the question, its options '
  + 'and your recommendation in your reply: the human may be chatting with you and should not have '
  + 'to switch to the queue. Don\'t tell them it is in their "Needs you" queue: the board shows them. If they answer in chat, call withdraw_human_request. Asking again with the same dedupe_key updates your earlier request instead of adding one. '
  + 'If blocking (the default), end your turn right after the call: the answer arrives as a message '
  + 'starting "[Needs you]". It acts for the session you are running in; there is no session '
  + 'parameter. A session launched by another session is refused: then call send_message to that '
  + 'session with your question instead, and never retry this tool or ask the human in chat. '
  + 'See the `needs-you` skill.';

const optionSchema = z.object({
  id: z.string().max(32).optional().describe('A short lowercase slug (a-z, 0-9, -). Derived from the label when omitted.'),
  label: z.string().min(1).max(LIMITS.optionLabel).describe('What the human clicks, e.g. "Migrate behind a copy".'),
  description: z.string().max(LIMITS.optionDescription).optional().describe('One line on what this option means or costs.'),
});

export const inputSchema = {
  kind: z.enum(AGENT_KINDS).describe('decision: choose between approaches; approval: OK an irreversible or outward-facing action; question: information only the human has; action: something only the human can do (e.g. click an OAuth consent).'),
  title: z.string().min(1).max(LIMITS.title).describe('One line: the decision or action needed.'),
  body: z.string().max(LIMITS.body).optional().describe('Markdown: the context, the trade-offs and what you recommend.'),
  options: z.array(optionSchema).max(LIMITS.options).optional().describe('2-4 suggested choices where there is one. The human can always answer with text instead.'),
  allow_free_text: z.boolean().optional().describe('Deprecated compatibility parameter; ignored. Every request allows a standalone text answer or an optional note with a selected choice.'),
  blocking: z.boolean().optional().describe('Whether you are stopping until the answer arrives. Default true: end your turn after the call.'),
  urgency: z.enum(URGENCIES).optional().describe('high only when waiting is costly (e.g. something is broken or a deadline is close).'),
  dedupe_key: z.string().max(LIMITS.dedupeKey).optional().describe('Your own stable key for this need. Asking again with it updates the open request in place.'),
  expires_in_minutes: z.number().int().min(LIMITS.expiresInMinutes.min).max(LIMITS.expiresInMinutes.max).optional().describe('Close the request unanswered after this long.'),
};

// Said on every success, because the agent reads it at the moment of asking:
// the human may be chatting with it, so the question belongs in chat as well.
const ALSO_IN_CHAT = 'Also write the question, its options and your recommendation in your reply, so the human sees it in chat too. Don\'t tell them it is in their "Needs you" queue: the board shows them. If they answer in chat, call withdraw_human_request with this id.';

function nextStep(blocking) {
  return blocking
    ? `Request queued in the human's "Needs you" queue. ${ALSO_IN_CHAT} Then end your turn; the answer will arrive as a message starting \`[Needs you]\`.`
    : `Request queued in the human's "Needs you" queue. ${ALSO_IN_CHAT} Carry on with work that does not depend on it; the answer will arrive as a message starting \`[Needs you]\`.`;
}

// A factory so each instance (and each test) has its own rate-limit memory and
// clock. The limit counts NEW item ids per session; dedupe updates and refused
// calls never reach it.
export function makeRequestHumanInputTool({ now = Date.now } = {}) {
  const recent = new Map(); // sessionId -> creation times inside the window

  const inWindow = (sid) => {
    const since = now() - RATE_LIMIT.windowMs;
    const times = (recent.get(sid) ?? []).filter((t) => t > since);
    if (times.length) recent.set(sid, times);
    else recent.delete(sid);
    return times;
  };

  return {
    name: 'request_human_input',
    description: DESCRIPTION,
    inputSchema,
    async handler({ host, caller }, args = {}) {
      if (caller == null) return errorResult(NO_IDENTITY);
      const store = host.stores.inbox;

      const who = canAsk(host, store, caller);
      if (!who.allowed) return errorResult(refusalText(who));

      const v = validateAgentRequest(args);
      if (!v.ok) return errorResult(`Invalid request: ${v.error}`);
      const { kind, dedupeKey, expiresInMinutes, ...fields } = v.value;
      const expiresAt = expiresInMinutes == null ? null : now() + expiresInMinutes * 60_000;

      // The same need restated: update it in place, keeping its id and read
      // state, so it surfaces once. Keys are namespaced by the caller.
      const key = dedupeKey == null ? null : `agent:${caller}:${dedupeKey}`;
      const existing = key ? store.findOpenByDedupe(key) : null;
      if (existing) {
        let item;
        try {
          item = store.update(existing.id, { ...fields, expiresAt });
        } catch (err) {
          return errorResult(String(err.message || err));
        }
        await host.rebuild();
        return okResult({ id: item.id, state: item.state, blocking: item.blocking, updated: true }, nextStep(item.blocking));
      }

      const configuredRate = host.settings?.get('requestsPerTenMinutes');
      const max = Number.isInteger(configuredRate) && configuredRate >= 0 && configuredRate <= 100
        ? configuredRate : RATE_LIMIT.max;
      if (max > 0 && inWindow(caller).length >= max) {
        return errorResult('Too many separate requests — batch related questions into one request with options.');
      }

      let item;
      try {
        item = store.create({
          source: 'agent',
          kind,
          sessionId: caller,
          taskId: host.sessions.get(caller)?.taskId ?? null,
          ...fields,
          ...(key ? { dedupeKey: key } : {}),
          expiresAt,
        });
      } catch (err) {
        return errorResult(`${err.message}. Withdraw a request you no longer need with withdraw_human_request, or wait for the human's answers.`);
      }
      recent.set(caller, [...inWindow(caller), now()]);
      await host.rebuild();
      return okResult({ id: item.id, state: item.state, blocking: item.blocking, updated: false }, nextStep(item.blocking));
    },
  };
}
