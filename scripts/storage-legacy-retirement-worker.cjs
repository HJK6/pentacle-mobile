'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const mutationCapability = require('./storage-capability.cjs').claim();
const { fixedLayout } = require('./storage-authority.cjs');
const containers = require('./storage-containers.cjs');
const state = require('./storage-state.cjs');

const AMPLE_BLOCKS = 64n * 1024n * 1024n * 1024n / 4096n;
fs.statfsSync = (target) => {
  const blocks = String(target).includes(`${path.sep}State`) ? 4096n : AMPLE_BLOCKS;
  return { bavail: blocks, bsize: 4096n, blocks, bfree: blocks };
};

const scenario = process.argv[2];
if (!['scratch', 'evidence'].includes(scenario)) throw new Error('LEGACY_RETIREMENT_ARGUMENT');
const run = state.listRecords('runs')[0];
if (!run || state.listRecords('runs').length !== 1) throw new Error('LEGACY_RETIREMENT_RUN');
const roots = {
  scratch: { image: containers.imagePath('scratch', run.id), mount: containers.mountPath('scratch') },
  evidence: { image: containers.imagePath('evidence', run.id), mount: containers.mountPath('evidence') },
};
const attached = new Set(Object.keys(roots).filter((kind) => fs.existsSync(roots[kind].mount)));
const inventory = (mount) => {
  const entry = Object.entries(roots).find(([, value]) => value.mount === mount);
  return { attached: entry && attached.has(entry[0]) ? entry[1].image : null, enumerated: attached.size, foreign: 0 };
};
const resolveMounted = containers.resolveMounted;
containers.resolveMounted = (kind, id, source = inventory) => resolveMounted(kind, id, source);
containers.bind = () => ({
  attachExisting: (kind, id) => containers.resolveMounted(kind, id),
  createImage: () => { throw new Error('LEGACY_RETIREMENT_CREATE'); },
  detachAndDiscard: (kind, id, seal) => {
    containers.requireSeal(containers.resolveMounted(kind, id).seal, seal);
    fs.rmSync(roots[kind].mount, { recursive: true, force: true });
    fs.rmSync(roots[kind].image, { recursive: true, force: true });
    attached.delete(kind);
    return { discarded: kind, run_id: id };
  },
  detachRetain: () => {},
  ensureStateImage: () => {},
  recoverDiscarding: () => { throw new Error('LEGACY_RETIREMENT_RECOVERY'); },
  recoverOrCreate: (kind, id) => containers.resolveMounted(kind, id),
});

const gate = require('./storage-gate.cjs');
const evidenceRoot = roots.evidence.mount;
const summaryPath = path.join(evidenceRoot, 'run.json');
const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
delete summary.candidate_sha;
delete summary.gate_code_sha;
delete summary.gate_code_tree_clean;
fs.writeFileSync(summaryPath, `${JSON.stringify(summary)}\n`);

const legacy = { ...run };
delete legacy.gate_code_sha;
delete legacy.gate_code_tree_clean;
if (scenario === 'scratch') {
  legacy.preliminary_evidence_digest = gate.preliminaryEvidenceDigest(evidenceRoot, run.id, run.gate_status);
} else {
  const manifestPath = path.join(evidenceRoot, 'manifest-v1.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.files = gate.enumerateEvidence(evidenceRoot).filter((entry) => entry.relative !== 'manifest-v1.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  legacy.evidence_digest = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}
fs.writeFileSync(path.join(fixedLayout().state, 'runs', `${run.id}.json`), `${JSON.stringify(legacy)}\n`);

let retired;
if (scenario === 'scratch') retired = gate.bind(mutationCapability).discardPublishedScratch(run.id, Date.parse(run.published_at) + 1);
else retired = require('./storage-janitor.cjs').bind(mutationCapability).discardEvidence(run.id, Date.parse(run.published_at) + 8 * 86400000);
assert.equal(retired.gate_code_sha, undefined);
assert.equal(retired.gate_code_tree_clean, undefined);
process.stdout.write(`${JSON.stringify({ state: retired.state, scratch: fs.existsSync(roots.scratch.image), evidence: fs.existsSync(roots.evidence.image) })}\n`);
