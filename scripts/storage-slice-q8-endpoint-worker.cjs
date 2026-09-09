'use strict';

const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [mode, root] = process.argv.slice(2);
const originalLoad = Module._load;
const id = '11111111-1111-4111-8111-111111111111';
let held = false;
let effects = 0;
const base = {
  schema: 1,
  id,
  revision: 4,
  generation: '33333333-3333-4333-8333-333333333333',
  owner: { host: os.hostname(), uid: process.getuid(), pid: 99999999 },
  candidate_ref: 'a'.repeat(40),
  scratch_image: `${id}.sparsebundle`,
  evidence_image: `${id}.sparsebundle`,
  lock_token_digest: 'b'.repeat(64),
  reserved_at: '2026-07-01T00:00:00.000Z',
  first_dead_at: '2026-07-01T00:00:00.000Z',
};
const record = mode === 'discard'
  ? { ...base, state: 'scratch_discarded', preliminary_audit_at: '2026-07-01T00:00:00.000Z', preliminary_evidence_digest: 'c'.repeat(64), published_at: '2026-07-01T00:00:00.000Z', gate_status: 0 }
  : { ...base, state: 'scratch_discarding' };

function effect(value = undefined) {
  if (!held) throw new Error('Q8_EFFECT_WITHOUT_CLAIM');
  effects += 1;
  return value;
}

const state = {
  listRecords: () => [record],
  readRecord: () => record,
  validateInstalledAuthority: () => true,
  bind: () => ({
    recoverAtomicTemps: () => [],
    replaceRecord: (_kind, _id, _revision, next) => effect(next),
    rotateTerminal: () => [],
    transitionRun: (_id, _revision, nextState) => effect({ ...record, state: nextState, revision: record.revision + 1 }),
    withRecordMutation: (_kind, _id, action) => {
      if (held) return action();
      held = true;
      try { return action(); } finally { held = false; }
    },
  }),
};
const containers = {
  imagePath: () => path.join(root, 'image'),
  requireSeal: () => effect(true),
  resolveMounted: () => effect(path.join(root, 'mount')),
  bind: () => ({
    attachExisting: () => effect(path.join(root, 'mount')),
    detachAndDiscard: () => effect(),
    detachRetain: () => effect(),
    recoverOrCreate: () => effect(path.join(root, 'mount')),
  }),
};
const gate = { bind: () => ({
  finalizeScratchDiscard: () => effect(),
  recoverDeadHostLock: () => effect(),
  requireSeal: () => effect(true),
  resolveMounted: () => effect(path.join(root, 'mount')),
  verifyPreliminaryEvidence: () => effect(true),
  verifyRetainedEvidence: () => effect(true),
}) };
const authority = { fixedLayout: () => ({ state: root }), generatedId: () => id };
const capability = { claim: () => Symbol('q8-endpoint'), bind: (_token, api) => api };
const worktrees = { DAY: 24 * 60 * 60 * 1000, creatorAlive: () => false, bind: () => ({ retireWorktree: () => effect() }) };

Module._load = function load(request, parent, isMain) {
  if (parent?.filename.endsWith('storage-janitor.cjs')) {
    if (request === './storage-capability.cjs') return capability;
    if (request === './storage-authority.cjs') return authority;
    if (request === './storage-state.cjs') return state;
    if (request === './storage-containers.cjs') return containers;
    if (request === './storage-gate.cjs') return gate;
    if (request === './storage-worktrees.cjs') return worktrees;
  }
  return originalLoad(request, parent, isMain);
};

try {
  fs.mkdirSync(root, { recursive: true });
  const janitor = require('./storage-janitor.cjs');
  const api = janitor.bind(Symbol('q8-endpoint'));
  const now = new Date('2026-07-30T00:00:00.000Z');
  if (process.env.Q8_DEBUG === '1') process.stderr.write(`${JSON.stringify(janitor.runDecision(record, now))}\n`);
  if (mode === 'discard') api.discardEvidence(id, now);
  else api.recoverRun(id, now);
  if (effects < 2 || held) throw new Error('Q8_ENDPOINT_EFFECTS');
} catch (error) {
  if (process.env.Q8_DEBUG === '1') process.stderr.write(`${error.message}\n`);
  process.exitCode = 17;
}
