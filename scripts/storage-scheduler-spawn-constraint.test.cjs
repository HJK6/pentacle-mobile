'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { after, test } = require('node:test');
const scheduler = require('./storage-scheduler.cjs');
const { SPAWN_CONSTRAINT_BLOCK } = require('./storage-launchctl-print-fixture.cjs');

const darwin = process.platform === 'darwin';
const NATIVE = darwin && process.env.PENTACLE_LAUNCHD_PROOF === '1';
const roots = [];
const temporary = (prefix) => { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))); roots.push(root); return root; };
after(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const cdhashOf = (executable) => /^CDHash=([0-9a-f]{40})$/m.exec(spawnSync('/usr/bin/codesign', ['-dvvv', executable], { encoding: 'utf8' }).stderr)[1];
const lint = (file) => execFileSync('/usr/bin/plutil', ['-lint', file], { encoding: 'utf8' });
const extract = (file, keyPath) => execFileSync('/usr/bin/plutil', ['-extract', keyPath, 'raw', '-o', '-', file], { encoding: 'utf8' }).trim();

test('the rendered plist lints, pins exactly the executing node CDHash and is byte-stable', { skip: !darwin }, () => {
  const text = scheduler.renderPlist();
  assert.equal(scheduler.renderPlist(), text);
  assert.equal(text.split('<key>SpawnConstraint</key>').length - 1, 1);
  const file = path.join(temporary('sc-render'), 'candidate.plist');
  fs.writeFileSync(file, text);
  assert.match(lint(file), /: OK\n$/);
  assert.equal(extract(file, 'SpawnConstraint.cdhash.$in'), '1', 'exactly one allowed CDHash');
  assert.equal(Buffer.from(extract(file, 'SpawnConstraint.cdhash.$in.0'), 'base64').toString('hex'), cdhashOf(process.execPath));
  assert.deepEqual(Object.keys(JSON.parse(execFileSync('/usr/bin/plutil', ['-extract', 'SpawnConstraint', 'json', '-o', '-', '-'], { input: text.replace(/<data>[^<]*<\/data>/, '<string>x</string>'), encoding: 'utf8' }))), ['cdhash']);
  assert.equal(extract(file, 'StartInterval'), '21600');
  assert.equal(extract(file, 'RunAtLoad'), 'false');
});

// Each fault is injected at the child-process boundary of a separate process so the real renderPlist runs.
const FAULTS = {
  'codesign display failure': ['display', /UNAVAILABLE:CODESIGN_DISPLAY/],
  'no CDHash line': ['none', /UNAVAILABLE:CDHASH_CARDINALITY/],
  'two CDHash lines': ['two', /UNAVAILABLE:CDHASH_CARDINALITY/],
  'non-hex CDHash': ['nothex', /UNAVAILABLE:CDHASH_CARDINALITY/],
  'short CDHash': ['short', /UNAVAILABLE:CDHASH_CARDINALITY/],
  'requirement verification failure': ['verify', /UNAVAILABLE:CODESIGN_VERIFY/],
  'relative executable path': ['relative', /UNAVAILABLE:EXECUTABLE_PATH/],
  'missing executable': ['missing', /UNAVAILABLE:EXECUTABLE_MISSING/],
};
const PRELOAD = `
const cp = require('node:child_process');
const real = cp.spawnSync;
const fault = process.env.SC_FAULT;
if (fault === 'relative') Object.defineProperty(process, 'execPath', { value: 'node' });
if (fault === 'missing') Object.defineProperty(process, 'execPath', { value: '/nonexistent/pentacle/node' });
cp.spawnSync = (binary, args, options) => {
  if (binary !== '/usr/bin/codesign') return real(binary, args, options);
  const shown = args[0] === '-dvvv';
  if (fault === 'display' && shown) return { status: 1, stdout: '', stderr: 'forced' };
  if (fault === 'verify' && !shown) return { status: 3, stdout: '', stderr: 'forced' };
  if (!shown) return real(binary, args, options);
  const result = real(binary, args, options);
  const line = /^CDHash=.*$/m.exec(result.stderr)[0];
  if (fault === 'none') return { ...result, stderr: result.stderr.replace(line, '') };
  if (fault === 'two') return { ...result, stderr: result.stderr + line + '\\n' };
  if (fault === 'nothex') return { ...result, stderr: result.stderr.replace(line, 'CDHash=' + 'z'.repeat(40)) };
  if (fault === 'short') return { ...result, stderr: result.stderr.replace(line, 'CDHash=' + 'a'.repeat(39)) };
  return result;
};`;
for (const [name, [fault, expected]] of Object.entries(FAULTS)) {
  test(`renderPlist fails closed: ${name}`, { skip: !darwin }, () => {
    const dir = temporary('sc-fault');
    fs.writeFileSync(path.join(dir, 'preload.cjs'), PRELOAD);
    const result = spawnSync(process.execPath, ['--require', path.join(dir, 'preload.cjs'), '-e', `require(${JSON.stringify(path.join(__dirname, 'storage-scheduler.cjs'))}).renderPlist()`], { env: { ...process.env, SC_FAULT: fault }, encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'no plist is produced');
    assert.match(result.stderr, expected);
  });
}

// Native proofs on real launchd with disposable labels only (never the installed label). Opt in with PENTACLE_LAUNCHD_PROOF=1.
function disposable(prefix, build) {
  const label = `com.pentacle.mobile.lwcrproof.${prefix}.${crypto.randomBytes(3).toString('hex')}`;
  const file = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  const uid = process.getuid();
  const launchctl = (...args) => spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  fs.writeFileSync(file, build(label), { mode: 0o600 });
  return {
    label, file,
    bootstrap: () => { const result = launchctl('bootstrap', `gui/${uid}`, file); assert.equal(result.status, 0, result.stderr); },
    print: () => launchctl('print', `gui/${uid}/${label}`).stdout,
    kick: () => { assert.equal(launchctl('kickstart', '-k', `gui/${uid}/${label}`).status, 0); },
    cleanup: () => { launchctl('bootout', `gui/${uid}/${label}`); fs.rmSync(file, { force: true }); assert.equal(launchctl('print', `gui/${uid}/${label}`).status, 113, 'disposable label absent'); },
  };
}
const waitFor = (predicate, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (predicate()) return true; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); } return predicate(); };

