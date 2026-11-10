import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import manifest, { dir, SETTINGS } from './manifest.js';

const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
const declared = pkg.wranglerExtension;

test('package.json wranglerExtension and the manifest agree on id, requires and engines', () => {
  assert.equal(manifest.id, 'needsyou');
  assert.equal(declared.id, manifest.id);
  assert.deepEqual(declared.requires, manifest.requires);
  assert.deepEqual(declared.engines, manifest.engines);
  assert.deepEqual(manifest.requires, ['sessions:read', 'tasks:read', 'deliver', 'board:rebuild']);
  assert.equal(manifest.engines.wranglerApi, '^1.57.0');
  assert.equal(declared.label, manifest.label);
  assert.equal(declared.description, manifest.description);
});

test('the manifest declares the five settings and no defaults', () => {
  assert.deepEqual(SETTINGS.map((s) => [s.key, s.type]), [
    ['includeTransientApiErrors', 'toggle'],
    ['maxOpenPerSession', 'number'],
    ['retentionDays', 'number'],
    ['toastNotifications', 'toggle'],
    ['requestsPerTenMinutes', 'number'],
  ]);
  assert.ok(SETTINGS.every((s) => !('default' in s)));
  assert.deepEqual([SETTINGS[1].min, SETTINGS[1].max], [1, 20]);
  assert.deepEqual([SETTINGS[2].min, SETTINGS[2].max], [1, 90]);
  assert.deepEqual([SETTINGS[4].min, SETTINGS[4].max, SETTINGS[4].step], [0, 100, 1]);
});

test('every declared asset and skill exists, and runtime deps are zod only', () => {
  for (const rel of [manifest.client, manifest.styles, ...manifest.skills.map((s) => `skills/${s}/SKILL.md`)]) {
    assert.ok(fs.existsSync(path.join(dir, rel)), rel);
  }
  assert.match(fs.readFileSync(path.join(dir, 'skills/needs-you/SKILL.md'), 'utf8'), /^---\nname: needs-you\n/);
  assert.deepEqual(Object.keys(pkg.dependencies), ['zod']);
  assert.ok(fs.existsSync(path.join(dir, 'package-lock.json')));
});

test('the store factory reads maxOpenPerSession through the bag settings view', () => {
  const values = { maxOpenPerSession: 1 };
  const bag = { id: 'inbox', extId: 'needsyou', log: () => {}, settings: { get: (k) => values[k], all: () => ({ ...values }) } };
  const store = manifest.stores.inbox(bag);
  assert.equal(store.maxOpenPerSession(), 1);
  values.maxOpenPerSession = 7;
  assert.equal(store.maxOpenPerSession(), 7);
  assert.equal(manifest.stores.inbox({ id: 'inbox', log: () => {} }).maxOpenPerSession(), 5);
});

// The wrangler's leaf-import scanner (agent-wrangler server/extensions/external.js
// FORBIDDEN_IMPORTS) quarantines the whole extension on one of these. Stricter
// on purpose: any `../index.js`, where the wrangler matches two or more levels.
test('no own file imports the root index.js, agent-wrangler or a forbidden core module', () => {
  const bad = [/from\s+['"](\.\.\/)+index\.js['"]/, /\/(session-manager|state-reader|tmux-scraper)\.js['"]/, /\/host-api\//, /agent-wrangler/];
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.git'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(m?js)$/.test(e.name)) files.push(p);
    }
  };
  walk(dir);
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!/^\s*(import|export)\b.*\bfrom\b|^\s*import\s*\(/.test(line)) continue;
      for (const re of bad) assert.doesNotMatch(line, re, `${path.relative(dir, f)}: ${line.trim()}`);
    }
  }
});
