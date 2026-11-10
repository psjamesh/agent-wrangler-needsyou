#!/usr/bin/env node
// Validate this extension against the REAL wrangler loader, the way a boot
// would: discovery (id/dir-name check + the leaf-import scan), validateManifest,
// loadExtensions (name collisions, quarantine reasons), buildHostApi
// (capability names + engines.wranglerApi against the served version), the
// store factory with the bag the wrangler hands it, the graph keys, and the
// extension's MCP tools served through the wrangler's REAL MCP server
// (buildMcpServer + the SDK's in-memory client). That last step is where this
// repo's zod 4 schemas meet the wrangler's MCP SDK, which sits beside zod 3.
//
//   AW_REPO=<agent-wrangler checkout> node scripts/validate-manifest.mjs
//
// AW_REPO must have its node_modules (npm ci --ignore-scripts there).
// Exits 1 on any refusal, 2 if AW_REPO is not a loader checkout.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = process.env.AW_REPO && path.resolve(process.env.AW_REPO.replace(/^~/, os.homedir()));
if (!repo || !fs.existsSync(path.join(repo, 'server/extensions/index.js'))) {
  console.error('Set AW_REPO to an agent-wrangler checkout that has server/extensions/index.js');
  process.exit(2);
}
// The loader's config-store reads DATA_DIR at import, and so does this
// extension's store: point both somewhere harmless.
// Removed at the end when this script made it.
const madeDataDir = !process.env.AW_DATA_DIR && fs.mkdtempSync(path.join(os.tmpdir(), 'needsyou-validate-'));
if (madeDataDir) process.env.AW_DATA_DIR = madeDataDir;
const mod = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const { validateManifest, loadExtensions, assertGraphKeys, CAPABILITIES } = await mod('server/extensions/index.js');
const { discoverExternal } = await mod('server/extensions/external.js');
const { buildHostApi, buildExtSettings } = await mod('server/host-api/index.js');
const { HOST_API_VERSION } = await mod('server/host-api/version.js');
let coreToolNames = [], coreHandlerTypes = [];
try { coreToolNames = (await mod('server/mcp/tools/index.js')).TOOLS.map((t) => t.name); } catch (e) { console.warn('(core tool names unavailable:', e.message.split('\n')[0], ')'); }
try { coreHandlerTypes = (await mod('server/control/handlers/index.js')).CONTROL_HANDLERS.map((h) => h.type); } catch (e) { console.warn('(core handler types unavailable:', e.message.split('\n')[0], ')'); }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = false;
const fail = (msg) => { failed = true; console.error('✗', msg); };
const ok = (msg) => console.log('✓', msg);

