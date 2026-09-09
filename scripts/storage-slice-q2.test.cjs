'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseFrontmatter, sourceDigest } = require('./storage-worktrees.cjs');

const baseSource = {
  status: 'completed', folder_name: 'pentacle-mobile__x', folder_identity: { canonical: '/memory/work/completed/pentacle-mobile__x', device: '1', inode: '2', uid: process.getuid(), mode: 0o700 },
  spec: { id: 'spec_x', status: 'completed', machine: 'hosta', owner: 'lead', branch: 'fix/x' }, summary: { id: 'work_x', status: 'completed', machine: 'hosta', owner: 'lead', branch: 'fix/x' },
  spec_source: { digest: 'a'.repeat(64), identity: { canonical: '/memory/spec.md', device: '1', inode: '3', uid: process.getuid(), mode: 0o600 }, size: 10 },
  summary_source: { digest: 'b'.repeat(64), identity: { canonical: '/memory/summary.md', device: '1', inode: '4', uid: process.getuid(), mode: 0o600 }, size: 10 },
};
const authority = { main_repo_id: 'pentacle-mobile', spec_id: 'spec_x', lane_id: 'pentacle-mobile__x', branch: 'fix/x', upstream: 'origin/fix/x', head: 'c'.repeat(40), generation: '00000000-0000-4000-8000-000000000001', creator: { host: 'hosta', uid: process.getuid(), pid: 42 }, device: '5', inode: '6' };

test('source digest binds exact sidecars, identity, machine, owner, branch, and ticket authority', () => {
  const baseline = sourceDigest(baseSource, authority);
  for (const changed of [
    { ...baseSource, spec: { ...baseSource.spec, owner: 'other' } },
    { ...baseSource, spec: { ...baseSource.spec, machine: 'other' } },
    { ...baseSource, spec_source: { ...baseSource.spec_source, digest: 'd'.repeat(64) } },
    { ...baseSource, folder_identity: { ...baseSource.folder_identity, inode: '9' } },
  ]) assert.notEqual(sourceDigest(changed, authority), baseline);
  assert.throws(() => sourceDigest(baseSource, { ...authority, branch: 'fix/other' }), /SOURCE_TICKET_BINDING/);
});

test('frontmatter parser rejects hidden indented and malformed list content', () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'storage-q2-yaml-')));
  const target = path.join(directory, 'spec.md');
  try {
    fs.writeFileSync(target, `---\nid: spec_x\ntitle: x\ntype: spec\nstatus: completed\ncanonical: false\ncreated_at: '2026-07-17'\nupdated_at: '2026-07-17'\nsource_path: work/completed/x/spec.md\nmachine: hosta\nowner: lead\ntags:\n- safe\n  injected: value\nsummary: x\nrelated: []\n---\n`);
    assert.throws(() => parseFrontmatter(target), /SOURCE_FRONTMATTER/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

function worker(mode) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `storage-q2-${mode}-`)));
  try {
    return JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'storage-worktree-q2-worker.cjs'), mode], { cwd: __dirname, env: { ...process.env, HOME: home }, encoding: 'utf8' }));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test('registration rejects role-invalid sidecars and nonterminal owners', () => {
  assert.equal(worker('invalid-type').registration_blocked, true);
  assert.equal(worker('nonterminal-register').registration_blocked, true);
});

test('unrelated terminal folder and declared branch cannot authorize the ticket lane', () => {
  const folder = worker('mismatch-folder');
  const branch = worker('mismatch-branch');
  assert.equal(folder.registration_blocked, true);
  assert.equal(branch.registration_blocked, true);
});

test('terminal authority requires the summary branch field', () => {
  assert.equal(worker('missing-summary-branch').registration_blocked, true);
});

test('real nonterminal source references block with the exact authority reason', () => {
  const result = worker('reference');
  assert.equal(result.blocked, true);
  assert.equal(result.retained, true);
  assert.equal(result.state, 'registered', 'source proof refuses before any removal transition');
  assert.match(result.reason, /SOURCE_NONTERMINAL_REFERENCE/);
});

test('final retirement proof holds all Git locks through non-force removal', () => {
  const result = worker('race');
  assert.equal(result.blocked, true);
  assert.equal(result.retained, true);
  assert.equal(result.state, 'blocked');
  assert.deepEqual(result.locks, [true, true, true]);
  assert.equal(result.no_force, true);
});

test('a nonterminal reference inserted at the removal boundary retains the tree', () => {
  const result = worker('source-drift');
  assert.equal(result.blocked, true);
  assert.equal(result.retained, true);
  assert.equal(result.state, 'blocked');
  assert.match(result.reason, /SOURCE_NONTERMINAL_REFERENCE/);
});

test('safe exact-authority control removes successfully without force', () => {
  const result = worker('safe');
  assert.equal(result.blocked, false);
  assert.equal(result.retained, false);
  assert.equal(result.state, 'removed');
  assert.deepEqual(result.locks, [true, true, true]);
  assert.equal(result.no_force, true);
});
