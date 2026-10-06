'use strict';

const path = require('node:path');

// The observer supplies proc_pidpath and the OS argv vector. A QA brief or shell
// argument mentioning a tool is not evidence that that tool is executing.
function heavyWork(executable, argv) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || !Array.isArray(argv)
    || !argv.every(arg => typeof arg === 'string')) throw new Error('QUIET_PROCESS_IDENTITY_INVALID');
  const name = path.basename(executable);
  if (name === 'xcodebuild') return true;
  if (name === 'simctl' || name === 'xcrun') {
    let index = 1;
    if (name === 'xcrun') {
      if (argv[index] === 'xcodebuild') return true;
      if (argv[index] !== 'simctl') return false;
      index += 1;
    }
    if (argv[index] === '--set') index += 2;
    return ['boot', 'bootstatus'].includes(argv[index]);
  }
  if (/^python(?:\d+(?:\.\d+)*)?$/i.test(name)) {
    for (let index = 1; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === '-c') return false;
      if (arg === '-m') return ['pytest', 'pytest.__main__'].includes(argv[index + 1]);
      if (arg === '-W' || arg === '-X') { index += 1; continue; }
      if (arg === '--') return ['pytest', 'run_gate.py'].includes(path.basename(argv[index + 1] || ''));
      if (arg.startsWith('-')) continue;
      return ['pytest', 'run_gate.py'].includes(path.basename(arg));
    }
  }
  if (name === 'node') {
    for (let index = 1; index < argv.length; index += 1) {
      const arg = argv[index];
      if (['-e', '--eval', '-p', '--print'].includes(arg)) return false;
      if (arg.startsWith('-')) continue;
      const script = path.basename(arg);
      return script === 'full-gate.cjs' || (script === 'storage-cli.cjs'
        && ['gate:native-root', 'gate:full'].includes(argv[index + 1]));
    }
  }
  return false;
}

function heavyWorkCommand(executable, commandLine) {
  if (typeof commandLine !== 'string') throw new Error('QUIET_PROCESS_IDENTITY_INVALID');
  // ps may read another uid's argv where KERN_PROCARGS2 refuses. Keep that
  // reader explicit and anchored to interpreter dispatch, never scan the brief.
  const name = path.basename(executable);
  if (!/^python(?:\d+(?:\.\d+)*)?$/i.test(name)) return heavyWork(executable, commandLine.trim().split(/\s+/));
  let rest = commandLine.trim().replace(/^\S+\s*/, '');
  while (rest.startsWith('-')) {
    if (/^-c(?:\s|$)/.test(rest)) return false;
    const module = /^-m\s+(\S+)/.exec(rest);
    if (module) return ['pytest', 'pytest.__main__'].includes(module[1]);
    if (/^(?:-W|-X)\s+\S+\s*/.test(rest)) rest = rest.replace(/^(?:-W|-X)\s+\S+\s*/, '');
    else rest = rest.replace(/^\S+\s*/, '');
  }
  const script = /^(.+?\.py)(?:\s|$)/.exec(rest)?.[1] || /^(\S+)/.exec(rest)?.[1] || '';
  return ['pytest', 'run_gate.py'].includes(path.basename(script.replace(/^['"]|['"]$/g, '')));
}

module.exports = { heavyWork, heavyWorkCommand };
