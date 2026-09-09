const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const { CERTIFIED_COMPONENTS } = require('./storage-authority.cjs');
const { verifyCertified } = require('./storage-gate.cjs');
const CERTIFIED_ENTRIES = [
  'scripts/full-gate.cjs',
  'scripts/full-gate.test.cjs',
  'scripts/report-viewer-sim-e2e.cjs',
  'scripts/report-viewer-sim-e2e.test.cjs',
  'test/e2e/recorder_preflight.py',
  'test/e2e/tests/test_recorder_preflight.py',
  'scripts/wire-contract-sim-e2e.cjs',
  'scripts/wire-contract-sim-e2e.test.cjs',
];

function certifiedRequireClosure(root = ROOT, entries = CERTIFIED_ENTRIES) {
  const closure = new Set(entries);
  const pending = [...closure];
  while (pending.length) {
    const relative = pending.pop();
    if (!/\.c?js$/.test(relative)) continue;
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    for (const match of source.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
      let target = path.normalize(path.join(path.dirname(relative), match[1]));
      if (!path.extname(target)) target += '.cjs';
      if (!fs.existsSync(path.join(root, target)) || closure.has(target)) continue;
      closure.add(target);
      pending.push(target);
    }
    for (const match of source.matchAll(/require\.resolve\(['"](\.[^'"]+)['"]\)/g)) {
      let target = path.normalize(path.join(path.dirname(relative), match[1]));
      if (!path.extname(target)) target += '.cjs';
      if (!fs.existsSync(path.join(root, target)) || closure.has(target)) continue;
      closure.add(target);
      pending.push(target);
    }
    for (const match of source.matchAll(/const (\w+) = [^\n;]*\|\| ['"](\.[^'"]+)['"]/g)) {
      if (!new RegExp(`require\\(${match[1]}\\)`).test(source)) continue;
      let target = path.normalize(path.join(path.dirname(relative), match[2]));
      if (!path.extname(target)) target += '.cjs';
      if (!fs.existsSync(path.join(root, target)) || closure.has(target)) continue;
      closure.add(target);
      pending.push(target);
    }
    for (const match of source.matchAll(/require\(path\.join\((?:ROOT|CODE_ROOT|nativeRoot),\s*'([^']+)',\s*'([^']+)'\)\)/g)) {
      const target = path.join(match[1], match[2]);
      if (closure.has(target)) continue;
      closure.add(target);
      pending.push(target);
    }
  }
  return [...closure].sort();
}

test('certification pins the complete repository-local require closure', () => {
  assert.deepEqual(Object.keys(CERTIFIED_COMPONENTS).sort(), certifiedRequireClosure());
});

test('closure traversal follows repository-local imports from JavaScript entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-certified-js-closure-'));
  fs.writeFileSync(path.join(root, 'entry.js'), "module.exports = require('./helper.cjs');\n");
  fs.writeFileSync(path.join(root, 'helper.cjs'), 'module.exports = true;\n');
  assert.deepEqual(certifiedRequireClosure(root, ['entry.js']), ['entry.js', 'helper.cjs']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('editing any imported gate module fails certification', () => {
  const imported = [
    'plugins/withHarnessLaunchUrl.js',
    'scripts/gate-code-provenance.cjs',
    'scripts/sim-resource-guard.cjs',
    'scripts/sim-substrate.cjs',
    'test/testtime-jest-reporter.cjs',
  ];
  for (const relative of imported) assert.ok(CERTIFIED_COMPONENTS[relative], `${relative} must be pinned`);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-certified-closure-'));
  for (const relative of Object.keys(CERTIFIED_COMPONENTS)) {
    const target = path.join(tempRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), target);
  }
  assert.doesNotThrow(() => verifyCertified(tempRoot));
  for (const relative of imported) {
    fs.appendFileSync(path.join(tempRoot, relative), '\n// drift\n');
    assert.throws(() => verifyCertified(tempRoot), new RegExp(`CERTIFIED_COMPONENT_DRIFT:${relative.replaceAll('.', '\\.')}`));
    fs.copyFileSync(path.join(ROOT, relative), path.join(tempRoot, relative));
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
