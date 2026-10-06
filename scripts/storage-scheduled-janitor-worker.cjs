'use strict';

// Runs from a fixture checkout under an isolated HOME. launchctl is stubbed with a file-backed loaded
// flag so a crash in one process is observed by recovery in the next; nothing outside HOME is touched.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const [scenario, phase = 'main'] = process.argv.slice(2);
const SCENARIOS = new Set(['repoint', 'refuse-private', 'rollback', 'interrupt-before-candidate', 'interrupt-after-candidate', 'normal-run']);
if (!SCENARIOS.has(scenario)) throw new Error('WORKER_ARGUMENT');
fs.statfsSync = () => ({ blocks: 1n, bsize: 4096n });

const realSpawnSync = childProcess.spawnSync;
const loadedFlag = path.join(process.env.HOME, 'launchctl-loaded');
const mutationLog = path.join(process.env.HOME, 'launchctl-mutations.log');
const crashAt = { 'interrupt-before-candidate': 'bootout', 'interrupt-after-candidate': 'kickstart' }[scenario];
let writeReport = () => {};

childProcess.spawnSync = (binary, args, options) => {
  if (binary !== '/bin/launchctl') return realSpawnSync(binary, args, options);
  const action = args[0];
  if (action === 'print') return { status: fs.existsSync(loadedFlag) ? 0 : 113, stdout: '', stderr: '' };
  fs.appendFileSync(mutationLog, `${action}\n`);
  if (phase === 'crash' && action === crashAt) process.exit(86);
  if (action === 'bootout') fs.rmSync(loadedFlag, { force: true });
  if (action === 'bootstrap') fs.writeFileSync(loadedFlag, '1');
  if (action === 'kickstart') writeReport();
  return { status: 0, stdout: '', stderr: '' };
};

