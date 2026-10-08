'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { REQUIRED_TOOLS, canonicalChildEnvironment, probeChildEnvironment } = require('./certified-launch-environment.cjs');

// Real owned-process probes against stub executables on a stripped PATH: no host tool, companion,
// simulator or network is touched. Each stub appends its invocation to a log so starts are observable.
const dirs = [];
test.after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

function host({ omit = [], idbShebang = '#!/usr/bin/env python3', interpreters = { python3: 'good' } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'certified-env-test-'));
  dirs.push(root);
  const bin = path.join(root, 'bin');
  const site = path.join(root, 'site');
  const log = path.join(root, 'invocations.log');
  fs.mkdirSync(bin); fs.mkdirSync(path.join(site, 'idb'), { recursive: true });
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\n${body}\n`, { mode: 0o755 });
  for (const name of REQUIRED_TOOLS) if (!omit.includes(name) && name !== 'idb') stub(name, 'exit 0');
  if (!omit.includes('idb')) fs.writeFileSync(path.join(bin, 'idb'), `${idbShebang}\nprint("idb")\n`, { mode: 0o755 });
  // A python whose import of idb succeeds only under the gate's wiring: redirected HOME plus host user
  // site first on PYTHONPATH. 'no-import' resolves the site but cannot import.
  for (const [name, mode] of Object.entries(interpreters)) {
    stub(name, `case "$2" in
  *getusersitepackages*) printf '"%s"\\n' '${site}'; exit 0;;
  *"import idb"*) ${mode === 'no-import' ? 'exit 1' : `case "$PYTHONPATH" in '${site}'*) ;; *) exit 1;; esac; case "$HOME" in *pentacle-certified-probe-home-*-absent) exit 0;; esac; exit 1`};;
esac
exit 1`);
  }
  return { root, bin, site, log, environment: { PATH: bin, HOME: os.homedir(), PYTHONPATH: '/host/existing' },
    invocations: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) };
}

test('canonical environment prefixes the supported PATH and strips caller-steered values without mutating input', () => {
  const inherited = { PATH: '/custom/bin:/usr/bin', npm_config_cache: '/tmp/cache', PENTACLE_GATE_QUIET_RECEIPT: '/stale/receipt.json',
    PENTACLE_OWNED_GROUP_RECEIPT: '/stale/owner.json', KEEP: '1' };
  const snapshot = JSON.stringify(inherited);
  const environment = canonicalChildEnvironment('/repo', inherited, '/Users/someone', '/opt/node/bin/node');
  assert.equal(JSON.stringify(inherited), snapshot);
  assert.deepEqual(environment.PATH.split(':'), ['/Users/someone/.local/bin', '/repo/node_modules/.bin', '/opt/node/bin',
    '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/custom/bin']);
  for (const name of ['npm_config_cache', 'PENTACLE_GATE_QUIET_RECEIPT', 'PENTACLE_OWNED_GROUP_RECEIPT']) assert.equal(name in environment, false, name);
  assert.equal(environment.KEEP, '1');
});

test('probe passes under the gate wiring, records digests only, and leaves the environment unchanged', () => {
  const h = host();
  const before = JSON.stringify(h.environment);
  const result = probeChildEnvironment(h.root, h.environment);
  assert.equal(JSON.stringify(h.environment), before);
  assert.deepEqual(result.commands.map(command => command.probe), ['node', 'npm', 'git', 'pod', 'ruby', 'xcode-version', 'simulator-sdk', 'sim-queue', 'idb-user-site', 'idb-import-redirected-home']);
  assert.ok(result.commands.every(command => command.status === 0 && command.group_alive_after === false));
  assert.ok(!JSON.stringify(result).includes(h.root), 'fingerprint must not carry host paths');
  assert.ok(!fs.readdirSync(os.tmpdir()).some(name => /^pentacle-certified-probe-home-/.test(name)), 'probe HOME is never created');
});

test('a missing tool refuses before any probe starts', () => {
  const h = host({ omit: ['idb_companion'] });
  assert.throws(() => probeChildEnvironment(h.root, h.environment), /^Error: CERTIFIED_LAUNCH_DEPENDENCY_MISSING:idb_companion$/);
  assert.deepEqual(h.invocations(), []);
});

test('an idb import that fails under redirected HOME refuses as a dependency import failure', () => {
  const h = host({ interpreters: { python3: 'no-import' } });
  assert.throws(() => probeChildEnvironment(h.root, h.environment), /^Error: CERTIFIED_LAUNCH_DEPENDENCY_IMPORT:idb$/);
});

test('a user site without the idb package refuses', () => {
  const h = host();
  fs.rmSync(path.join(h.site, 'idb'), { recursive: true });
  assert.throws(() => probeChildEnvironment(h.root, h.environment), /^Error: CERTIFIED_LAUNCH_DEPENDENCY_IMPORT:idb$/);
});

test('the probe uses the interpreter named by idb, not the first python3 on PATH', () => {
  const h = host({ idbShebang: '#!/usr/bin/env python3.12', interpreters: { python3: 'no-import', 'python3.12': 'good' } });
  probeChildEnvironment(h.root, h.environment);
  assert.ok(h.invocations().some(line => line.startsWith('python3.12 -c import idb')));
  assert.ok(!h.invocations().some(line => line.startsWith('python3 ')));
  const absent = host({ idbShebang: '#!/usr/bin/env python3.99' });
  assert.throws(() => probeChildEnvironment(absent.root, absent.environment), /^Error: CERTIFIED_LAUNCH_DEPENDENCY_MISSING:python3.99$/);
});

test('a failing tool probe refuses with its label', () => {
  const h = host();
  fs.writeFileSync(path.join(h.bin, 'sim-queue'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  assert.throws(() => probeChildEnvironment(h.root, h.environment), /^Error: CERTIFIED_LAUNCH_DEPENDENCY_PROBE:sim-queue$/);
});
