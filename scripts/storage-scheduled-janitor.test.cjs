'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { after, test } = require('node:test');

const PUBLIC_ORIGIN = 'https://github.com/HJK6/pentacle-mobile.git';
const FIXTURE_TIMEOUT_MS = 120000;
const roots = [];

function temporary(prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));
  roots.push(root);
  return root;
}
after(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function git(cwd, ...args) {
  return execFileSync('/usr/bin/git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: cwd, LC_ALL: 'C' }, timeout: FIXTURE_TIMEOUT_MS });
}

// A canonical checkout at <home>/repos/pentacle-mobile whose scripts are a copy of this checkout's, so
// the worker that runs from it renders and admits exactly what a real installed root would.
function checkout(home, { origin = PUBLIC_ORIGIN, published = true, location = null } = {}) {
  const repo = location || path.join(home, 'repos', 'pentacle-mobile');
  fs.mkdirSync(repo, { recursive: true });
  fs.cpSync(__dirname, path.join(repo, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'package.json'), path.join(repo, 'package.json'));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
  fs.symlinkSync(path.join(__dirname, '..', 'node_modules'), path.join(repo, 'node_modules'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'fixture');
  if (published) git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return repo;
}

function withHome(home, action) {
  const prior = process.env.HOME;
  process.env.HOME = home;
  try { return action(home); } finally { if (prior === undefined) delete process.env.HOME; else process.env.HOME = prior; }
}

test('public-root admission accepts only the clean, published, canonical public checkout', () => {
  const home = temporary('janitor-root');
  withHome(home, () => {
    const { assertPublicRoot, fixedLayout } = require('./storage-authority.cjs');
    const repo = checkout(home);
    const layout = fixedLayout();
    assert.doesNotThrow(() => assertPublicRoot(layout, path.join(repo, 'scripts')));
    for (const ssh of ['git@github.com:HJK6/pentacle-mobile.git', 'https://github.com/HJK6/pentacle-mobile', 'ssh://git@github.com/HJK6/pentacle-mobile.git']) {
      git(repo, 'remote', 'set-url', 'origin', ssh);
      assert.doesNotThrow(() => assertPublicRoot(layout, path.join(repo, 'scripts')), ssh);
    }
  });
});

test('public-root admission refuses private, lookalike, unpublished, dirty and ambiguous roots', () => {
  const home = temporary('janitor-root-refuse');
  withHome(home, () => {
    const { assertPublicRoot, fixedLayout } = require('./storage-authority.cjs');
    const repo = checkout(home);
    const scripts = path.join(repo, 'scripts');
    const layout = fixedLayout();
    for (const origin of ['git@github.com:HJK6/pentacle-mobile-private.git', 'https://github.com/HJK6/pentacle-mobile-private', 'https://github.com/other/pentacle-mobile.git', 'https://example.com/HJK6/pentacle-mobile.git', 'https://github.com/HJK6/pentacle-mobile.git/extra', '/tmp/local-mirror']) {
      git(repo, 'remote', 'set-url', 'origin', origin);
      assert.throws(() => assertPublicRoot(layout, scripts), /PUBLIC_ROOT_ORIGIN/, origin);
    }
    git(repo, 'remote', 'set-url', 'origin', PUBLIC_ORIGIN);
    git(repo, 'remote', 'set-url', '--push', 'origin', 'git@github.com:HJK6/pentacle-mobile-private.git');
    assert.throws(() => assertPublicRoot(layout, scripts), /PUBLIC_ROOT_ORIGIN/, 'a private push URL is not the public root');
    git(repo, 'config', '--unset-all', 'remote.origin.pushurl');
    git(repo, 'remote', 'set-url', 'origin', 'https://evil.example/x.git');
    git(repo, 'config', `url.${PUBLIC_ORIGIN}.insteadOf`, 'https://evil.example/x.git');
    assert.throws(() => assertPublicRoot(layout, scripts), /PUBLIC_ROOT_ORIGIN/, 'an insteadOf rewrite cannot disguise another origin');
    git(repo, 'config', '--unset-all', `url.${PUBLIC_ORIGIN}.insteadOf`);
    git(repo, 'remote', 'set-url', 'origin', PUBLIC_ORIGIN);
    fs.writeFileSync(path.join(repo, 'stray.txt'), 'untracked');
    assert.throws(() => assertPublicRoot(layout, scripts), /PUBLIC_ROOT_DIRTY/);
    fs.unlinkSync(path.join(repo, 'stray.txt'));
    fs.appendFileSync(path.join(scripts, 'storage-cli.cjs'), '\n// local edit\n');
    assert.throws(() => assertPublicRoot(layout, scripts), /PUBLIC_ROOT_DIRTY/);
    git(repo, 'checkout', '--', 'scripts/storage-cli.cjs');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'local only');
    assert.throws(() => assertPublicRoot(layout, scripts), /PUBLIC_ROOT_UNPUBLISHED/, 'a commit absent from origin/main is not reviewed public code');
    git(repo, 'update-ref', '-d', 'refs/remotes/origin/main');
    assert.throws(() => assertPublicRoot(layout, scripts), /PUBLIC_ROOT_UNPUBLISHED/, 'no origin/main at all');
  });
});

test('public-root admission refuses symlinked, ephemeral, worktree and non-canonical roots', () => {
  const home = temporary('janitor-root-shape');
  withHome(home, () => {
    const { assertPublicRoot, fixedLayout } = require('./storage-authority.cjs');
    const layout = fixedLayout();
    const real = checkout(home, { location: path.join(home, 'elsewhere', 'real') });
    fs.mkdirSync(path.dirname(layout.repositories['pentacle-mobile']), { recursive: true });
    fs.symlinkSync(real, layout.repositories['pentacle-mobile']);
    assert.throws(() => assertPublicRoot(layout, path.join(layout.repositories['pentacle-mobile'], 'scripts')), /PUBLIC_ROOT_SYMLINK/);
    assert.throws(() => assertPublicRoot(layout, path.join(real, 'scripts')), /PUBLIC_ROOT_NOT_CANONICAL/, 'a valid clone at any other path is not the canonical root');
    fs.unlinkSync(layout.repositories['pentacle-mobile']);

    const lane = checkout(home, { location: path.join(layout.worktrees, 'lane') });
    assert.throws(() => assertPublicRoot(layout, path.join(lane, 'scripts')), /PUBLIC_ROOT_EPHEMERAL/);
    const scratch = checkout(home, { location: path.join(temporary('janitor-root-tmp'), 'pentacle-mobile') });
    assert.throws(() => assertPublicRoot(layout, path.join(scratch, 'scripts')), /PUBLIC_ROOT_(EPHEMERAL|NOT_CANONICAL)/);

    const canonical = checkout(home);
    assert.throws(() => assertPublicRoot(layout, path.join(canonical, 'scripts', '..', 'package.json')), /PUBLIC_ROOT_NOT_CANONICAL/);
    assert.throws(() => assertPublicRoot(layout, canonical), /PUBLIC_ROOT_NOT_CANONICAL/, 'the script root is exactly <root>/scripts');
    const gitDirectory = path.join(canonical, '.git');
    const moved = path.join(home, 'moved-git');
    fs.renameSync(gitDirectory, moved);
    fs.writeFileSync(gitDirectory, `gitdir: ${moved}\n`);
    assert.throws(() => assertPublicRoot(layout, path.join(canonical, 'scripts')), /PUBLIC_ROOT_WORKTREE/, 'a gitdir file is a linked worktree or submodule, not a plain clone');
  });
});

test('the LaunchAgent keeps its six-hour dry-run /dev/null contract and runs the bounded wrapper', () => {
  const home = temporary('janitor-plist');
  withHome(home, () => {
    const plist = require('./storage-scheduler.cjs').renderPlist();
    const wrapper = path.join(__dirname, 'storage-janitor-scheduled.cjs');
    assert.ok(fs.existsSync(wrapper), 'wrapper exists');
    const argv = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]);
    const start = argv.indexOf(process.execPath);
    assert.deepEqual(argv.slice(start, start + 4), [process.execPath, wrapper, 'storage:janitor', 'dry-run']);
    assert.match(plist, /<key>StartInterval<\/key>\s*<integer>21600<\/integer>/);
    assert.match(plist, /<key>StandardOutPath<\/key><string>\/dev\/null<\/string>/);
    assert.match(plist, /<key>StandardErrorPath<\/key><string>\/dev\/null<\/string>/);
    assert.equal(plist.includes('apply'), false);
  });
});

