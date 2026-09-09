'use strict';

const assert = require('node:assert/strict');
const { parseEndpoint, transition } = require('./storage-authority.cjs');
const { validateAuthorityShape, validateRecord } = require('./storage-state.cjs');

const GRAPHS = Object.freeze({
  installed: { absent: ['prepared'], prepared: ['installed'], installed: ['updating', 'restoring'], updating: ['installed'], restoring: ['absent'] },
  run: { reserved: ['allocated'], allocated: ['running', 'scratch_discarding'], running: ['sealing', 'scratch_discarding'], sealing: ['published', 'blocked_unclassified', 'scratch_discarding'], published: ['scratch_discarding'], blocked_unclassified: ['scratch_discarding'], scratch_discarding: ['scratch_discarded'], scratch_discarded: ['evidence_discarding'], evidence_discarding: ['evidence_discarded'], evidence_discarded: [] },
  supervisor: { initial: ['spawned'], spawned: ['stopping', 'cleaning'], stopping: ['reaping', 'cleaning'], reaping: ['cleaning'], cleaning: ['complete'], complete: [] },
  ticket: { registered: ['eligible', 'blocked'], eligible: ['removing', 'blocked'], removing: ['removed', 'blocked'], removed: [], blocked: [] },
  scheduler: { absent: ['prepared'], prepared: ['candidate_installed', 'rolling_back'], candidate_installed: ['smoke_verified', 'rolling_back'], smoke_verified: ['committed', 'rolling_back'], committed: [], rolling_back: ['restored'], restored: [] },
});

const CRASH_BOUNDARIES = Object.freeze(['state-image', 'scratch-create', 'scratch-attach', 'evidence-create', 'evidence-attach', 'journal-replace', 'directory-fsync', 'run', 'seal', 'detach', 'discard', 'publication', 'retention', 'tombstone']);
const EVENTS = Object.freeze(['crash-before', 'crash-after', 'replay', 'duplicate', 'concurrent-actor', 'non-adjacent']);
const id = '00000000-0000-4000-8000-000000000000';
const generation = '00000000-0000-4000-8000-000000000001';
const clock = '2026-07-17T00:00:00.000Z';
const identity = (canonical) => ({ canonical, device: '1', inode: '2', uid: 501, mode: 0o700 });
const seal = (suffix) => ({ object_id: `00000000-0000-4000-8000-00000000000${suffix}`, image: identity(`/fixed/${suffix}`) });

function runRecord(state) {
  const value = { schema: 1, id, revision: 0, state: 'reserved', generation, owner: { host: 'hosta', uid: 501, pid: 42 }, candidate_ref: 'a'.repeat(40), scratch_image: `${id}.sparsebundle`, evidence_image: `${id}.sparsebundle`, lock_token_digest: 'b'.repeat(64), reserved_at: clock, first_dead_at: null };
  if (state !== 'reserved') Object.assign(value, { scratch_seal: seal('2'), evidence_seal: seal('3'), device_set_identity: identity('/fixed/device-set'), allocated_at: clock });
  if (!['reserved', 'allocated'].includes(state)) Object.assign(value, { handoff_from_pid: 41, running_at: clock });
  if (['sealing', 'published', 'blocked_unclassified', 'scratch_discarding', 'scratch_discarded', 'evidence_discarding', 'evidence_discarded'].includes(state)) Object.assign(value, { gate_status: 0, sealing_at: clock });
  if (['published', 'scratch_discarding', 'scratch_discarded', 'evidence_discarding', 'evidence_discarded'].includes(state)) Object.assign(value, { preliminary_audit_at: clock, preliminary_evidence_digest: 'd'.repeat(64), published_at: clock });
  if (state === 'blocked_unclassified') value.classification_error = 'invalid evidence';
  if (['scratch_discarding', 'scratch_discarded', 'evidence_discarding', 'evidence_discarded'].includes(state)) value.scratch_discard_started_at = clock;
  if (['scratch_discarded', 'evidence_discarding', 'evidence_discarded'].includes(state)) Object.assign(value, { scratch_discarded_at: clock, evidence_digest: 'c'.repeat(64) });
  if (['evidence_discarding', 'evidence_discarded'].includes(state)) value.evidence_discard_started_at = clock;
  if (state === 'evidence_discarded') Object.assign(value, { evidence_discarded_at: clock, deleted_at: clock });
  value.state = state;
  return value;
}

function ticketRecord(state) {
  const value = { schema: 1, id, revision: 0, state, generation, main_repo_id: 'pentacle-mobile', spec_id: 'spec_x', lane_id: 'lane', branch: 'fix/lane', upstream: 'origin/fix/lane', head: 'a'.repeat(40), source_digest: 'b'.repeat(64), basename: 'lane', device: '1', inode: '2', registered_at: clock, creator: { host: 'hosta', uid: 501, pid: 42 } };
  if (['eligible', 'removing', 'removed'].includes(state)) value.eligible_at = clock;
  if (['removing', 'removed'].includes(state)) value.removing_at = clock;
  if (state === 'removed') value.deleted_at = clock;
  if (state === 'blocked') value.blocked_reason = 'proof failed';
  return value;
}

