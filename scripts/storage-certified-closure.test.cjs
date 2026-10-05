const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

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
  'test/e2e/tests/test_run_scenario.py',
  'test/e2e/tests/test_native_capture.py',
  'test/testtime-jest-reporter.test.cjs',
];

function pythonTargets(root, relative, source) {
  const parsed = spawnSync('python3', ['-c', `import ast,json,sys
tree=ast.parse(sys.stdin.read())
imports=[]
for node in ast.walk(tree):
 if isinstance(node,ast.ImportFrom): imports.append({'module':node.module or '', 'level':node.level})
 elif isinstance(node,ast.Import): imports.extend({'module':item.name,'level':0} for item in node.names)
 # The public runner dispatches importlib from this explicit registry.
 elif isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='REPORT_MODULES' for t in node.targets) and isinstance(node.value,ast.Dict):
  imports.extend({'module':v.value,'level':0} for v in node.value.values if isinstance(v,ast.Constant) and isinstance(v.value,str))
print(json.dumps(imports))`], { input: source, encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  const targets = new Set();
  for (const item of JSON.parse(parsed.stdout)) {
    const base = item.level ? path.dirname(relative).split(path.sep).slice(0, -(item.level - 1) || undefined).join(path.sep)
      : item.module.startsWith('e2e.') ? 'test' : 'test/e2e';
    const target = path.join(base, ...item.module.split('.')) + '.py';
    const packageFile = path.join(base, ...item.module.split('.'), '__init__.py');
    const resolved = fs.existsSync(path.join(root, target)) ? target : fs.existsSync(path.join(root, packageFile)) ? packageFile : null;
    if (!resolved) continue; // Standard-library and installed dependencies are outside the repository.
    targets.add(resolved);
    let directory = path.dirname(resolved);
    while (directory.startsWith('test/e2e')) {
      const initializer = path.join(directory, '__init__.py');
      if (fs.existsSync(path.join(root, initializer))) targets.add(initializer);
      directory = path.dirname(directory);
    }
  }
  return [...targets];
}

function certifiedRequireClosure(root = ROOT, entries = CERTIFIED_ENTRIES) {
  const closure = new Set(entries);
  const pending = [...closure];
  while (pending.length) {
    const relative = pending.pop();
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    if (relative.endsWith('.py')) {
      const implicit = [];
      let directory = path.dirname(relative);
      while (directory.startsWith('test/e2e')) {
        for (const name of ['__init__.py', ...(relative.startsWith('test/e2e/tests/') ? ['conftest.py'] : [])]) {
          const target = path.join(directory, name);
          if (fs.existsSync(path.join(root, target))) implicit.push(target);
        }
        directory = path.dirname(directory);
      }
      for (const target of [...implicit, ...pythonTargets(root, relative, source)]) {
        if (!closure.has(target)) { closure.add(target); pending.push(target); }
      }
      continue;
    }
    if (!/\.c?js$/.test(relative)) continue;
    // The full-gate tests execute a pure selector extracted from this source, not
    // the storage module's top-level imports. Pin the file protecting the slice.
    if (/new Function\([\s\S]*source\.slice\(start, end\)/.test(source)) {
      for (const match of source.matchAll(/fs\.readFileSync\(path\.join\(__dirname, ['"]([^'"]+\.cjs)['"]\), ['"]utf8['"]\)/g)) {
        const target = path.join(path.dirname(relative), match[1]);
        const targetSource = fs.readFileSync(path.join(root, target), 'utf8');
        const start = targetSource.indexOf('function selectCompatibleSimulatorType');
        const end = targetSource.indexOf('\n}\n\nfunction createSimulator', start) + 2;
        assert.ok(start >= 0 && end > start, 'executed selector source must remain present');
        assert.doesNotMatch(targetSource.slice(start, end), /\brequire\s*\(|\bimport\b/, 'selector gained a local execution dependency');
        closure.add(target);
      }
    }
    // The tracked example is copied and then executed by the iOS export helper.
    for (const match of source.matchAll(/['"]([^'"/]+\.config\.example\.ts)['"]/g)) {
      const target = match[1];
      if (fs.existsSync(path.join(root, target)) && !closure.has(target)) { closure.add(target); pending.push(target); }
    }
    // These literal subprocess and fixture paths execute without a require().
    for (const match of source.matchAll(/['"]((?:test\/e2e|test\/fixtures|scripts)\/[^'"\n]+\.(?:py|cjs))['"]/g)) {
      const target = match[1];
      if (fs.existsSync(path.join(root, target)) && !closure.has(target)) { closure.add(target); pending.push(target); }
    }
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

test('closure follows Python relative imports, package initialization and explicit dynamic dispatch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-certified-python-'));
  try {
    fs.mkdirSync(path.join(root, 'test/e2e/scenarios'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test/e2e/entry.py'), "REPORT_MODULES={'case':'e2e.scenarios.case'}\n");
    fs.writeFileSync(path.join(root, 'test/e2e/scenarios/__init__.py'), '');
    fs.writeFileSync(path.join(root, 'test/e2e/scenarios/case.py'), 'from .helper import value\n');
    fs.writeFileSync(path.join(root, 'test/e2e/scenarios/helper.py'), 'value=True\n');
    assert.deepEqual(certifiedRequireClosure(root, ['test/e2e/entry.py']), ['test/e2e/entry.py', 'test/e2e/scenarios/__init__.py', 'test/e2e/scenarios/case.py', 'test/e2e/scenarios/helper.py']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('closure follows implicit pytest setup and its local imports', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-certified-pytest-'));
  try {
    fs.mkdirSync(path.join(root, 'test/e2e/tests'), { recursive: true });
    fs.mkdirSync(path.join(root, 'test/e2e/harness'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test/e2e/tests/test_case.py'), 'def test_case(): pass\n');
    fs.writeFileSync(path.join(root, 'test/e2e/tests/__init__.py'), '');
    fs.writeFileSync(path.join(root, 'test/e2e/tests/conftest.py'), 'from harness.fd_guard import guard\n');
    fs.writeFileSync(path.join(root, 'test/e2e/harness/fd_guard.py'), 'guard=True\n');
    assert.deepEqual(certifiedRequireClosure(root, ['test/e2e/tests/test_case.py']), [
      'test/e2e/harness/fd_guard.py', 'test/e2e/tests/__init__.py', 'test/e2e/tests/conftest.py', 'test/e2e/tests/test_case.py',
    ]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
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

test('every pinned executable dependency rejects both missing bytes and tampered bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-certified-negative-'));
  try {
    for (const relative of Object.keys(CERTIFIED_COMPONENTS)) {
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, relative), path.join(root, relative));
    }
    assert.doesNotThrow(() => verifyCertified(root), 'complete clean fixture must certify before negatives');
    for (const relative of Object.keys(CERTIFIED_COMPONENTS)) {
      const target = path.join(root, relative);
      const bytes = fs.readFileSync(target);
      fs.unlinkSync(target);
      assert.throws(() => verifyCertified(root), `${relative} missing must fail`);
      fs.writeFileSync(target, Buffer.concat([bytes, Buffer.from('\nmutation\n')]));
      assert.throws(() => verifyCertified(root), /CERTIFIED_COMPONENT_DRIFT/);
      fs.writeFileSync(target, bytes);
    }
    assert.doesNotThrow(() => verifyCertified(root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
