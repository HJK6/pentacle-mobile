'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const mutationCapability = require('./storage-capability.cjs').claim();
const { fixedLayout } = require('./storage-authority.cjs');
const state = require('./storage-state.cjs');
const { replaceRecord, rotateTerminal } = state.bind(mutationCapability);
const { validateRecord } = state;

const id = '00000000-0000-4000-8000-000000000001';
const generation = '00000000-0000-4000-8000-000000000002';
const clock = '2026-07-17T00:00:00.000Z';
const later = '2026-07-17T00:00:01.000Z';
const identity = (canonical) => ({ canonical, device: '1', inode: '2', uid: process.getuid(), mode: 0o700 });

function reservedRun() {
  return { schema: 1, id, revision: 0, state: 'reserved', generation, owner: { host: 'hosta', uid: process.getuid(), pid: 42 }, candidate_ref: 'a'.repeat(40), scratch_image: `${id}.sparsebundle`, evidence_image: `${id}.sparsebundle`, lock_token_digest: 'b'.repeat(64), reserved_at: clock, first_dead_at: null };
}

function allocatedRun() {
  return { ...reservedRun(), state: 'allocated', scratch_seal: { object_id: id, image: identity('/fixed/scratch') }, evidence_seal: { object_id: id, image: identity('/fixed/evidence') }, device_set_identity: identity('/fixed/device-set'), allocated_at: later };
}

function publishedRun() {
  return {
    ...allocatedRun(), revision: 3, state: 'published', handoff_from_pid: 42,
    running_at: '2026-07-17T00:00:02.000Z', gate_status: 0,
    sealing_at: '2026-07-17T00:00:03.000Z', preliminary_audit_at: '2026-07-17T00:00:04.000Z',
    preliminary_evidence_digest: 'c'.repeat(64), published_at: '2026-07-17T00:00:05.000Z',
  };
}

test('known future-state authority fields are rejected in every predecessor model', () => {
  assert.throws(() => validateRecord('runs', { ...allocatedRun(), preliminary_audit_at: later, preliminary_evidence_digest: 'c'.repeat(64) }), /AUTHORITY_RECORD/);
  assert.throws(() => validateRecord('runs', { ...allocatedRun(), published_at: later }), /AUTHORITY_RECORD_STATE_FIELD/);
  assert.throws(() => validateRecord('tickets', { schema: 1, id, revision: 0, state: 'registered', generation, main_repo_id: 'pentacle-mobile', spec_id: 'spec_x', lane_id: 'pentacle-mobile__x', branch: 'fix/x', upstream: 'origin/fix/x', head: 'a'.repeat(40), source_digest: 'b'.repeat(64), basename: 'pentacle-mobile__x', device: '1', inode: '2', registered_at: clock, creator: { host: 'hosta', uid: process.getuid(), pid: 42 }, deleted_at: later }), /AUTHORITY_RECORD/);
  assert.throws(() => validateRecord('scheduler', { schema: 1, id, revision: 0, state: 'absent', generation, action: 'install', prior_owned: false, prior_content: null, prior_loaded: false, created_at: clock, candidate_digest: 'c'.repeat(64) }), /AUTHORITY_RECORD/);
});

test('disposition authority and its evidence digest are all-or-nothing', () => {
  const disposed = { ...allocatedRun(), evidence_digest: 'c'.repeat(64), unclassified_disposed_at: later, disposition_reason: 'operator reviewed evidence' };
  const discarding = { ...disposed, state: 'scratch_discarding', scratch_discard_started_at: '2026-07-17T00:00:02.000Z' };
  for (const record of [disposed, discarding]) {
    assert.equal(validateRecord('runs', record), true);
    assert.throws(() => validateRecord('runs', { ...record, evidence_digest: undefined }), /AUTHORITY_RECORD_RUN/);
    assert.throws(() => validateRecord('runs', { ...record, evidence_digest: 'bad' }), /AUTHORITY_RECORD_RUN/);
  }
});