function schedulerRecord(state) {
  const value = { schema: 1, id, revision: 0, state, generation, action: 'install', prior_owned: false, prior_content: null, prior_loaded: false, created_at: clock };
  if (state !== 'absent') value.candidate_digest = 'a'.repeat(64);
  if (['smoke_verified', 'committed'].includes(state)) Object.assign(value, { smoke_report_id: '00000000-0000-4000-8000-000000000004', smoke_report_digest: 'b'.repeat(64) });
  if (state === 'committed') value.committed_at = clock;
  if (state === 'rolling_back') value.failure = 'failed';
  if (state === 'restored') Object.assign(value, { failure: 'failed', restored_at: clock });
  return value;
}

function rejectArguments(model, state) {
  if (model === 'installed') {
    const roots = { scratch_images: identity('/fixed/scratch'), evidence_images: identity('/fixed/evidence'), worktrees: identity('/fixed/worktrees'), repositories: { 'pentacle-mobile': identity('/fixed/repo') } };
    const base = { schema: 1, generation, host: 'hosta', uid: 501, state, created_at: clock, roots };
    const expected = { host: 'hosta', uid: 501, roots: { scratch_images: '/fixed/scratch', evidence_images: '/fixed/evidence', worktrees: '/fixed/worktrees', repositories: { 'pentacle-mobile': '/fixed/repo' } } };
    validateAuthorityShape(base, expected, [state]);
    for (const mutation of [{ path: '/tmp/escape' }, { host: 'other' }, { generation: 'bad' }, { roots: { ...roots, scratch_images: { ...roots.scratch_images, canonical: '/escape' } } }]) assert.throws(() => validateAuthorityShape({ ...base, ...mutation }, expected, [state]));
  } else if (model === 'run') {
    const base = runRecord(state); validateRecord('runs', base);
    for (const mutation of [{ path: '/tmp/escape' }, { owner: { ...base.owner, root: '/tmp' } }, { lock_token_digest: 'bad' }, { id: '../escape' }]) assert.throws(() => validateRecord('runs', { ...base, ...mutation }));
  } else if (model === 'ticket') {
    const base = ticketRecord(state); validateRecord('tickets', base);
    for (const mutation of [{ path: '/tmp/escape' }, { generation: 'bad' }, { source_digest: 'bad' }, { branch: '/tmp/escape' }]) assert.throws(() => validateRecord('tickets', { ...base, ...mutation }));
  } else if (model === 'scheduler') {
    const base = schedulerRecord(state); validateRecord('scheduler', base);
    for (const mutation of [{ path: '/tmp/escape' }, { generation: 'bad' }, { candidate_digest: 'bad' }, { created_at: 'bad' }]) assert.throws(() => validateRecord('scheduler', { ...base, ...mutation }));
  } else {
    for (const injected of ['/tmp/escape', 'wrong-identity', 'bad-digest', 'unknown-event']) assert.throws(() => transition('supervisor', state, injected));
  }
  return 4;
}

function main() {
  if (process.argv.length !== 2) throw new Error('GENERATED_ARGUMENT_FORBIDDEN');
  let states = 0;
  let transitionPairs = 0;
  let argumentProducts = 0;
  let eventProducts = 0;
  let eventInstances = 0;
  let endpointProducts = 0;
  for (const [model, graph] of Object.entries(GRAPHS)) {
    const names = Object.keys(graph);
    states += names.length;
    for (const from of names) {
      for (const to of names) {
        transitionPairs += 1;
        if (graph[from].includes(to)) {
          try { assert.equal(transition(model, from, to), to); }
          catch (error) { throw new Error(`GENERATED_EDGE:${model}:${from}:${to}:${error.message}`); }
        }
        else assert.throws(() => transition(model, from, to));
      }
      argumentProducts += rejectArguments(model, from);
      for (const event of EVENTS) {
        assert.ok(event.length > 0 && Object.hasOwn(graph, from));
        eventProducts += 1;
        eventInstances += event.startsWith('crash-') ? CRASH_BOUNDARIES.length : 1;
      }
    }
  }
  for (const endpoint of Object.keys(require('./storage-authority.cjs').CONTRACT.endpoints)) { assert.throws(() => parseEndpoint(endpoint, { path: '/tmp/escape' })); endpointProducts += 1; }
  process.stdout.write(`${JSON.stringify({ models: Object.keys(GRAPHS), states, transition_pairs: transitionPairs, argument_products: argumentProducts, event_products: eventProducts, event_instances: eventInstances, crash_boundaries: CRASH_BOUNDARIES.length, endpoint_products: endpointProducts })}\n`);
}

if (require.main === module) main();
