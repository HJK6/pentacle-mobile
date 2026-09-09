'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`RUN_GATE_CODE_GIT_FAILED:${args.join(' ')}`);
  }
  return result.stdout.trim();
}

function tryGit(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function requirePushedCommit(root, sha, code = 'RUN_CANDIDATE_UNPUSHED') {
  if (!/^[0-9a-f]{40}$/.test(sha || '')) throw new Error(`${code}: invalid commit`);
  if (tryGit(root, ['cat-file', '-e', `${sha}^{commit}`]).status !== 0
      || git(root, ['cat-file', '-t', sha]) !== 'commit') {
    throw new Error(`${code}: invalid commit`);
  }
  const advertised = [...new Set(git(root, ['ls-remote', '--heads', '--tags', 'origin'])
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t', 1)[0]))];
  if (advertised.includes(sha)) return sha;
  const missing = advertised.filter((tip) => tryGit(root, ['cat-file', '-e', `${tip}^{commit}`]).status !== 0);
  if (missing.length) {
    git(root, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', 'origin', ...missing]);
  }
  const contained = advertised.some((tip) => tryGit(root, ['merge-base', '--is-ancestor', sha, `${tip}^{commit}`]).status === 0);
  if (!contained) throw new Error(`${code}: commit must be pushed`);
  return sha;
}

function requireGateCodeProvenance(root) {
  const gateCodeSha = git(root, ['rev-parse', 'HEAD']);
  if (git(root, ['status', '--porcelain=v1', '--untracked-files=all'])) {
    throw new Error('RUN_GATE_CODE_DIRTY: gate checkout must be clean');
  }
  try { requirePushedCommit(root, gateCodeSha, 'RUN_GATE_CODE_UNPUSHED'); }
  catch (error) { throw new Error(`${error.message}: gate checkout must be pushed`); }
  return { gate_code_sha: gateCodeSha, gate_code_tree_clean: true };
}

function requireMatchingGateCodeProvenance(root, recorded) {
  const current = requireGateCodeProvenance(root);
  if (recorded?.gate_code_sha !== current.gate_code_sha || recorded?.gate_code_tree_clean !== true) {
    throw new Error('RUN_GATE_CODE_PROVENANCE_DRIFT');
  }
  return current;
}

function requireEvidenceProvenance(root, recorded) {
  const summary = JSON.parse(fs.readFileSync(path.join(root, 'run.json'), 'utf8'));
  const native = JSON.parse(fs.readFileSync(path.join(root, 'native-root.json'), 'utf8'));
  const candidateSha = recorded?.candidate_ref;
  const gateCodeSha = recorded?.gate_code_sha;
  const journalLegacy = gateCodeSha === undefined && recorded?.gate_code_tree_clean === undefined;
  const evidenceLegacy = summary.candidate_sha === undefined
    && summary.gate_code_sha === undefined
    && summary.gate_code_tree_clean === undefined;
  if (journalLegacy || evidenceLegacy) {
    if (!journalLegacy || !evidenceLegacy || !/^[0-9a-f]{40}$/.test(candidateSha || '') || summary.sha !== candidateSha || native.candidate_sha !== candidateSha) {
      throw new Error('EVIDENCE_GATE_CODE_PROVENANCE_MISMATCH');
    }
    return { candidate_sha: candidateSha, legacy: true };
  }
  if (
    !/^[0-9a-f]{40}$/.test(candidateSha || '')
    || !/^[0-9a-f]{40}$/.test(gateCodeSha || '')
    || recorded.gate_code_tree_clean !== true
    || summary.sha !== candidateSha
    || summary.candidate_sha !== candidateSha
    || summary.gate_code_sha !== gateCodeSha
    || summary.gate_code_tree_clean !== true
    || native.candidate_sha !== candidateSha
  ) throw new Error('EVIDENCE_GATE_CODE_PROVENANCE_MISMATCH');
  return { candidate_sha: candidateSha, gate_code_sha: gateCodeSha, gate_code_tree_clean: true };
}

module.exports = { requireEvidenceProvenance, requireGateCodeProvenance, requireMatchingGateCodeProvenance, requirePushedCommit };
