'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function runStep(command, args, options, label) {
  const result = spawnSync(command, args, options);
  if (result.error || result.status !== 0) {
    const reason = result.error?.message || `exit code ${result.status}`;
    console.error(`postinstall: ${label} failed (${reason})`);
    return false;
  }
  return true;
}

function run(root = ROOT) {
  const dashboard = path.join(root, 'dashboard');
  if (
    fs.existsSync(dashboard) &&
    !runStep('npm', ['run', 'dashboard:install'], { cwd: root, stdio: 'inherit', shell: true }, 'dashboard install')
  ) {
    return 1;
  }

  const messageIdPatcher = path.join(root, 'scripts', 'patch-wwebjs-201832.js');
  if (
    fs.existsSync(messageIdPatcher) &&
    !runStep(
      process.execPath,
      [messageIdPatcher, '--best-effort'],
      { cwd: root, stdio: 'inherit' },
      'whatsapp-web.js message-id repair',
    )
  ) {
    return 1;
  }

  const readySyncPatcher = path.join(root, 'scripts', 'patch-wwebjs-ready-sync.js');
  if (
    fs.existsSync(readySyncPatcher) &&
    !runStep(
      process.execPath,
      [readySyncPatcher, '--best-effort'],
      { cwd: root, stdio: 'inherit' },
      'whatsapp-web.js ready-sync repair',
    )
  ) {
    return 1;
  }

  return 0;
}

if (require.main === module) process.exit(run());

module.exports = { run, runStep, ROOT };
