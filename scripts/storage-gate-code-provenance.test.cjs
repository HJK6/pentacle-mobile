const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { requireEvidenceProvenance, requireGateCodeProvenance, requireMatchingGateCodeProvenance, requirePushedCommit } = require('./gate-code-provenance.cjs');

const STORAGE_GATE_SOURCE = fs.readFileSync(path.join(__dirname, 'storage-gate.cjs'), 'utf8');
const NATIVE_BUILDER_SOURCE = fs.readFileSync(path.join(__dirname, 'build-native-root.cjs'), 'utf8');

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

test('gate code provenance accepts only a clean pushed checkout', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-gate-code-provenance-'));
  const origin = path.join(tempRoot, 'origin.git');
  const checkout = path.join(tempRoot, 'checkout');
  execFileSync('git', ['init', '--bare', '--quiet', origin]);
  execFileSync('git', ['init', '--quiet', '-b', 'main', checkout]);
  fs.writeFileSync(path.join(checkout, 'gate.txt'), 'reviewed\n');
  git(checkout, ['add', 'gate.txt']);
  git(checkout, ['-c', 'user.name=Gate Test', '-c', 'user.email=gate@example.test', 'commit', '--quiet', '-m', 'gate']);
  git(checkout, ['remote', 'add', 'origin', origin]);
  git(checkout, ['push', '--quiet', '-u', 'origin', 'main']);

  const pushedSha = git(checkout, ['rev-parse', 'HEAD']);
  const recorded = {
    gate_code_sha: pushedSha,
    gate_code_tree_clean: true,
  };
  assert.deepEqual(requireGateCodeProvenance(checkout), recorded);
  assert.deepEqual(requireMatchingGateCodeProvenance(checkout, recorded), recorded);

  fs.appendFileSync(path.join(checkout, 'gate.txt'), 'dirty\n');
  assert.throws(() => requireGateCodeProvenance(checkout), /RUN_GATE_CODE_DIRTY/);
  fs.writeFileSync(path.join(checkout, 'gate.txt'), 'reviewed\n');
  fs.writeFileSync(path.join(checkout, 'local.txt'), 'unpushed\n');
  git(checkout, ['add', 'local.txt']);
  git(checkout, ['-c', 'user.name=Gate Test', '-c', 'user.email=gate@example.test', 'commit', '--quiet', '-m', 'local']);
  assert.throws(() => requireGateCodeProvenance(checkout), /RUN_GATE_CODE_UNPUSHED/);
  const localSha = git(checkout, ['rev-parse', 'HEAD']);
  assert.throws(() => requirePushedCommit(checkout, localSha), /RUN_CANDIDATE_UNPUSHED/);
  git(checkout, ['push', '--quiet', 'origin', 'main']);
  assert.throws(() => requireMatchingGateCodeProvenance(checkout, recorded), /RUN_GATE_CODE_PROVENANCE_DRIFT/);
  git(checkout, ['checkout', '--quiet', '--detach', pushedSha]);
  assert.deepEqual(requireGateCodeProvenance(checkout), recorded, 'a pushed ancestor remains valid gate code');
  assert.equal(requirePushedCommit(checkout, pushedSha), pushedSha, 'a pushed ancestor remains a valid candidate');
  git(checkout, ['push', '--quiet', 'origin', '--delete', 'main']);
  git(checkout, ['update-ref', 'refs/remotes/origin/main', localSha]);
  assert.throws(() => requireGateCodeProvenance(checkout), /RUN_GATE_CODE_UNPUSHED/, 'stale remote-tracking refs are not proof');
  assert.throws(() => requirePushedCommit(checkout, pushedSha), /RUN_CANDIDATE_UNPUSHED/);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('storage gate carries provenance through journal, child environment, and result', () => {
  assert.match(STORAGE_GATE_SOURCE, /const gateCodeProvenance = requireMatchingGateCodeProvenance\(repository,/);
  assert.match(STORAGE_GATE_SOURCE, /candidate_ref: candidateSha,\s+\.\.\.gateCodeProvenance,/);
  assert.ok(STORAGE_GATE_SOURCE.includes('requirePushedCommit(repository, candidateSha)'));
  for (const binding of [
    'PENTACLE_GATE_CANDIDATE_SHA: run.candidate_ref',
    'PENTACLE_GATE_CODE_SHA: run.gate_code_sha',
    'PENTACLE_GATE_CODE_TREE_CLEAN: String(run.gate_code_tree_clean)',
  ]) assert.ok(STORAGE_GATE_SOURCE.includes(binding), `missing child binding: ${binding}`);
  assert.match(STORAGE_GATE_SOURCE, /candidate_sha: run\.candidate_ref, gate_code_sha: run\.gate_code_sha/);
  assert.match(STORAGE_GATE_SOURCE, /verifyGateCodeProvenance: verifyGateCodeProvenanceDependency = requireMatchingGateCodeProvenance/);
  assert.equal((STORAGE_GATE_SOURCE.match(/verifyGateCodeProvenanceDependency\(gateBootstrap\.invokingRepository, run\)/g) || []).length, 2);
  assert.ok(STORAGE_GATE_SOURCE.includes("PENTACLE_GATE_CANONICAL_RUNNER: '1'"));
  assert.ok(STORAGE_GATE_SOURCE.includes('gateCodeSnapshots.requireSnapshot(id, gateCodeProvenance.gate_code_sha)'));
  assert.ok(STORAGE_GATE_SOURCE.includes("path.join(gateCodeRoot, 'scripts', 'storage-builder-worker.cjs')"));
  assert.ok(STORAGE_GATE_SOURCE.includes("path.join(gateCodeRoot, 'scripts', 'full-gate.cjs')"));
  assert.ok(STORAGE_GATE_SOURCE.includes("path.join(gateCodeRoot, 'scripts', 'report-viewer-sim-e2e.cjs')"));
  assert.doesNotMatch(STORAGE_GATE_SOURCE, /path\.join\(candidateRoot, 'scripts', 'full-gate\.cjs'\)/);
  assert.ok(NATIVE_BUILDER_SOURCE.includes("path.join(ROOT, 'scripts', 'full-gate.cjs')"));
});

test('evidence provenance is bound to the authoritative journal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-gate-evidence-provenance-'));
  const candidate = 'a'.repeat(40);
  const gateCode = 'b'.repeat(40);
  const recorded = { candidate_ref: candidate, gate_code_sha: gateCode, gate_code_tree_clean: true };
  const write = (summary = {}, native = {}) => {
    fs.writeFileSync(path.join(root, 'run.json'), JSON.stringify({
      sha: candidate, candidate_sha: candidate, gate_code_sha: gateCode, gate_code_tree_clean: true, ...summary,
    }));
    fs.writeFileSync(path.join(root, 'native-root.json'), JSON.stringify({ candidate_sha: candidate, ...native }));
  };
  write();
  assert.deepEqual(requireEvidenceProvenance(root, recorded), {
    candidate_sha: candidate, gate_code_sha: gateCode, gate_code_tree_clean: true,
  });
  for (const [summary, native] of [
    [{ candidate_sha: 'c'.repeat(40) }, {}],
    [{ gate_code_sha: 'c'.repeat(40) }, {}],
    [{ gate_code_tree_clean: false }, {}],
    [{}, { candidate_sha: 'c'.repeat(40) }],
  ]) {
    write(summary, native);
    assert.throws(() => requireEvidenceProvenance(root, recorded), /EVIDENCE_GATE_CODE_PROVENANCE_MISMATCH/);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('only a jointly legacy journal and evidence pair is grandfathered', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-gate-evidence-legacy-'));
  const candidate = 'a'.repeat(40);
  const write = (summary, native = { candidate_sha: candidate }) => {
    fs.writeFileSync(path.join(root, 'run.json'), JSON.stringify(summary));
    fs.writeFileSync(path.join(root, 'native-root.json'), JSON.stringify(native));
  };
  const legacy = { candidate_ref: candidate };
  write({ sha: candidate });
  assert.deepEqual(requireEvidenceProvenance(root, legacy), { candidate_sha: candidate, legacy: true });
  for (const [recorded, summary, native] of [
    [{ ...legacy, gate_code_sha: 'b'.repeat(40) }, { sha: candidate }, { candidate_sha: candidate }],
    [legacy, { sha: candidate, gate_code_sha: 'b'.repeat(40) }, { candidate_sha: candidate }],
    [legacy, { sha: 'c'.repeat(40) }, { candidate_sha: candidate }],
    [legacy, { sha: candidate }, { candidate_sha: 'c'.repeat(40) }],
  ]) {
    write(summary, native);
    assert.throws(() => requireEvidenceProvenance(root, recorded), /EVIDENCE_GATE_CODE_PROVENANCE_MISMATCH/);
  }
  fs.rmSync(root, { recursive: true, force: true });
});
