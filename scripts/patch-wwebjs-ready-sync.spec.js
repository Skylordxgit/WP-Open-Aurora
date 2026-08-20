'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  applyReadySyncPatch,
  FLAG_INIT_FIND,
  FLAG_INIT_REPLACE,
  ATTACH_MARK_FIND,
  ATTACH_MARK_REPLACE,
  HAS_SYNCED_FIND,
  HAS_SYNCED_REPLACE,
} = require('./patch-wwebjs-ready-sync');

function fixtureSource(flag = FLAG_INIT_FIND, attach = ATTACH_MARK_FIND, synced = HAS_SYNCED_FIND) {
  return `class Client {\n  constructor() {\n${flag}\n  }\n  async inject() {\n${attach}\n${synced}\n  }\n}\n`;
}

function withFixture(source, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-ready-sync-'));
  const clientDir = path.join(root, 'src');
  fs.mkdirSync(clientDir, { recursive: true });
  const clientFile = path.join(clientDir, 'Client.js');
  fs.writeFileSync(clientFile, source);
  try {
    callback(root, clientFile);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('applies all readiness transforms atomically', () => {
  withFixture(fixtureSource(), (root, clientFile) => {
    assert.deepEqual(applyReadySyncPatch(root), {
      skipped: false,
      note: 'readiness marker and hasSynced level check applied',
    });
    const patched = fs.readFileSync(clientFile, 'utf8');
    assert.match(patched, /eventsAttached = false/);
    assert.match(patched, /eventsAttached = true/);
    assert.match(patched, /Socket\.hasSynced/);
  });
});

test('is idempotent on an already-patched dependency', () => {
  withFixture(fixtureSource(FLAG_INIT_REPLACE, ATTACH_MARK_REPLACE, HAS_SYNCED_REPLACE), root => {
    assert.equal(applyReadySyncPatch(root).skipped, true);
  });
});

test('refuses an unknown or partially-patched Client.js shape', () => {
  withFixture(fixtureSource(FLAG_INIT_REPLACE, ATTACH_MARK_FIND, HAS_SYNCED_FIND), root => {
    assert.throws(() => applyReadySyncPatch(root), /unsupported Client\.js shape/);
  });
});
