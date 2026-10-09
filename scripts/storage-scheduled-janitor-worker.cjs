'use strict';

// Runs from a fixture checkout under an isolated HOME. launchctl is stubbed with a file-backed loaded
// flag so a crash in one process is observed by recovery in the next; nothing outside HOME is touched.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const [requestedScenario, phase = 'main'] = process.argv.slice(2);
// Historical update/rollback cases now use the real report producer too.
const scenario = { repoint: 'real-update', rollback: 'real-error' }[requestedScenario] || requestedScenario;
const SCENARIOS = new Set(['repoint', 'refuse-private', 'rollback', 'interrupt-before-candidate', 'interrupt-after-candidate', 'normal-run', 'real-update', 'real-error', 'real-no-report', 'real-observe', 'real-observe-owner-race', 'real-observe-state-race', 'real-report-owner-race', 'real-report-state-race', 'real-report-content-race', 'real-report-commit-race', 'real-acquisition-epoch', 'real-occupied-legacy', 'real-ordinary', 'normal-legacy', 'real-negative-owner-epoch', 'real-negative-owner-live-wrong', 'real-negative-owner-dead', 'real-negative-epoch-unavailable', 'real-negative-lock-missing', 'real-negative-legacy-lock', 'real-negative-unknown-lock', 'real-negative-transaction-missing', 'real-negative-transaction-wrong', 'real-negative-generation', 'real-negative-digest', 'real-negative-transaction-state', 'real-negative-multiple', 'real-negative-root', 'real-negative-host', 'real-negative-uid', 'real-negative-seal']);
if (!SCENARIOS.has(scenario)) throw new Error('WORKER_ARGUMENT');
fs.statfsSync = () => ({ blocks: 1n, bsize: 4096n });

const realSpawnSync = childProcess.spawnSync;
const loadedFlag = path.join(process.env.HOME, 'launchctl-loaded');
const mutationLog = path.join(process.env.HOME, 'launchctl-mutations.log');
const crashAt = { 'interrupt-before-candidate': 'bootout', 'interrupt-after-candidate': 'kickstart' }[scenario];

