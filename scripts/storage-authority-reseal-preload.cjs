'use strict';

// Owned-fixture native boundary only. The supported CLI, authority checks, proof admission,
// transactions, leases and on-disk crash reconciliation execute unchanged in separate processes.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const fixture = process.env.RESEAL_TEST_FIXTURE;
if (!fixture || !path.isAbsolute(fixture) || !fs.existsSync(path.join(fixture, 'fixture.json'))) throw new Error('RESEAL_FIXTURE_REQUIRED');
const configuration = JSON.parse(fs.readFileSync(path.join(fixture, 'fixture.json')));
const originalStat = fs.statSync, originalStatfs = fs.statfsSync, originalExec = cp.execFileSync;
Object.defineProperty(process, 'platform', { value: 'darwin' });
os.homedir = () => fixture;
// The fixed macOS Data mount is mapped to the owned fixture, never created on the test host.
const originalLstat = fs.lstatSync, originalRealpath = fs.realpathSync;
fs.lstatSync = function lstat(target, ...args) { return originalLstat.call(this, target === '/System/Volumes/Data' ? fixture : target, ...args); };
fs.statSync = function stat(target, ...args) {
  const value = originalStat.call(this, target === '/System/Volumes/Data' ? fixture : target, ...args);
  if (target === path.join(fixture, 'Library/PentacleMobileStorage/State') && !configuration.state_same_device) value.dev = Number(value.dev) + 1;
  if (configuration.foreign_root_device && target === path.join(fixture, 'agent-workspace/worktrees')) value.dev = Number(value.dev) + 2;
  return value;
};
fs.realpathSync = Object.assign(function realpath(target, ...args) { return target === '/System/Volumes/Data' ? target : originalRealpath.call(this, target, ...args); }, { native: originalRealpath.native });
fs.statfsSync = function statfs(target, ...args) { return target === path.join(fixture, 'Library/PentacleMobileStorage/State') ? { blocks: 1n, bsize: 4096n } : originalStatfs.call(this, target, ...args); };
cp.execFileSync = function exec(binary, args, options) {
  if (configuration.epoch_unavailable && binary === '/bin/ps') return '';
  if (configuration.probe_unavailable && binary === '/usr/sbin/diskutil') throw new Error('FIXTURE_PROBE_UNAVAILABLE');
  if (binary === '/usr/bin/plutil') return String(options.input);
  if (binary === '/usr/sbin/ioreg') return JSON.stringify([{ IOPlatformUUID: configuration.hardware_uuid }]);
  if (binary === '/usr/sbin/diskutil') {
    const backing = args.at(-1) === '/System/Volumes/Data';
    return JSON.stringify({ FilesystemType: 'apfs', VolumeUUID: backing ? configuration.backing_volume_uuid : configuration.state_volume_uuid,
      MountPoint: backing ? '/System/Volumes/Data' : path.join(fixture, 'Library/PentacleMobileStorage/State'), DeviceNode: '/dev/disk99s1' });
  }
  if (binary === '/usr/bin/hdiutil') return JSON.stringify({ images: configuration.images });
  return originalExec.call(this, binary, args, options);
};

const crash = process.env.RESEAL_TEST_CRASH;
const originalRename = fs.renameSync, originalFsync = fs.fsyncSync;
const originalOpen = fs.openSync;
fs.openSync = function open(target, ...args) {
  if (typeof target === 'string' && target.endsWith('-prepare.tmp')) {
    if (crash === 'before-prepare-open') process.exit(91);
    if (process.env.RESEAL_TEST_PAUSE) {
      fs.writeFileSync(path.join(fixture, 'writer-paused'), 'ready');
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(path.join(fixture, 'writer-release'))) {
        if (Date.now() > deadline) throw new Error('RESEAL_FIXTURE_PAUSE_TIMEOUT');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  }
  return originalOpen.call(this, target, ...args);
};
fs.renameSync = function rename(from, to) {
  const phase = from.endsWith('-prepare.tmp') ? 'prepare' : from.endsWith('-authority.tmp') ? 'authority' : from.endsWith('-commit.tmp') ? 'commit' : null;
  if (phase && crash === `before-${phase}`) process.exit(91);
  const result = originalRename.call(this, from, to);
  if (phase && crash === `after-${phase}`) process.exit(91);
  return result;
};
fs.fsyncSync = function fsync(fd) {
  const result = originalFsync.call(this, fd);
  if (crash === 'prepared-orphan' && fs.existsSync(path.join(fixture, 'Library/PentacleMobileStorage/State', `.authority-reseal-${configuration.migration_id}-prepare.tmp`))) process.exit(91);
  return result;
};

// Direct cleanup paths supplement the real CLI tests, preserving their actual capability owners.
if (process.env.RESEAL_TEST_DIRECT) {
  const scripts = __dirname;
  process.nextTick(() => {
    try {
      const capability = require(path.join(scripts, 'storage-capability.cjs'));
      const Module = require('node:module'), load = Module._load;
      let token;
      Module._load = function(request) {
        const actual = load.apply(this, arguments);
        return path.basename(request) === 'storage-capability.cjs' ? { ...actual, bind: (value, api) => { token = value; return capability.bind(value, api); } } : actual;
      };
      const name = process.env.RESEAL_TEST_DIRECT;
      const owner = require(path.join(scripts, name === 'janitor' ? 'storage-janitor.cjs' : 'storage-scheduler.cjs'));
      Module._load = load;
      const api = owner.bind(token);
      if (name === 'janitor') api.runJanitor('dry-run');
      else api.recoverCommitted();
    } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  });
}
