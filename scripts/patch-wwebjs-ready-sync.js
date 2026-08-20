/**
 * Repair whatsapp-web.js 1.34.7 warm-session readiness.
 *
 * A restored page can reach hasSynced=true before the library subscribes to the
 * change event. The post-auth pipeline then never runs. The library can also emit
 * ready before attachEventListeners() finishes, leaving a connected session with
 * no inbound message bridge. This exact-shape patch closes both races.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const CLIENT_PATH = path.join('src', 'Client.js');

const FLAG_INIT_FIND = `        this.currentIndexHtml = null;
        this.lastLoggedOut = false;`;

const FLAG_INIT_REPLACE = `        this.currentIndexHtml = null;
        this.lastLoggedOut = false;
        // True only after the page-to-Node message bridge is fully attached.
        this.eventsAttached = false;`;

const ATTACH_MARK_FIND = `                    await this.attachEventListeners();
                }`;

const ATTACH_MARK_REPLACE = `                    await this.attachEventListeners();
                    this.eventsAttached = true;
                }`;

const HAS_SYNCED_FIND = `            window
                .require('WAWebSocketModel')
                .Socket.on('change:hasSynced', () => {
                    window.onAppStateHasSyncedEvent();
                });`;

const HAS_SYNCED_REPLACE = `            window
                .require('WAWebSocketModel')
                .Socket.on('change:hasSynced', () => {
                    window.onAppStateHasSyncedEvent();
                });
            // Warm profiles can already be synchronized before the edge listener exists.
            if (window.require('WAWebSocketModel').Socket.hasSynced) {
                window.onAppStateHasSyncedEvent();
            }`;

const EDITS = [
  { find: FLAG_INIT_FIND, replace: FLAG_INIT_REPLACE },
  { find: ATTACH_MARK_FIND, replace: ATTACH_MARK_REPLACE },
  { find: HAS_SYNCED_FIND, replace: HAS_SYNCED_REPLACE },
];

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

function applyReadySyncPatch(wwjsDir = DEFAULT_WWJS) {
  const clientFile = path.join(wwjsDir, CLIENT_PATH);
  if (!fs.existsSync(clientFile)) {
    throw new Error(`whatsapp-web.js Client.js not found at ${clientFile}`);
  }

  let source = fs.readFileSync(clientFile, 'utf8');
  const replacements = EDITS.map(edit => occurrences(source, edit.replace));
  const originals = EDITS.map(edit => occurrences(source.split(edit.replace).join(''), edit.find));

  if (originals.every(count => count === 0) && replacements.every(count => count === 1)) {
    return { skipped: true, reason: 'installed whatsapp-web.js already carries the ready-sync repair' };
  }

  if (originals.every(count => count === 1) && replacements.every(count => count === 0)) {
    for (const edit of EDITS) source = source.replace(edit.find, edit.replace);
    fs.writeFileSync(clientFile, source);
    return { skipped: false, note: 'readiness marker and hasSynced level check applied' };
  }

  throw new Error(
    `unsupported Client.js shape (unpatched: ${originals.join(',')}, patched: ${replacements.join(',')})`,
  );
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyReadySyncPatch();
    console.log(`patch-wwebjs-ready-sync: ${result.skipped ? `skipped - ${result.reason}` : result.note}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-ready-sync: skipped - ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-ready-sync: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = {
  applyReadySyncPatch,
  EDITS,
  FLAG_INIT_FIND,
  FLAG_INIT_REPLACE,
  ATTACH_MARK_FIND,
  ATTACH_MARK_REPLACE,
  HAS_SYNCED_FIND,
  HAS_SYNCED_REPLACE,
};
