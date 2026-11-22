'use strict';

// Preload for fixture CLI runs (with storage-authority-reseal-preload.cjs): replaces the launchctl boundary with a
// file-backed model so no real launchd is ever contacted, and fails closed on any launchctl verb it does not model.
// The scheduler transaction, authority and validators execute unchanged; kickstart writes the bound smoke report.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { printLoadedService } = require('./storage-launchctl-print-fixture.cjs');

const root = process.env.SCHEDULER_FIXTURE_ROOT;
const scenario = process.env.SCHEDULER_FIXTURE_SCENARIO || '';
if (!root || !path.isAbsolute(root) || !fs.existsSync(path.join(root, 'fixture.json'))) throw new Error('SCHEDULER_FIXTURE_REQUIRED');
const LABEL = 'com.pentacle.mobile.storage-janitor';
const loadedFlag = path.join(root, 'launchctl-loaded');
const actionsLog = path.join(root, 'launchctl-actions.log');
const plistPath = path.join(root, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const state = path.join(root, 'Library', 'PentacleMobileStorage', 'State');
const real = cp.spawnSync;

cp.spawnSync = (binary, args, options) => {
  if (binary === '/usr/bin/codesign' && scenario === 'codesign-fail') return { status: 1, stdout: '', stderr: 'forced codesign failure' };
  if (binary !== '/bin/launchctl') return real(binary, args, options);
  const action = args[0];
  fs.appendFileSync(actionsLog, `${action}\n`);
  const service = `gui/${process.getuid()}/${LABEL}`;
  if (action === 'print' && args.length === 2 && args[1] === service) {
    if (!fs.existsSync(loadedFlag)) return { status: 113, stdout: '', stderr: 'not found' };
    const text = fs.readFileSync(plistPath, 'utf8');
    if (scenario === 'bare-print') return { status: 0, stdout: `gui/501/${LABEL} = {\n\tproperties = inferred program\n}\n`, stderr: '' };
    return { status: 0, stdout: printLoadedService(LABEL, text), stderr: '' };
  }
  if (action === 'bootstrap' && args.length === 3 && args[1] === `gui/${process.getuid()}` && args[2] === plistPath) { fs.writeFileSync(loadedFlag, '1'); return { status: 0, stdout: '', stderr: '' }; }
  if (action === 'bootout' && args.length === 2 && args[1] === service) { fs.rmSync(loadedFlag, { force: true }); return { status: 0, stdout: '', stderr: '' }; }
  if (action === 'kickstart' && args.join(' ') === `kickstart -k ${service}`) {
    if (!fs.existsSync(loadedFlag)) return { status: 113, stdout: '', stderr: 'not loaded' };
    const directory = path.join(state, 'scheduler');
    const open = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))).filter((record) => !['committed', 'restored'].includes(record.state));
    if (open.length !== 1) return { status: 1, stdout: '', stderr: 'fixture: one open transaction expected' };
    const reportId = crypto.randomUUID();
    fs.writeFileSync(path.join(state, 'reports', `${reportId}.json`), `${JSON.stringify({ schema: 1, report_id: reportId, mode: 'dry-run', entries: [], errors: [], completed_at: new Date().toISOString(), transaction_id: open[0].id, generation: open[0].generation, candidate_digest: open[0].candidate_digest })}\n`);
    return { status: 0, stdout: '', stderr: '' };
  }
  return { status: 99, stdout: '', stderr: `fixture refuses unmodelled launchctl ${args.join(' ')}` };
};
