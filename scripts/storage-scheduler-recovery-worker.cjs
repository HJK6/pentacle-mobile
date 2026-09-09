'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
fs.statfsSync = () => ({ blocks: 1n, bsize: 4096n });
const mutationCapability = require('./storage-capability.cjs').claim();
const { fixedLayout } = require('./storage-authority.cjs');
const state = require('./storage-state.cjs');
const stateMutations = state.bind(mutationCapability);
const layout = fixedLayout();
for (const target of [layout.support, layout.stateImage, layout.state, layout.worktrees, layout.memory, ...Object.values(layout.repositories)]) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
const authority = stateMutations.createInstalledAuthority();
stateMutations.createRecord('scheduler', { schema: 1, id: crypto.randomUUID(), revision: 0, state: 'rolling_back', generation: authority.generation, action: 'install', prior_owned: false, prior_content: null, prior_loaded: false, created_at: new Date().toISOString(), candidate_digest: 'a'.repeat(64), failure: 'forced' });
require('./storage-scheduler.cjs').bind(mutationCapability).recoverCommitted();
process.stdout.write(state.readAuthorityState().state);
