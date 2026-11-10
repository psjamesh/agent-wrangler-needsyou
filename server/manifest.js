import { fileURLToPath } from 'node:url';
import { InboxStore } from './store.js';
import { inboxFile } from './data-dir.js';
import { inboxGraph } from './graph.js';
import { inboxHandlers } from './handlers/index.js';
import { inboxTools } from './tools/index.js';
import { lifecycleHooks } from './lifecycle.js';
import { inboxSweeps } from './sweeps.js';

// The extension manifest (docs/specs/01-contracts.md §1). The root index.js
// only re-exports it: the wrangler's import scanner quarantines any own file
// importing `../index.js`, so tests import THIS module. `dir` is the repo root,
// where `client`/`styles` resolve under public/; discovery overwrites it with
// the installed location anyway.
export const dir = fileURLToPath(new URL('..', import.meta.url));

// No `default` on a def (the loader refuses one): an unset value reads as
// undefined and each consumer applies the fallback in the table in §7.
export const SETTINGS = [
  { key: 'includeTransientApiErrors', type: 'toggle', label: 'Include API errors', help: 'Also raise an item when a session waits on a retryable API error. Off unless turned on.' },
  { key: 'maxOpenPerSession', type: 'number', label: 'Open requests per session', help: 'How many unanswered requests one session may have at once (1–20, default 5).', min: 1, max: 20, step: 1 },
  { key: 'retentionDays', type: 'number', label: 'Keep resolved items (days)', help: 'Resolved items are removed after this many days (1–90, default 7).', min: 1, max: 90, step: 1 },
  { key: 'toastNotifications', type: 'toggle', label: 'Toast notifications', help: 'Show a toast for each new Needs you item, with a shortcut to view the request. Off unless turned on.' },
  { key: 'requestsPerTenMinutes', type: 'number', label: 'New requests per ten minutes', help: 'New requests one session may create in ten minutes (0–100, default 3). Set 0 to turn off the rate limit. The open-request cap still applies.', min: 0, max: 100, step: 1 },
];

export const REQUIRES = ['sessions:read', 'tasks:read', 'deliver', 'board:rebuild'];

export default {
  id: 'needsyou',
  label: 'Needs you',
  description: 'A triage queue of the decisions and actions your sessions need from you.',
  help: 'Adds the Needs you view: one item for each session blocked on you (a permission prompt, a sign-in, a trust dialog) and for each decision an agent raises with the request_human_input tool. Answers go straight back to the session. Items close themselves once the need goes away. Status items appear only while a board tab is open.',
  author: 'PortSwigger',
  homepage: 'https://github.com/portswigger-tim/agent-wrangler-needsyou',
  defaultEnabled: true,
  engines: { wranglerApi: '^1.57.0' },
  dir,
  requires: REQUIRES,
  // The bag's `settings` is a read-through { get, all } view (host API 1.3.0),
  // so `all()` per call sees a Settings change without a restart.
  stores: { inbox: (bag) => new InboxStore({ file: inboxFile(bag), getSettings: () => bag.settings?.all?.() ?? {}, log: bag.log }) },
  tools: inboxTools,
  handlers: inboxHandlers,
  graph: inboxGraph,
  session: lifecycleHooks,
  sweeps: inboxSweeps,
  settings: SETTINGS,
  skills: ['needs-you'],
  client: 'public/index.js',
  styles: 'public/styles.css',
};
