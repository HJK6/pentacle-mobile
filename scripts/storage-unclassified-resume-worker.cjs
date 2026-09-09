'use strict';

const fs = require('node:fs');
const os = require('node:os');

if (fs.realpathSync(os.homedir()) === fs.realpathSync(os.userInfo().homedir)) throw new Error('UNCLASSIFIED_RESUME_REAL_HOME_REFUSED');

const [runId, nowText] = process.argv.slice(2);
if (!/^[0-9a-f-]{36}$/.test(runId || '') || !Number.isFinite(Number(nowText))) throw new Error('UNCLASSIFIED_RESUME_ARGUMENT');

const realStatfsSync = fs.statfsSync;
fs.statfsSync = (target, ...rest) => String(target).endsWith('/State')
  ? { bavail: 4096n, bsize: 4096n, blocks: 4096n, bfree: 4096n }
  : realStatfsSync(target, ...rest);

const mutationCapability = require('./storage-capability.cjs').claim();
const containers = require('./storage-containers.cjs');
const realResolveMounted = containers.resolveMounted;
const attachedKinds = new Set();
const scriptedInventory = (mount) => ({
  attached: mount === containers.mountPath('scratch') && attachedKinds.has('scratch') ? containers.imagePath('scratch', runId)
    : mount === containers.mountPath('evidence') && attachedKinds.has('evidence') ? containers.imagePath('evidence', runId) : null,
  enumerated: attachedKinds.size,
  foreign: 0,
});
containers.resolveMounted = (kind, id, inventory = scriptedInventory) => realResolveMounted(kind, id, inventory);
const originalBind = containers.bind;
containers.bind = (token) => ({
  ...originalBind(token),
  attachExisting: (kind, id) => { attachedKinds.add(kind); return containers.resolveMounted(kind, id); },
  detachAndDiscard: (kind, id, expectedSeal) => {
    const resolved = containers.resolveMounted(kind, id);
    containers.requireSeal(resolved.seal, expectedSeal);
    attachedKinds.delete(kind);
    fs.rmSync(resolved.image, { recursive: true });
    return { discarded: kind, run_id: id };
  },
  detachRetain: (kind, id, expectedSeal) => {
    const resolved = containers.resolveMounted(kind, id);
    containers.requireSeal(resolved.seal, expectedSeal);
    attachedKinds.delete(kind);
    return { retained: kind, run_id: id };
  },
  recoverDiscarding: (kind, id, expectedSeal, verify = null) => {
    const image = containers.imagePath(kind, id);
    const identity = require('./storage-state.cjs').canonicalIdentity(image);
    for (const key of ['canonical', 'device', 'inode', 'uid', 'mode']) {
      if (expectedSeal?.image?.[key] !== identity[key]) throw new Error('CONTAINER_JOURNAL_IMAGE_IDENTITY_MISMATCH');
    }
    attachedKinds.add(kind);
    let primary = null;
    try { if (verify) verify(containers.mountPath(kind)); }
    catch (error) { primary = error; }
    attachedKinds.delete(kind);
    if (primary) throw primary;
    fs.rmSync(image, { recursive: true });
    return { discarded: kind, run_id: id };
  },
});

let error = null;
let final;
try {
  final = require('./storage-janitor.cjs').bind(mutationCapability)
    .disposeUnclassified(runId, 'operator reviewed unclassified evidence', Number(nowText));
} catch (thrown) {
  error = String(thrown.message || thrown);
  final = require('./storage-state.cjs').readRecord('runs', runId);
}
process.stdout.write(`${JSON.stringify({
  error,
  run: { state: final.state, disposition_reason: final.disposition_reason },
  scratch_image_present: fs.existsSync(containers.imagePath('scratch', runId)),
  evidence_image_present: fs.existsSync(containers.imagePath('evidence', runId)),
  evidence_attached: attachedKinds.has('evidence'),
})}\n`);
