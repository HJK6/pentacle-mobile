'use strict';

const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [mode, stateRoot, kind, id, ...args] = process.argv.slice(2);
const originalLoad = Module._load;
const authority = require('./storage-authority.cjs');
const recordPath = path.join(stateRoot, kind, `${id}.json`);
const delay = new Int32Array(new SharedArrayBuffer(4));
let leaseRenameCount = 0;
let leaseExtractCount = 0;
let injectedOld = null;
const fsProxy = new Proxy(fs, {
  get(target, property) {
    if (property === 'readFileSync') return (file, ...rest) => {
        const value = target.readFileSync(file, ...rest);
        if (mode === 'replace' && String(file) === recordPath) Atomics.wait(delay, 0, 0, 300);
        return value;
      };
    if (property === 'renameSync') return (source, destination) => {
        const leaseRename = String(destination).endsWith('.claim.guard');
        const leaseExtract = String(source).endsWith('.claim.guard') && String(destination).endsWith('.release');
        if (leaseRename) {
          leaseRenameCount += 1;
          if ((mode === 'exit-before-rename' && leaseRenameCount === 1) || (mode === 'exit-before-release' && leaseRenameCount === 2)) process.exit(23);
        }
        if (leaseExtract) {
          leaseExtractCount += 1;
          if (mode === 'exit-before-lease-release' && leaseExtractCount === 1) process.exit(23);
          if (mode === 'aba-release' && leaseExtractCount === 1) {
            injectedOld = `${source}.injected-old`;
            target.renameSync(source, injectedOld);
            target.mkdirSync(source, { mode: 0o700 });
            target.writeFileSync(path.join(source, 'holder.json'), `${JSON.stringify({ host: os.hostname(), pid: process.pid, startToken: 'replacement' })}\n`, { mode: 0o600 });
          }
        }
        const result = target.renameSync(source, destination);
        if (leaseExtract && mode === 'exit-after-lease-extract' && leaseExtractCount === 1) process.exit(23);
        if (mode === 'aba-release' && injectedOld && String(source).endsWith('.release') && String(destination).endsWith('.claim.guard')) {
          const [outcome] = args;
          let survived = false;
          try { survived = JSON.parse(target.readFileSync(path.join(destination, 'holder.json'), 'utf8')).startToken === 'replacement'; } catch { survived = false; }
          target.writeFileSync(outcome, `${JSON.stringify({ replacement_lease_survived: survived })}\n`);
          try { target.unlinkSync(path.join(injectedOld, 'holder.json')); } catch {}
          try { target.rmdirSync(injectedOld); } catch {}
          injectedOld = null;
        }
        if (leaseRename && mode === 'exit-after-rename' && leaseRenameCount === 1) process.exit(23);
        if (leaseRename && mode === 'lease-hold' && leaseRenameCount === 1) {
          const [ready, release] = args;
          target.writeFileSync(ready, 'ready');
          waitFor(release);
        }
        return result;
      };
    if (property === 'readdirSync') return (directory, ...rest) => {
        if (mode === 'exit-before-owned-delete' && String(directory).endsWith('.release')) process.exit(23);
        return target.readdirSync(directory, ...rest);
      };
    if (property === 'unlinkSync') return (file, ...rest) => {
        const result = target.unlinkSync(file, ...rest);
        if (mode === 'exit-during-release' && leaseRenameCount >= 2 && String(file).endsWith('.claim')) process.exit(23);
        if (mode === 'exit-during-owned-delete' && String(file).includes('.release/holder.json')) process.exit(23);
        return result;
      };
    return Reflect.get(target, property);
  },
});

Module._load = function load(request, parent, isMain) {
  if (parent?.filename.endsWith('storage-state.cjs') && request === 'node:fs') return fsProxy;
  if (parent?.filename.endsWith('storage-state.cjs') && request === './storage-capability.cjs') return { bind: (_token, api) => api };
  if (parent?.filename.endsWith('storage-state.cjs') && request === './storage-authority.cjs') {
    return { ...authority, fixedLayout: () => ({ ...authority.fixedLayout(), state: stateRoot }) };
  }
  return originalLoad(request, parent, isMain);
};

const stateModule = require('./storage-state.cjs');
const state = stateModule.bind(Symbol('q8-test'));

function waitFor(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error('Q8_WAIT_TIMEOUT');
    Atomics.wait(delay, 0, 0, 10);
  }
}

try {
  if (mode === 'replace') {
    const [barrier, actor] = args;
    fs.writeFileSync(`${barrier}.${actor}`, 'ready');
    waitFor(`${barrier}.a`);
    waitFor(`${barrier}.b`);
    const current = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    state.replaceRecord(kind, id, current.revision, { ...current, revision: current.revision + 1 });
  } else if (mode === 'hold') {
    const [ready, release] = args;
    state.withRecordMutation(kind, id, () => {
      fs.writeFileSync(ready, 'ready');
      waitFor(release);
    });
  } else if (mode === 'try') {
    state.withRecordMutation(kind, id, () => {});
  } else if (['exit-before-rename', 'exit-after-rename', 'exit-before-release', 'exit-during-release', 'exit-before-lease-release', 'exit-after-lease-extract', 'exit-before-owned-delete', 'exit-during-owned-delete'].includes(mode)) {
    state.withRecordMutation(kind, id, () => {});
  } else if (mode === 'exit-during-mutation') {
    state.withRecordMutation(kind, id, () => process.exit(23));
  } else if (mode === 'lease-hold') {
    state.withRecordMutation(kind, id, () => {});
  } else if (mode === 'race') {
    const [ready, release, actor] = args;
    state.withRecordMutation(kind, id, () => {
      fs.writeFileSync(ready, actor, { flag: 'wx' });
      waitFor(release);
    });
  } else if (mode === 'aba-release') {
    const [, completed] = args;
    state.withRecordMutation(kind, id, () => fs.appendFileSync(completed, 'superseded\n'));
  } else if (mode === 'complete') {
    const [completed, actor] = args;
    state.withRecordMutation(kind, id, () => fs.appendFileSync(completed, `${actor}\n`));
  } else if (mode === 'crash') {
    state.withRecordMutation(kind, id, () => process.exit(23));
  } else if (mode === 'validate') {
    stateModule.validateStateLayout(stateRoot);
  } else if (mode === 'mismatch') {
    const current = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    state.replaceRecord(kind, id, current.revision + 10, { ...current, revision: current.revision + 1 });
  } else {
    throw new Error('Q8_MODE');
  }
} catch (error) {
  if (process.env.Q8_DEBUG === '1') process.stderr.write(`${error.message}\n`);
  process.exitCode = 17;
}