// 1. Discovery over an extensions dir holding a COPY named after the id, as an
//    install lays it out (discovery skips symlinks, so a symlink proves nothing).
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'needsyou-ext-'));
const declared = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).wranglerExtension;
fs.cpSync(root, path.join(extDir, declared.id), { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
const [found] = await discoverExternal({ dir: extDir, provenance: {} });
if (!found) fail('discoverExternal found nothing');
else if (found.quarantine) fail(`discovery quarantined: ${found.quarantine}`);
else ok(`discovered as "${found.id}" from ${extDir}`);

// 2. The manifest, against the declaration a human consents to.
const { default: manifest } = await import(pathToFileURL(path.join(root, 'server/manifest.js')).href);
try { validateManifest(manifest); ok('validateManifest'); } catch (e) { fail(e.message); }
if (manifest.id !== declared.id) fail(`manifest id "${manifest.id}" != package.json wranglerExtension.id "${declared.id}"`);
if (JSON.stringify(manifest.requires) !== JSON.stringify(declared.requires)) fail('manifest requires != package.json wranglerExtension.requires');
else ok('requires match the disclosed requires');
if (manifest.engines?.wranglerApi !== declared.engines?.wranglerApi) fail('manifest engines.wranglerApi != package.json wranglerExtension.engines.wranglerApi');
for (const c of manifest.requires || []) if (!CAPABILITIES.has(c)) fail(`unknown capability ${c}`);

// 3. The loader, with the core names, so a tool/handler collision is visible.
const loaded = loadExtensions({ cfg: {}, builtin: [{ ...manifest, external: true }], coreToolNames, coreHandlerTypes });
const entry = loaded.list.find((e) => e.id === manifest.id);
if (!entry) fail('loadExtensions produced no entry');
else if (entry.quarantine) fail(`loadExtensions quarantined: ${entry.quarantine}`);
else ok(`loadExtensions: ${loaded.tools.length} tools, ${loaded.handlers.length} handlers [${loaded.handlers.map((h) => h.type).join(', ')}], ${Object.keys(loaded.stores).length} store(s) [${Object.keys(loaded.stores).join(', ')}], ${loaded.sweeps.length} sweep(s), ${entry.settings.length} settings, skills [${entry.skills.join(', ')}], client ${loaded.clientManifest[0]?.client}, styles ${loaded.clientManifest[0]?.styles}`);

// 4. The store factory, with the bag server/index.js hands it.
let store;
try {
  const settings = buildExtSettings({ id: manifest.id, settingDefs: manifest.settings, readSettings: () => ({}) });
  store = manifest.stores.inbox({ id: 'inbox', extId: manifest.id, settings, log: () => {} });
  ok(`store factory → ${store.constructor.name} at ${store.file}, maxOpenPerSession ${store.maxOpenPerSession()}`);
} catch (e) { fail(`store factory threw: ${e.message}`); }

// 5. The façade, and the graph contributor against it, as activation runs it.
try {
  const core = { sessionManager: { activeEntries: () => [], entryFor: () => null }, taskStore: { taskFor: () => null, snapshot: () => ({ tasks: [] }) } };
  const host = buildHostApi({
    id: manifest.id, requires: manifest.requires, range: manifest.engines?.wranglerApi, core,
    rebuild: () => {}, broadcast: () => {}, deliver: async () => ({ mode: 'live' }), archiveSession: () => {},
    stores: store ? { inbox: store } : {}, settingDefs: manifest.settings, readSettings: () => ({}), log: () => {},
  });
  ok(`buildHostApi: serves ${HOST_API_VERSION}, keys [${Object.keys(host).join(', ')}]`);
  const contribution = manifest.graph({ host, graph: {} });
  assertGraphKeys(manifest.id, contribution);
  if (!Array.isArray(contribution.inbox?.items) || contribution.inbox.items.length) fail('graph.inbox.items is not an empty array');
  else ok(`graph keys [${Object.keys(contribution).join(', ')}], inbox.items []`);
} catch (e) { fail(e.message); }

// 6. What the extension must register, by name: a rename or a dropped entry
//    loads cleanly and is only missed at runtime, so pin the lists here.
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const want = {
  tools: ['request_human_input', 'withdraw_human_request', 'list_my_human_requests'],
  handlers: ['inbox-mark-read', 'inbox-dismiss', 'inbox-answer', 'inbox-retry', 'inbox-set-can-ask', 'inbox-observe'],
  settings: ['includeTransientApiErrors', 'maxOpenPerSession', 'retentionDays', 'toastNotifications', 'requestsPerTenMinutes'],
  sweeps: ['retention', 'expiry', 'retention-boot'],
};
const got = {
  tools: loaded.tools.filter((t) => t.extId === manifest.id).map((t) => t.name),
  handlers: entry?.handlerTypes ?? [],
  settings: (manifest.settings || []).map((s) => s.key),
  sweeps: loaded.sweeps.map((s) => s.id),
};
for (const [what, names] of Object.entries(want)) {
  if (same(got[what], names)) ok(`${what}: ${names.join(', ')}`);
  else fail(`${what} are [${got[what].join(', ')}], expected [${names.join(', ')}]`);
}
if (same(entry?.skills ?? [], ['needs-you']) && fs.existsSync(path.join(root, 'skills/needs-you/SKILL.md'))) ok('skill needs-you (skills/needs-you/SKILL.md)');
else fail(`skills are [${entry?.skills}], expected [needs-you] with skills/needs-you/SKILL.md`);
const client = loaded.clientManifest.find((c) => c.id === manifest.id) ?? loaded.clientManifest[0];
const assets = [[client?.client, manifest.client], [client?.styles, manifest.styles]];
for (const [served, rel] of assets) {
  if (served === `/ext/${manifest.id}/${path.basename(rel)}` && fs.existsSync(path.join(root, rel))) ok(`client asset ${served} → ${rel}`);
  else fail(`client asset ${served} does not serve ${rel}`);
}

// 7. The tools through the wrangler's own MCP server, over an in-memory
//    transport: tools/list, one valid call, one invalid one, and a spawned
//    caller's refusal. A zod mismatch shows up as an empty or missing
//    inputSchema in the listing, or as a throw at registerTool.
try {
  const { buildMcpServer } = await mod('server/mcp/server.js');
  const sdk = (rel) => mod(`node_modules/@modelcontextprotocol/sdk/dist/esm/${rel}`);
  const { Client } = await sdk('client/index.js');
  const { InMemoryTransport } = await sdk('inMemory.js');
  const entries = {
    'validate-human': { agent: 'claude', name: 'Human-launched', createdAt: Date.now() },
    'validate-worker': { agent: 'claude', name: 'Worker', spawnedBy: 'validate-human', createdAt: Date.now() },
  };
  const core = {
    sessionManager: { activeEntries: () => Object.entries(entries).map(([sessionId, e]) => ({ ...e, sessionId })), entryFor: (id) => entries[id] ?? null },
    taskStore: { taskFor: () => null, snapshot: () => ({ tasks: [] }) },
  };
  const host = buildHostApi({
    id: manifest.id, requires: manifest.requires, range: manifest.engines?.wranglerApi, core,
    rebuild: () => {}, broadcast: () => {}, deliver: async () => ({ mode: 'live' }), archiveSession: () => {},
    stores: { inbox: store }, settingDefs: manifest.settings, readSettings: () => ({}), log: () => {},
  });
  const deps = { hostApiFor: (extId) => (extId === manifest.id ? host : undefined) };
  const connect = async (caller) => {
    const server = buildMcpServer(deps, caller, { tools: loaded.tools });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 'validate-manifest', version: '0.0.0' });
    await Promise.all([server.connect(a), c.connect(b)]);
    return { c, close: () => Promise.all([c.close(), server.close()]) };
  };

  const human = await connect('validate-human');
  const { tools } = await human.c.listTools();
  const listed = tools.filter((t) => want.tools.includes(t.name));
  const props = Object.fromEntries(listed.map((t) => [t.name, Object.keys(t.inputSchema?.properties ?? {})]));
  if (listed.length === 3) ok(`MCP tools/list: ${listed.map((t) => `${t.name}(${props[t.name].join(', ')})`).join('; ')}`);
  else fail(`MCP tools/list shows ${listed.length} of the 3 tools`);
  const rhi = listed.find((t) => t.name === 'request_human_input');
  if (!rhi || !same(rhi.inputSchema?.required ?? [], ['kind', 'title']) || rhi.inputSchema?.properties?.kind?.enum?.length !== 4) {
    fail(`request_human_input's listed schema lost its shape: ${JSON.stringify(rhi?.inputSchema)?.slice(0, 300)}`);
  } else ok('request_human_input schema: required [kind, title], kind enum of 4');

  const good = await human.c.callTool({ name: 'request_human_input', arguments: { kind: 'decision', title: 'Validate: pick one', options: [{ label: 'Yes' }, { label: 'No' }] } });
  const id = good.structuredContent?.id;
  if (!good.isError && /^ibx_/.test(id ?? '') && store.get(id)?.state === 'open') ok(`MCP tools/call request_human_input (valid) → ${JSON.stringify(good.structuredContent)}`);
  else fail(`a valid request_human_input failed: ${JSON.stringify(good).slice(0, 300)}`);

  // Refused by the SDK's schema check (zod 3 parsing a zod 4 shape) or by the
  // tool's own validation; either way an error result and no new item.
  const before = store.snapshot().length;
  let bad;
  try { bad = await human.c.callTool({ name: 'request_human_input', arguments: { kind: 'gossip', title: '' } }); } catch (e) { bad = { isError: true, thrown: e.message }; }
  if (bad.isError && store.snapshot().length === before) ok(`MCP tools/call request_human_input (invalid) refused: ${(bad.thrown ?? bad.content?.[0]?.text ?? '').split('\n')[0].slice(0, 160)}`);
  else fail(`an invalid request_human_input was accepted: ${JSON.stringify(bad).slice(0, 300)}`);

  const mine = await human.c.callTool({ name: 'list_my_human_requests', arguments: {} });
  if (mine.structuredContent?.requests?.some((r) => r.id === id)) ok('MCP tools/call list_my_human_requests lists it');
  else fail(`list_my_human_requests: ${JSON.stringify(mine).slice(0, 300)}`);
  const gone = await human.c.callTool({ name: 'withdraw_human_request', arguments: { id, reason: 'User answered in chat' } });
  const closed = store.get(id);
  if (!gone.isError && closed?.resolvedReason === 'withdrawn' && closed?.resolvedNote === 'User answered in chat') ok('MCP tools/call withdraw_human_request closes it, keeping the reason');
  else fail(`withdraw_human_request: ${JSON.stringify(gone).slice(0, 300)}`);
  await human.close();

  const worker = await connect('validate-worker');
  const refused = await worker.c.callTool({ name: 'request_human_input', arguments: { kind: 'question', title: 'Validate: from a worker' } });
  const text = refused.content?.[0]?.text ?? '';
  if (refused.isError && text.includes('"validate-human"')) ok('MCP tools/call from a spawned session is refused, naming its spawner');
  else fail(`a spawned caller was not refused with its spawner: ${JSON.stringify(refused).slice(0, 300)}`);
  await worker.close();
} catch (e) { fail(`real MCP server: ${e.stack || e.message}`); }

fs.rmSync(extDir, { recursive: true, force: true });
if (madeDataDir) fs.rmSync(madeDataDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