test('real launchd: the exact rendered plist loads, prints the fixture-shaped constraint and is not spawned', { skip: !NATIVE }, () => {
  const marker = path.join(temporary('sc-native'), 'ran');
  const job = disposable('render', (label) => scheduler.renderPlist().replace(`<string>${scheduler.LABEL}</string>`, `<string>${label}</string>`));
  try {
    job.bootstrap();
    const printed = job.print();
    assert.ok(printed.includes(`\n${SPAWN_CONSTRAINT_BLOCK}\n`), 'launchd prints exactly the fixture block');
    assert.match(printed, /^\tproperties = .*\bhas spawn constraint\b/m);
    assert.match(printed, /^\truns = 0$/m);
    assert.equal(fs.existsSync(marker), false);
  } finally { job.cleanup(); }
});

for (const [name, mutate, runs] of [['the pinned cdhash runs', (hex) => hex, true], ['a different cdhash is refused at spawn', (hex) => `${hex[0] === '0' ? '1' : '0'}${hex.slice(1)}`, false]]) {
  test(`real launchd: the rendered SpawnConstraint element, ${name}`, { skip: !NATIVE }, () => {
    const marker = path.join(temporary('sc-native'), 'ran');
    const pinned = cdhashOf(process.execPath);
    const constraint = /<key>SpawnConstraint<\/key>.*?<\/array><\/dict><\/dict>/.exec(scheduler.renderPlist())[0].replace(/<data>[^<]*<\/data>/, `<data>${Buffer.from(mutate(pinned), 'hex').toString('base64')}</data>`);
    const job = disposable(runs ? 'good' : 'bad', (label) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${process.execPath}</string><string>-e</string><string>require('fs').writeFileSync(${JSON.stringify(marker)},'ran')</string></array><key>StartInterval</key><integer>21600</integer><key>RunAtLoad</key><false/><key>ProcessType</key><string>Background</string>${constraint}</dict></plist>\n`);
    try {
      job.bootstrap();
      assert.match(job.print(), /\bhas spawn constraint\b/);
      job.kick();
      if (runs) { assert.ok(waitFor(() => fs.existsSync(marker)), 'job ran'); assert.match(job.print(), /^\tlast exit code = 0$/m); }
      else { assert.ok(waitFor(() => /OS_REASON_CODESIGNING/.test(job.print()))); assert.equal(fs.existsSync(marker), false, 'job never ran'); }
    } finally { job.cleanup(); }
  });
}

test('the detached-generation retirement readers extract the checked keys from the constrained plist with real plutil', { skip: !darwin }, () => {
  const text = scheduler.renderPlist();
  const field = (key, format) => execFileSync('/usr/bin/plutil', ['-extract', key, format, '-o', '-', '--', '-'], { input: text, encoding: 'utf8' });
  assert.equal(field('Label', 'raw').replace(/\n$/, ''), scheduler.LABEL);
  assert.equal(field('WorkingDirectory', 'raw').replace(/\n$/, ''), path.resolve(__dirname, '..'));
  assert.deepEqual(JSON.parse(field('ProgramArguments', 'json')), [process.execPath, path.join(__dirname, 'storage-janitor-scheduled.cjs'), 'storage:janitor', 'dry-run']);
  // The whole-document conversion the readers used to run is exactly what real plutil refuses on <data>.
  assert.throws(() => execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], { input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
});
