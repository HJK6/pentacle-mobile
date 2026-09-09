'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
fs.statfsSync = () => ({ blocks: 1n, bsize: 4096n });

const mutationCapability = require('./storage-capability.cjs').claim();
const state = require('./storage-state.cjs');
const stateMutations = state.bind(mutationCapability);
const { fixedLayout } = require('./storage-authority.cjs');
const containersPath = require.resolve('./storage-containers.cjs');
const containers = require(containersPath);
const layout = fixedLayout();
for (const target of [layout.support, layout.stateImage, layout.state, layout.scratchImages, layout.evidenceImages, layout.worktrees, layout.memory, ...Object.values(layout.repositories)]) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
const authority = stateMutations.createInstalledAuthority();
const id = '00000000-0000-4000-8000-000000000003';
const now = Date.parse('2026-07-18T00:00:00.000Z');
const images = {};
const seals = {};
const events = [];

for (const kind of ['scratch', 'evidence']) {
  images[kind] = path.join(process.env.HOME, `${kind}.sparsebundle`);
  fs.mkdirSync(images[kind], { mode: 0o700 });
  seals[kind] = { object_id: kind === 'scratch' ? '00000000-0000-4000-8000-000000000013' : '00000000-0000-4000-8000-000000000023', image: state.canonicalIdentity(images[kind]) };
}
const scratchMount = path.join(process.env.HOME, 'scratch-mount');
fs.mkdirSync(scratchMount, { recursive: true, mode: 0o700 });

require.cache[containersPath].exports = {
  ...containers,
  bind: (token) => ({ ...containers.bind(token), recoverOrCreate: (kind) => { events.push(`recover:${kind}`); return { seal: seals[kind] }; }, detachAndDiscard: (kind) => { events.push(`discard:${kind}`); fs.rmdirSync(images[kind]); } }),
  imagePath: (kind) => images[kind],
  resolveMounted: (kind) => ({ mount: kind === 'scratch' ? scratchMount : path.join(process.env.HOME, 'evidence-mount'), seal: seals[kind] }),
};
delete require.cache[require.resolve('./storage-janitor.cjs')];
const janitor = require('./storage-janitor.cjs');
const janitorMutations = janitor.bind(mutationCapability);

stateMutations.createRecord('runs', {
  schema: 1, id, revision: 0, state: 'reserved', generation: authority.generation,
  owner: { host: os.hostname(), uid: process.getuid(), pid: 2147483647 },
  candidate_ref: 'a'.repeat(40), gate_code_sha: 'b'.repeat(40), gate_code_tree_clean: true,
  scratch_image: `${id}.sparsebundle`, evidence_image: `${id}.sparsebundle`,
  lock_token_digest: 'b'.repeat(64), reserved_at: '2026-07-17T00:00:00.000Z', first_dead_at: null,
});
const recovered = janitorMutations.recoverRun(id, now);
process.stdout.write(JSON.stringify({ state: recovered.state, first_dead_at: recovered.first_dead_at, next: janitor.runDecision(recovered, now + 86400001), events, images_present: Object.values(images).some((file) => fs.existsSync(file)) }));