childProcess.spawnSync = (binary, args, options) => {
  if (binary !== '/bin/launchctl') return realSpawnSync(binary, args, options);
  const action = args[0];
  if (action === 'print') return { status: fs.existsSync(loadedFlag) ? 0 : 113, stdout: '', stderr: '' };
  fs.appendFileSync(mutationLog, `${action}\n`);
  if (phase === 'crash' && action === crashAt) process.exit(86);
  if (action === 'bootout') fs.rmSync(loadedFlag, { force: true });
  if (action === 'bootstrap') fs.writeFileSync(loadedFlag, '1');
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

if (['normal-run', 'normal-legacy'].includes(scenario)) {
  for (const target of [layout.support, layout.stateImage, layout.state, layout.worktrees, layout.memory, ...Object.values(layout.repositories)]) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of ['runs', 'tickets', 'scheduler', 'reports']) fs.mkdirSync(path.join(layout.state, name), { recursive: true, mode: 0o700 });
  const authority = stateMutations.createInstalledAuthority();
  if (scenario === 'normal-legacy') fs.writeFileSync(path.join(layout.state, 'scheduler.lock'), JSON.stringify({ schema: 1, token: crypto.randomUUID(), generation: authority.generation, host: authority.host, uid: authority.uid, pid: process.pid, created_at: new Date().toISOString() }), { mode: 0o600 });
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


// Only the OS/capacity boundary is modelled. The updater, wrapper, janitor, authority and journals
// execute unchanged in separate real CLI processes; no adapter writes a smoke report.

function schedulerBoundary(config) {
  const fs = require('node:fs');
  const path = require('node:path');
  const cp = require('node:child_process');
  const crypto = require('node:crypto');
  const home = process.env.HOME;
  const state = path.join(home, 'Library', 'PentacleMobileStorage', 'State');
  const loaded = path.join(home, 'loaded-model.json');
  const lockPath = path.join(state, 'scheduler.lock');
  const authorityPath = path.join(state, 'authority.json');
  const observations = path.join(home, 'child-observations.jsonl');
  const controls = path.join(home, 'controls.jsonl');
  const read = (target) => JSON.parse(fs.readFileSync(target, 'utf8'));
  const write = (target, value) => fs.writeFileSync(target, JSON.stringify(value) + '\n');
  const note = (value) => fs.appendFileSync(controls, JSON.stringify(value) + '\n');
  const scenario = config.scenario;
  const isJanitor = process.argv[2] === 'storage:janitor' && path.basename(process.argv[1]) === 'storage-cli.cjs';
  const isUpdate = process.argv[2] === 'storage:update';
  fs.statfsSync = () => ({ blocks: 1n, bsize: 4096n });
  const realExec = cp.execFileSync;
  cp.execFileSync = (binary, args, options) => {
    if (binary === '/bin/ps' && ((isUpdate && scenario === 'real-acquisition-epoch') || (isJanitor && scenario === 'real-negative-epoch-unavailable' && Number(args.at(-1)) !== process.pid))) return '';
    return realExec(binary, args, options);
  };
  function perturb(kind) {
    let owner = read(lockPath);
    const authority = read(authorityPath);
    const transactionPath = path.join(state, 'scheduler', `${owner.transaction_id}.json`);
    switch (kind) {
      case 'owner-epoch': owner.startToken += ':mismatch'; break;
      case 'owner-live-wrong': owner.pid = config.fixturePid; owner.startToken = 'different-original-epoch'; break;
      case 'owner-dead': owner.pid = read(path.join(home, 'dead-owner.json')).pid; break;
      case 'lock-missing': fs.unlinkSync(lockPath); note({ kind }); return;
      case 'legacy-lock': owner.schema = 1; delete owner.startToken; delete owner.transaction_id; break;
      case 'unknown-lock': owner.extra = true; break;
      case 'transaction-missing': fs.unlinkSync(transactionPath); note({ kind }); return;
      case 'transaction-wrong': owner.transaction_id = crypto.randomUUID(); break;
      case 'generation': owner.generation = crypto.randomUUID(); break;
      case 'digest': fs.appendFileSync(path.join(home, 'Library', 'LaunchAgents', 'com.pentacle.mobile.storage-janitor.plist'), '<!-- drift -->'); note({ kind }); return;
      case 'transaction-state': { const transaction = read(transactionPath); transaction.state = 'prepared'; write(transactionPath, transaction); note({ kind }); return; }
      case 'multiple': { const transaction = read(transactionPath); transaction.id = crypto.randomUUID(); write(path.join(state, 'scheduler', `${transaction.id}.json`), transaction); note({ kind }); return; }
      case 'root': authority.roots.worktrees.canonical = path.join(home, 'wrong-memory'); write(authorityPath, authority); note({ kind }); return;
      case 'host': authority.host = 'other-host'; write(authorityPath, authority); note({ kind }); return;
      case 'uid': authority.uid += 1; write(authorityPath, authority); note({ kind }); return;
      case 'seal': authority.roots.worktrees.inode = '0'; write(authorityPath, authority); note({ kind }); return;
      case 'state': authority.state = 'installed'; write(authorityPath, authority); note({ kind }); return;
      case 'token': owner.token = crypto.randomUUID(); break;
      default: throw new Error(`HARNESS_ERROR:unknown perturbation ${kind}`);
    }
    write(lockPath, owner);
    note({ kind, owner });
  }
  if (isJanitor) {
    if (scenario.startsWith('real-negative-') && scenario !== 'real-negative-epoch-unavailable') perturb(scenario.slice('real-negative-'.length));
    fs.appendFileSync(observations, JSON.stringify({ pid: process.pid, argv: process.argv, authority: read(authorityPath), lock: fs.existsSync(lockPath) ? read(lockPath) : null }) + '\n');
    if (scenario === 'real-no-report') fs.statfsSync = () => ({ blocks: 1000000000n, bsize: 4096n });
  }
  // Inject at the actual durable-payload boundary, without replacing the journal writer or validator.
  const descriptors = new Map();
  const realOpen = fs.openSync;
  fs.openSync = (target, ...args) => { const fd = realOpen(target, ...args); descriptors.set(fd, target); return fd; };
  const realClose = fs.closeSync;
  fs.closeSync = (fd) => { descriptors.delete(fd); return realClose(fd); };
  const realFsync = fs.fsyncSync;
  let injected = false;
  fs.fsyncSync = (fd) => {
    const result = realFsync(fd);
    const target = descriptors.get(fd);
    if (injected || typeof target !== 'string' || !/^\.[0-9a-f-]{36}\.json\.[0-9a-f-]{36}\.tmp$/.test(path.basename(target))) return result;
    if (isJanitor && scenario.startsWith('real-observe-') && target.startsWith(path.join(state, 'runs') + path.sep)) {
      const next = read(target);
      if (next.first_dead_at) { injected = true; perturb(scenario.endsWith('owner-race') ? 'token' : 'state'); note({ boundary: 'observe-dead', payload: next }); }
    }
    if (isUpdate && scenario.startsWith('real-report-') && target.startsWith(path.join(state, 'scheduler') + path.sep)) {
      const next = read(target);
      const boundary = scenario === 'real-report-commit-race' ? 'committed' : 'smoke_verified';
      if (next.state === boundary) {
        injected = true;
        if (scenario === 'real-report-content-race') {
          const reportPath = path.join(state, 'reports', `${next.smoke_report_id}.json`);
          const report = read(reportPath); report.entries.push({ kind: 'changed-after-read' }); write(reportPath, report);
          note({ kind: 'report-content' });
        } else perturb(scenario === 'real-report-state-race' ? 'state' : 'token');
        note({ boundary: 'report-acceptance', payload: next });
      }
    }
    return result;
  };
  const real = cp.spawnSync;
  cp.spawnSync = (binary, args, options) => {
    if (binary !== '/bin/launchctl') return real(binary, args, options);
    const action = args[0];
    if (action === 'print') return { status: fs.existsSync(loaded) ? 0 : 113, stdout: '', stderr: '' };
    if (action === 'bootout') fs.rmSync(loaded, { force: true });
    if (action === 'bootstrap') {
      const content = fs.readFileSync(args[2], 'utf8');
      const decode = (value) => value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
      const argv = [...content.split('<key>ProgramArguments</key><array>')[1].split('</array>')[0].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => decode(m[1]));
      const cwd = /<key>WorkingDirectory<\/key><string>([^<]*)<\/string>/.exec(content)?.[1] || home;
      write(loaded, { content, argv, cwd: decode(cwd) });
    }
    if (action === 'kickstart') {
      const model = read(loaded);
      if (scenario === 'real-ordinary') {
        const ordinary = real(model.argv[0], ['-e', "try{require('./scripts/storage-state.cjs').validateInstalledAuthority();process.exit(0)}catch(error){console.error(error.message);process.exit(1)}"], { cwd: model.cwd, env: process.env, encoding: 'utf8', timeout: 30000 });
        const apply = real(model.argv[0], [path.join(model.cwd, 'scripts', 'storage-cli.cjs'), 'storage:janitor', 'apply'], { cwd: model.cwd, env: process.env, encoding: 'utf8', timeout: 30000 });
        note({ ordinary: { status: ordinary.status, stderr: ordinary.stderr }, apply: { status: apply.status, stderr: apply.stderr } });
      }
      const child = real(model.argv[0], model.argv.slice(1), { cwd: model.cwd, env: process.env, encoding: 'utf8', timeout: 30000 });
      if (child.error) throw new Error(`HARNESS_ERROR:${child.error.message}`);
      write(path.join(home, 'wrapper-result.json'), { pid: child.pid, status: child.status, stdout: child.stdout, stderr: child.stderr, model });
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

function seedObservedRun(live = false) {
  const id = crypto.randomUUID();
  const exited = live ? { pid: process.pid, status: 0 } : realSpawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  if (exited.status !== 0 || !exited.pid) throw new Error('HARNESS_ERROR:dead owner setup');
  fs.writeFileSync(path.join(process.env.HOME, 'dead-owner.json'), JSON.stringify({ pid: exited.pid }));
  const authority = state.readAuthorityState();
  const clock = new Date(Date.now() - 60000).toISOString();
  const seals = {};
  for (const kind of ['scratch', 'evidence']) {
    const target = path.join(kind === 'scratch' ? layout.scratchImages : layout.evidenceImages, `${id}.sparsebundle`);
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(target, 'retained.txt'), `${kind} retained bytes\n`);
    seals[kind] = { object_id: crypto.randomUUID(), image: state.canonicalIdentity(target) };
  }
  return stateMutations.createRecord('runs', { schema: 1, id, revision: 0, state: 'allocated', generation: authority.generation,
    owner: { host: authority.host, uid: authority.uid, pid: exited.pid }, candidate_ref: 'a'.repeat(40), gate_code_sha: 'b'.repeat(40), gate_code_tree_clean: true,
    scratch_image: `${id}.sparsebundle`, evidence_image: `${id}.sparsebundle`, lock_token_digest: 'c'.repeat(64), reserved_at: clock, first_dead_at: null,
    scratch_seal: seals.scratch, evidence_seal: seals.evidence, device_set_identity: state.canonicalIdentity(layout.worktrees), allocated_at: clock });
}

function realUpdate() {
  for (const name of ['runs', 'tickets', 'scheduler', 'reports']) fs.mkdirSync(path.join(layout.state, name), { recursive: true, mode: 0o700 });
  const retainedRun = seedObservedRun(true);
  const observedRun = scenario.startsWith('real-observe') ? seedObservedRun() : null;
  if (scenario === 'real-negative-owner-dead') { const exited = realSpawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }); fs.writeFileSync(path.join(process.env.HOME, 'dead-owner.json'), JSON.stringify({ pid: exited.pid })); }
  if (scenario === 'real-occupied-legacy') { const authority = state.readAuthorityState(); fs.writeFileSync(path.join(layout.state, 'scheduler.lock'), JSON.stringify({ schema: 1, token: crypto.randomUUID(), generation: authority.generation, host: authority.host, uid: authority.uid, pid: process.pid, created_at: new Date().toISOString() }), { mode: 0o600 }); }
  const preload = path.join(process.env.HOME, 'scheduler-boundary.cjs');
  fs.writeFileSync(preload, `(${schedulerBoundary.toString()})(${JSON.stringify({ scenario, fixturePid: process.pid })});\n`);
  const loaded = path.join(process.env.HOME, 'loaded-model.json');
  const priorModel = { content: priorPlist, argv: ['/stale/node', '/Users/stale/repos/pentacle-mobile-private/scripts/storage-cli.cjs', 'storage:janitor', 'dry-run'], cwd: process.env.HOME };
  fs.writeFileSync(loaded, JSON.stringify(priorModel));
  if (scenario === 'real-error') fs.writeFileSync(path.join(layout.state, 'runs', `${crypto.randomUUID()}.json`), '{broken');
  const retained = () => Object.fromEntries(fs.readdirSync(path.join(layout.state, 'runs')).map((name) => [name, sha(fs.readFileSync(path.join(layout.state, 'runs', name)))]));
  const before = retained();
  const imageHashes = () => Object.fromEntries(['scratch', 'evidence'].flatMap((kind) => { const dir = kind === 'scratch' ? layout.scratchImages : layout.evidenceImages; return fs.existsSync(dir) ? fs.readdirSync(dir).map((name) => [`${kind}/${name}`, sha(fs.readFileSync(path.join(dir, name, 'retained.txt')))]) : []; }));
  const priorImages = imageHashes();
  const update = realSpawnSync(process.execPath, [path.join(__dirname, 'storage-cli.cjs'), 'storage:update'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, NODE_OPTIONS: `--require ${preload}` }, encoding: 'utf8', timeout: 45000 });
  if (update.error) throw new Error(`HARNESS_ERROR:${update.error.message}`);
  const read = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const observations = read(path.join(process.env.HOME, 'child-observations.jsonl'))?.trim().split('\n').map(JSON.parse) || [];
  const reports = fs.readdirSync(path.join(layout.state, 'reports')).map((name) => JSON.parse(fs.readFileSync(path.join(layout.state, 'reports', name), 'utf8')));
  const transaction = records().find((entry) => entry.action === 'update');
  const controls = read(path.join(process.env.HOME, 'controls.jsonl'))?.trim().split('\n').map(JSON.parse) || [];

  const evidence = { scenario, requestedScenario, fixturePid: process.pid, committed: transaction?.state === 'committed', plistRunsWrapper: runsWrapper(plist()), plistDigestMatchesRecord: transaction?.candidate_digest === sha(plist()), sealsUnchanged: JSON.stringify({ generation: JSON.parse(fs.readFileSync(path.join(layout.state, 'authority.json'), 'utf8')).generation, roots: JSON.parse(fs.readFileSync(path.join(layout.state, 'authority.json'), 'utf8')).roots }) === seals, authorityState: JSON.parse(fs.readFileSync(path.join(layout.state, 'authority.json'), 'utf8')).state, priorPreimageStored: transaction?.prior_content === priorPlist && transaction?.prior_loaded === true, reportBound: reports.length === 1 && reports[0].transaction_id === transaction?.id && reports[0].candidate_digest === transaction?.candidate_digest, interval: Number(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(plist())[1]), error: update.stderr.trim(), priorLoadedAgain: fs.existsSync(loaded), transactionState: transaction?.state, retainedRun, controls, observedRunBefore: observedRun, observedRunAfter: observedRun ? state.readRecord('runs', observedRun.id) : null, retainedImagesUnchanged: JSON.stringify(priorImages) === JSON.stringify(imageHashes()), update: { pid: update.pid, status: update.status, stdout: update.stdout, stderr: update.stderr }, observations, wrapper: JSON.parse(read(path.join(process.env.HOME, 'wrapper-result.json')) || 'null'), janitorLog: read(path.join(layout.state, 'logs', 'janitor.stderr.log')), reports, transaction, authority: JSON.parse(fs.readFileSync(path.join(layout.state, 'authority.json'), 'utf8')), plistRestored: plist() === priorPlist, loadedModel: JSON.parse(read(loaded) || 'null'), priorModel, retainedUnchanged: JSON.stringify(before) === JSON.stringify(retained()), locks: fs.readdirSync(layout.state).filter((name) => name.endsWith('.lock')) };
  if (process.env.STORAGE_FIXTURE_RECEIPT) fs.writeFileSync(process.env.STORAGE_FIXTURE_RECEIPT, JSON.stringify(evidence, null, 2) + '\n');
  if (process.env.STORAGE_FIXTURE_RECEIPT_DIR) fs.writeFileSync(path.join(process.env.STORAGE_FIXTURE_RECEIPT_DIR, `${scenario}.json`), JSON.stringify(evidence, null, 2) + '\n');
  emit(evidence);
}

