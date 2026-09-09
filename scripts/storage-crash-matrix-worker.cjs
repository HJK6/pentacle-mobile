'use strict';

// The five CONTAINER crossings of the nine-class matrix, each exercised where it actually sits.
//
// The other four are driven by storage-lifecycle-seams-worker.cjs, which already owns a rig with a
// real journal, a real evidence tree, and a real published run - publication, journal durability,
// retention and tombstone all need one, and building a second would be a copy that could drift.
//
// hdiutil is replaced through `execute`, which createImage and detachAndDiscard already take as a
// named parameter - this is not a new seam. Each replacement performs the REAL EFFECT the command
// would have had on the filesystem (an image appears, a volume becomes attached, bytes go away), so
// what the crash leaves behind is the same shape a power loss would leave, and the post-mortem in
// storage-lifecycle-seams.test.cjs reads it off disk rather than from anything this process reports.
//
// Arming is in-process and capability-bound, which is exactly why this has to be a separate process
// that deliberately arms itself and dies: an environment variable would mean any ambient value in a
// real gate could terminate it mid-transition.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// FIRST, before anything is computed from the layout. This worker creates containers and DELETES
// their bytes at paths fixedLayout() derives from HOME; run with the operator's real HOME it would
// operate inside the live store. Measured, not hypothetical: an invocation that forgot to set HOME
// created a fixture image directly in the operator's ScratchImages. userInfo().homedir is the real
// account home and is unaffected by the HOME redirection every caller of this worker performs, which
// is exactly what makes it usable as the thing to compare against.
if (fs.realpathSync(os.homedir()) === fs.realpathSync(os.userInfo().homedir)) throw new Error('CRASH_MATRIX_REAL_HOME_REFUSED');

const POINTS = new Set(['container-create', 'container-attach', 'seal', 'detach', 'discard']);
const point = process.argv[2];
if (!POINTS.has(point)) throw new Error('CRASH_MATRIX_ARGUMENT');

const AMPLE_BLOCKS = 64n * 1024n * 1024n * 1024n / 4096n;
fs.statfsSync = () => ({ bavail: AMPLE_BLOCKS, bsize: 4096n, blocks: AMPLE_BLOCKS, bfree: AMPLE_BLOCKS });

const mutationCapability = require('./storage-capability.cjs').claim();
const { fixedLayout } = require('./storage-authority.cjs');
const containers = require('./storage-containers.cjs');
const containerMutations = containers.bind(mutationCapability);
const { armCrashPoint } = require('./storage-crash-points.cjs').bind(mutationCapability);

const layout = fixedLayout();
for (const target of [layout.support, layout.state, layout.scratchImages, layout.evidenceImages]) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
}

// A FIXED run id, so the post-mortem knows which paths to look at without this process telling it -
// a crashed process has no chance to report anything, which is the whole point.
const RUN_ID = '55555555-5555-4555-8555-555555555555';
const ATTACHED = '.attached';

// Each branch does what the real binary would have done to the filesystem. The attach sentinel is
// what makes "the volume is mounted" observable after the process is gone: the mount directory itself
// is created before the image exists, so its presence proves nothing.
function execute(binary, args) {
  const action = args?.[0];
  const image = containers.imagePath('scratch', RUN_ID);
  const mount = containers.mountPath('scratch');
  if (binary === '/usr/bin/hdiutil' && action === 'create') fs.mkdirSync(image, { recursive: true, mode: 0o700 });
  if (binary === '/usr/bin/hdiutil' && action === 'attach') fs.writeFileSync(path.join(mount, ATTACHED), 'attached\n', { mode: 0o600 });
  if (binary === '/usr/bin/hdiutil' && action === 'detach') fs.rmSync(path.join(mount, ATTACHED), { force: true });
  if (binary === '/bin/rm' || binary === '/usr/bin/trash') fs.rmSync(args[args.length - 1], { recursive: true, force: true });
  return '';
}

// The hdiutil enumeration, answered from the sentinel the fake attach writes, so the detach proof in
// detachAndProve is a REAL observation of the state this process actually produced rather than a
// constant. requireDetached therefore only succeeds once the fake detach has really run.
const inventory = (mount) => ({
  attached: fs.existsSync(path.join(mount, ATTACHED)) ? containers.imagePath('scratch', RUN_ID) : null,
  enumerated: 1,
  foreign: 0,
});

if (['container-create', 'container-attach', 'seal'].includes(point)) {
  armCrashPoint(point);
  containerMutations.createImage('scratch', RUN_ID, execute);
  throw new Error(`CRASH_MATRIX_NOT_REACHED:${point}`);
}

// detach and discard sit inside disposal, so the container has to exist and be attached first. That
// setup runs UNARMED - arming it here would crash in creation and never reach the crossing under test.
const created = containerMutations.createImage('scratch', RUN_ID, execute);
armCrashPoint(point);
containerMutations.detachAndDiscard('scratch', RUN_ID, created.seal, execute, inventory);
throw new Error(`CRASH_MATRIX_NOT_REACHED:${point}`);