function stateRoot(home) {
  const state = path.join(home, 'Library', 'PentacleMobileStorage', 'State');
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  return state;
}

const noisy = (stdoutBytes, stderrBytes, code) => ['-e', `
const out = Buffer.alloc(${stdoutBytes}, 'o'); const err = Buffer.alloc(${stderrBytes}, 'e');
process.stdout.write(out, () => process.stderr.write(err, () => process.exit(${code})));`];

test('the wrapper retains at most 4 MiB of current and previous output and marks truncation and failure', async () => {
  const home = temporary('janitor-logs');
  const state = stateRoot(home);
  const { run, LOG_CAP_BYTES } = require('./storage-janitor-scheduled.cjs');
  assert.equal(LOG_CAP_BYTES * 4, 4 * 1024 * 1024);
  const logs = path.join(state, 'logs');
  const total = () => fs.readdirSync(logs).reduce((sum, name) => sum + fs.statSync(path.join(logs, name)).size, 0);

  assert.equal(await run({ state, command: process.execPath, args: noisy(3 * 1024 * 1024, 3 * 1024 * 1024, 7) }), 7, 'the child exit status is the job status');
  assert.deepEqual(fs.readdirSync(logs).sort(), ['janitor.stderr.log', 'janitor.stdout.log']);
  for (const name of fs.readdirSync(logs)) {
    assert.ok(fs.statSync(path.join(logs, name)).size <= LOG_CAP_BYTES, name);
    assert.equal(fs.statSync(path.join(logs, name)).mode & 0o777, 0o600);
  }
  assert.match(fs.readFileSync(path.join(logs, 'janitor.stdout.log'), 'utf8'), /\[pentacle-janitor-log truncated: \d+ bytes dropped/);
  const failure = fs.readFileSync(path.join(logs, 'janitor.stderr.log'), 'utf8');
  assert.match(failure, /\[pentacle-janitor-log truncated: \d+ bytes dropped/);
  assert.match(failure, /\[pentacle-janitor-run exit=7 signal=none at=\d{4}-\d\d-\d\dT[^\]]+\]\n$/, 'the exit marker survives truncation');

  assert.equal(await run({ state, command: process.execPath, args: noisy(3 * 1024 * 1024, 3 * 1024 * 1024, 0) }), 0);
  assert.deepEqual(fs.readdirSync(logs).sort(), ['janitor.stderr.log', 'janitor.stderr.log.1', 'janitor.stdout.log', 'janitor.stdout.log.1']);
  assert.ok(total() <= 4 * 1024 * 1024, `retained ${total()} bytes`);
  assert.match(fs.readFileSync(path.join(logs, 'janitor.stderr.log.1'), 'utf8'), /exit=7/, 'the previous run is the one retained, not discarded');
  assert.match(fs.readFileSync(path.join(logs, 'janitor.stderr.log'), 'utf8'), /exit=0/);

  assert.equal(await run({ state, command: process.execPath, args: ['-e', 'process.kill(process.pid, "SIGKILL")'] }), 1);
  assert.match(fs.readFileSync(path.join(logs, 'janitor.stderr.log'), 'utf8'), /exit=none signal=SIGKILL/);
  assert.equal(await run({ state, command: path.join(home, 'missing-node'), args: [] }), 1);
  assert.match(fs.readFileSync(path.join(logs, 'janitor.stderr.log'), 'utf8'), /\[pentacle-janitor-run spawn-failed ENOENT/);
  assert.ok(total() <= 4 * 1024 * 1024);
});

test('wrapper capture failure never masks the job: the child still runs and the failure is marked', async () => {
  const home = temporary('janitor-logs-blocked');
  const state = stateRoot(home);
  fs.writeFileSync(path.join(state, 'logs'), 'a file where the log directory belongs');
  const { run } = require('./storage-janitor-scheduled.cjs');
  const marker = path.join(home, 'child-ran');
  const stderr = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  let status;
  try { status = await run({ state, command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(3)`] }); }
  finally { process.stderr.write = write; }
  assert.equal(status, 3);
  assert.ok(fs.existsSync(marker), 'the janitor still ran');
  assert.match(stderr.join(''), /\[pentacle-janitor-run capture-failed /);
  assert.equal(fs.readFileSync(path.join(state, 'logs'), 'utf8'), 'a file where the log directory belongs', 'the blocker is never replaced');
});

test('the wrapper accepts only the fixed dry-run arguments and no caller-selected path', () => {
  const home = temporary('janitor-wrapper-args');
  stateRoot(home);
  const wrapper = path.join(__dirname, 'storage-janitor-scheduled.cjs');
  for (const args of [[], ['storage:janitor'], ['storage:janitor', 'apply'], ['storage:janitor', 'dry-run', '--path', '/tmp'], ['storage:gate', 'dry-run']]) {
    const result = spawnSync(process.execPath, [wrapper, ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: FIXTURE_TIMEOUT_MS });
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /JANITOR_WRAPPER_ARGUMENTS/);
  }
});

test('state layout admits the bounded logs directory and nothing else inside it', () => {
  const home = temporary('janitor-layout');
  withHome(home, () => {
    const state = stateRoot(home);
    const { validateStateLayout } = require('./storage-state.cjs');
    const logs = path.join(state, 'logs');
    fs.mkdirSync(logs, { mode: 0o700 });
    for (const name of ['janitor.stdout.log', 'janitor.stderr.log', 'janitor.stdout.log.1', 'janitor.stderr.log.1']) fs.writeFileSync(path.join(logs, name), 'x', { mode: 0o600 });
    assert.equal(validateStateLayout(state), true);
    fs.writeFileSync(path.join(logs, 'extra.log'), 'x', { mode: 0o600 });
    assert.throws(() => validateStateLayout(state), /STATE_LAYOUT_UNKNOWN:logs\/extra\.log/);
    fs.unlinkSync(path.join(logs, 'extra.log'));
    fs.writeFileSync(path.join(logs, 'janitor.stdout.log'), Buffer.alloc(1024 * 1024 + 1, 'x'), { mode: 0o600 });
    assert.throws(() => validateStateLayout(state), /STATE_LAYOUT_UNKNOWN:logs\/janitor\.stdout\.log/);
    fs.writeFileSync(path.join(logs, 'janitor.stdout.log'), 'x', { mode: 0o600 });
    fs.unlinkSync(path.join(logs, 'janitor.stderr.log'));
    fs.symlinkSync('/etc/hosts', path.join(logs, 'janitor.stderr.log'));
    assert.throws(() => validateStateLayout(state), /STATE_LAYOUT_UNKNOWN:logs\/janitor\.stderr\.log/);
  });
});

function worker(home, repo, scenario) {
  return spawnSync(process.execPath, [path.join(repo, 'scripts', 'storage-scheduled-janitor-worker.cjs'), scenario], { cwd: repo, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: FIXTURE_TIMEOUT_MS });
}

function transactional(name, scenario, verdict) {
  test(name, () => {
    const home = temporary('jr');
    const repo = checkout(home);
    if (scenario === 'refuse-private') git(repo, 'remote', 'set-url', 'origin', 'git@github.com:HJK6/pentacle-mobile-private.git');
    const result = worker(home, repo, scenario);
    verdict(result, { home, repo });
  });
}

const ok = (result) => { assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`); return JSON.parse(result.stdout.trim().split('\n').pop()); };

transactional('update repoints the sealed LaunchAgent at the public wrapper and commits with unchanged seals', 'repoint', (result) => {
  const evidence = ok(result);
  assert.equal(evidence.committed, true);
  assert.equal(evidence.plistRunsWrapper, true);
  assert.equal(evidence.plistDigestMatchesRecord, true);
  assert.equal(evidence.sealsUnchanged, true);
  assert.equal(evidence.authorityState, 'installed');
  assert.equal(evidence.priorPreimageStored, true);
  assert.equal(evidence.reportBound, true);
  assert.equal(evidence.interval, 21600);
});

transactional('update from a non-public root is refused before any mutation', 'refuse-private', (result) => {
  const evidence = ok(result);
  assert.match(evidence.error, /PUBLIC_ROOT_ORIGIN/);
  assert.equal(evidence.plistUnchanged, true);
  assert.equal(evidence.recordsUnchanged, true);
  assert.equal(evidence.authorityState, 'installed');
  assert.equal(evidence.launchctlMutations, 0);
});

transactional('failed smoke rolls the prior plist back byte for byte and leaves the authority installed', 'rollback', (result) => {
  const evidence = ok(result);
  assert.match(evidence.error, /SCHEDULER_SMOKE/);
  assert.equal(evidence.plistRestored, true);
  assert.equal(evidence.priorLoadedAgain, true);
  assert.equal(evidence.transactionState, 'restored');
  assert.equal(evidence.authorityState, 'installed');
  assert.equal(evidence.sealsUnchanged, true);
});

transactional('an update interrupted before the candidate lands recovers to the prior plist', 'interrupt-before-candidate', (result) => {
  const evidence = ok(result);
  assert.equal(evidence.crashed, true);
  assert.equal(evidence.plistRestored, true);
  assert.equal(evidence.transactionState, 'restored');
  assert.equal(evidence.authorityState, 'installed');
});

transactional('an update interrupted after the candidate lands recovers forward to a committed wrapper plist', 'interrupt-after-candidate', (result) => {
  const evidence = ok(result);
  assert.equal(evidence.crashed, true);
  assert.equal(evidence.transactionState, 'committed');
  assert.equal(evidence.plistRunsWrapper, true);
  assert.equal(evidence.authorityState, 'installed');
  assert.equal(evidence.sealsUnchanged, true);
});

transactional('the exact scheduled argv runs a real dry-run, writes one bound report and retains its output', 'normal-run', (result) => {
  const evidence = ok(result);
  assert.deepEqual(evidence.argv, ['node', 'scripts/storage-janitor-scheduled.cjs', 'storage:janitor', 'dry-run']);
  assert.equal(evidence.status, 0, evidence.stderr);
  assert.equal(evidence.reportCount, 1);
  assert.equal(evidence.mode, 'dry-run');
  assert.deepEqual(evidence.errors, []);
  assert.deepEqual(evidence.logs, ['janitor.stderr.log', 'janitor.stdout.log']);
  assert.equal(evidence.footer, '[pentacle-janitor-run exit=0 signal=none at=*');
});

test('wrapper closes the stdout log when the stderr log cannot be opened', async () => {
  const home = temporary('janitor-logs-partial');
  const state = stateRoot(home);
  fs.mkdirSync(path.join(state, 'logs', 'janitor.stderr.log'), { recursive: true });
  const { run } = require('./storage-janitor-scheduled.cjs');
  const descriptors = () => fs.readdirSync('/dev/fd').length;
  const before = descriptors();
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try { assert.equal(await run({ state, command: process.execPath, args: ['-e', 'process.exit(0)'] }), 0); }
  finally { process.stderr.write = write; }
  assert.ok(descriptors() <= before, 'no descriptor outlives the failed open');
});