if (scenario.startsWith('real-')) {
  realUpdate();
} else if (scenario === 'refuse-private') {
  const before = mutations();
  let error = 'NO_ERROR';
  try { schedulerMutations.installOrUpdate('update'); } catch (caught) { error = failure(caught); }
  emit({ error, plistUnchanged: plist() === priorPlist, recordsUnchanged: JSON.stringify(records()) === priorRecords, authorityState: state.readAuthorityState().state, launchctlMutations: mutations() - before });

} else {
  const child = realSpawnSync(process.execPath, [__filename, scenario, 'crash'], { env: process.env, encoding: 'utf8' });
  const crashed = child.status === 86;
  if (!crashed) { process.stderr.write(`WORKER_CRASH_PHASE_FAILED:${child.status}:${child.stderr}\n`); process.exit(1); }
  const interrupted = pending();
  let recovered; let recoveryError = null;
  try { recovered = schedulerMutations.recoverCommitted(); } catch (error) { recoveryError = failure(error); }
  const final = records().find((entry) => entry.id === interrupted.id);
  emit({
    crashed, recoveryError, interruptedState: interrupted.state, recovered, transactionState: final.state,
    plistRestored: plist() === priorPlist, plistRunsWrapper: runsWrapper(plist()),
    authorityState: state.readAuthorityState().state, sealsUnchanged: sealView() === seals,
  });
}