const mutationCapability = require('./storage-capability.cjs').claim();
const { fixedLayout } = require('./storage-authority.cjs');
const state = require('./storage-state.cjs');
const stateMutations = state.bind(mutationCapability);
const scheduler = require('./storage-scheduler.cjs');
const schedulerMutations = scheduler.bind(mutationCapability);
const layout = fixedLayout();
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const records = () => state.listRecords('scheduler');
const pending = () => records().find((entry) => !['committed', 'restored'].includes(entry.state));
const priorPlist = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>${scheduler.LABEL}</string><key>ProgramArguments</key><array><string>/stale/node</string><string>/Users/stale/repos/pentacle-mobile-private/scripts/storage-cli.cjs</string><string>storage:janitor</string><string>dry-run</string></array><key>StartInterval</key><integer>21600</integer></dict></plist>\n`;

writeReport = () => {
  const transaction = pending();
  const reportId = crypto.randomUUID();
  const errors = scenario === 'rollback' ? [{ error: 'forced' }] : [];
  const binding = { transaction_id: transaction.id, generation: transaction.generation, candidate_digest: transaction.candidate_digest };
  fs.writeFileSync(path.join(layout.state, 'reports', `${reportId}.json`), `${JSON.stringify({ schema: 1, report_id: reportId, mode: 'dry-run', entries: [], errors, completed_at: new Date().toISOString(), ...binding })}\n`);
};

function seed() {
  for (const target of [layout.support, layout.stateImage, layout.state, layout.worktrees, layout.memory, path.dirname(layout.launchAgent), ...Object.values(layout.repositories)]) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(layout.state, 'reports'), { recursive: true, mode: 0o700 });
  const authority = stateMutations.createInstalledAuthority();
  fs.writeFileSync(layout.launchAgent, priorPlist, { mode: 0o600 });
  fs.writeFileSync(path.join(layout.state, 'scheduler-baseline.json'), `${JSON.stringify({ schema: 1, existed: false, digest: null, captured_at: new Date().toISOString() })}\n`, { mode: 0o600 });
  const clock = new Date(Date.now() - 60000).toISOString();
  stateMutations.createRecord('scheduler', { schema: 1, id: crypto.randomUUID(), revision: 0, state: 'committed', action: 'install', generation: authority.generation, prior_owned: false, prior_content: null, prior_loaded: false, created_at: clock, candidate_digest: sha(priorPlist), smoke_report_id: crypto.randomUUID(), smoke_report_digest: 'a'.repeat(64), committed_at: clock });
  fs.writeFileSync(loadedFlag, '1');
}

const sealView = () => JSON.stringify({ generation: state.readAuthorityState().generation, roots: state.readAuthorityState().roots });
const plist = () => fs.readFileSync(layout.launchAgent, 'utf8');
const wrapperPath = path.join(__dirname, 'storage-janitor-scheduled.cjs');
const runsWrapper = (text) => text.includes(`<string>${wrapperPath}</string>`);
const mutations = () => (fs.existsSync(mutationLog) ? fs.readFileSync(mutationLog, 'utf8').split('\n').filter(Boolean).length : 0);
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const failure = (error) => String(error.message || error);

if (scenario === 'normal-run') {
  for (const target of [layout.support, layout.stateImage, layout.state, layout.worktrees, layout.memory, ...Object.values(layout.repositories)]) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of ['runs', 'tickets', 'scheduler', 'reports']) fs.mkdirSync(path.join(layout.state, name), { recursive: true, mode: 0o700 });
  stateMutations.createInstalledAuthority();
  const preload = path.join(process.env.HOME, 'statfs-preload.cjs');
  fs.writeFileSync(preload, "require('node:fs').statfsSync = () => ({ blocks: 1n, bsize: 4096n });\n");
  const argv = [...scheduler.renderPlist().split('<key>ProgramArguments</key><array>')[1].split('</array>')[0].matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]);
  const result = realSpawnSync(argv[0], argv.slice(1), { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: `--require ${preload}` } });
  const reports = fs.readdirSync(path.join(layout.state, 'reports'));
  const report = reports.length === 1 ? JSON.parse(fs.readFileSync(path.join(layout.state, 'reports', reports[0]), 'utf8')) : null;
  const read = (name) => fs.readFileSync(path.join(layout.state, 'logs', name), 'utf8');
  emit({ argv: argv.map((value, index) => (index === 0 ? 'node' : path.relative(path.resolve(__dirname, '..'), value))), status: result.status, stderr: result.stderr, reportCount: reports.length, mode: report?.mode, errors: report?.errors, logs: fs.readdirSync(path.join(layout.state, 'logs')).sort(), footer: read('janitor.stderr.log').trim().split('\n').pop().replace(/at=.*/, 'at=*') });
  process.exit(0);
}

if (phase === 'crash') {
  schedulerMutations.installOrUpdate('update');
  throw new Error('WORKER_CRASH_NOT_REACHED');
}

seed();
const seals = sealView();
const priorRecords = JSON.stringify(records());

if (scenario === 'repoint') {
  const transaction = schedulerMutations.installOrUpdate('update');
  const record = state.readRecord('scheduler', transaction.id);
  const report = JSON.parse(fs.readFileSync(path.join(layout.state, 'reports', `${record.smoke_report_id}.json`), 'utf8'));
  emit({
    committed: record.state === 'committed',
    plistRunsWrapper: runsWrapper(plist()),
    plistDigestMatchesRecord: sha(plist()) === record.candidate_digest,
    sealsUnchanged: sealView() === seals,
    authorityState: state.readAuthorityState().state,
    priorPreimageStored: record.prior_content === priorPlist && record.prior_loaded === true,
    reportBound: report.transaction_id === record.id && report.candidate_digest === record.candidate_digest && report.mode === 'dry-run',
    interval: Number(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(plist())[1]),
  });
} else if (scenario === 'refuse-private') {
  const before = mutations();
  let error = 'NO_ERROR';
  try { schedulerMutations.installOrUpdate('update'); } catch (caught) { error = failure(caught); }
  emit({ error, plistUnchanged: plist() === priorPlist, recordsUnchanged: JSON.stringify(records()) === priorRecords, authorityState: state.readAuthorityState().state, launchctlMutations: mutations() - before });
} else if (scenario === 'rollback') {
  let error = 'NO_ERROR';
  try { schedulerMutations.installOrUpdate('update'); } catch (caught) { error = failure(caught); }
  const restored = records().find((entry) => entry.state === 'restored');
  emit({ error, plistRestored: plist() === priorPlist, priorLoadedAgain: fs.existsSync(loadedFlag), transactionState: restored?.state, authorityState: state.readAuthorityState().state, sealsUnchanged: sealView() === seals });
} else {
  const child = realSpawnSync(process.execPath, [__filename, scenario, 'crash'], { env: process.env, encoding: 'utf8' });
  const crashed = child.status === 86;
  if (!crashed) { process.stderr.write(`WORKER_CRASH_PHASE_FAILED:${child.status}:${child.stderr}\n`); process.exit(1); }
  const interrupted = pending();
  const recovered = schedulerMutations.recoverCommitted();
  const final = records().find((entry) => entry.id === interrupted.id);
  emit({
    crashed, interruptedState: interrupted.state, recovered, transactionState: final.state,
    plistRestored: plist() === priorPlist, plistRunsWrapper: runsWrapper(plist()),
    authorityState: state.readAuthorityState().state, sealsUnchanged: sealView() === seals,
  });
}