test('record clocks must be causal and cannot move before their predecessor', () => {
  assert.throws(() => validateRecord('runs', { ...allocatedRun(), reserved_at: later, allocated_at: clock }), /AUTHORITY_RECORD/);
});

test('an observed publication clock is immutable in the authority journal', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'storage-q1-clock-')));
  const prior = process.env.HOME;
  process.env.HOME = home;
  try {
    const directory = path.join(fixedLayout().state, 'runs');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const current = publishedRun();
    fs.writeFileSync(path.join(directory, `${id}.json`), `${JSON.stringify(current)}\n`);
    assert.throws(() => replaceRecord('runs', id, current.revision, {
      ...current,
      revision: current.revision + 1,
      published_at: '2026-07-17T00:00:06.000Z',
    }), /AUTHORITY_IMMUTABLE_FIELD:published_at/);
  } finally {
    process.env.HOME = prior;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('terminal rotation rejects rather than deleting a nonterminal record with deleted_at', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'storage-q1-rotation-')));
  const prior = process.env.HOME;
  process.env.HOME = home;
  try {
    const directory = path.join(fixedLayout().state, 'runs');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, `${id}.json`);
    fs.writeFileSync(target, JSON.stringify({ ...reservedRun(), deleted_at: clock }));
    assert.throws(() => rotateTerminal('runs', Date.parse(clock) + 31 * 86400000), /AUTHORITY_RECORD/);
    assert.equal(fs.existsSync(target), true);
  } finally {
    process.env.HOME = prior;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('terminal rotation removes only the oldest eligible record at the literal 120-record bound', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'storage-q1-count-')));
  const prior = process.env.HOME;
  process.env.HOME = home;
  try {
    const directory = path.join(fixedLayout().state, 'tickets');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const ticket = (ticketId, stateName, deletedAt = undefined) => ({
      schema: 1, id: ticketId, revision: stateName === 'removed' ? 3 : 0, state: stateName, generation,
      main_repo_id: 'pentacle-mobile', spec_id: 'spec_rotation', lane_id: 'rotation-lane',
      branch: 'fix/rotation', upstream: 'origin/fix/rotation', head: 'a'.repeat(40),
      source_digest: 'b'.repeat(64), basename: 'rotation-lane', device: '1', inode: '2',
      registered_at: '2026-07-01T00:00:00.000Z', creator: { host: 'hosta', uid: process.getuid(), pid: 42 },
      ...(stateName === 'removed' ? {
        eligible_at: '2026-07-01T00:00:01.000Z', removing_at: '2026-07-01T00:00:02.000Z', deleted_at: deletedAt,
      } : {}),
    });
    const terminalIds = [];
    for (let index = 0; index < 120; index += 1) {
      const ticketId = `00000000-0000-4000-8000-${String(1000 + index).padStart(12, '0')}`;
      terminalIds.push(ticketId);
      const deletedAt = new Date(Date.parse('2026-07-02T00:00:00.000Z') + index).toISOString();
      fs.writeFileSync(path.join(directory, `${ticketId}.json`), `${JSON.stringify(ticket(ticketId, 'removed', deletedAt))}\n`);
    }
    const protectedId = '00000000-0000-4000-8000-000000009999';
    fs.writeFileSync(path.join(directory, `${protectedId}.json`), `${JSON.stringify(ticket(protectedId, 'registered'))}\n`);

    assert.deepEqual(rotateTerminal('tickets', Date.parse('2026-07-17T00:00:00.000Z')), [terminalIds[0]]);
    assert.equal(fs.readdirSync(directory).filter((name) => name.endsWith('.json')).length, 120);
    assert.equal(fs.existsSync(path.join(directory, `${terminalIds[0]}.json`)), false);
    assert.equal(fs.existsSync(path.join(directory, `${terminalIds[1]}.json`)), true);
    assert.equal(fs.existsSync(path.join(directory, `${protectedId}.json`)), true);
  } finally {
    process.env.HOME = prior;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
