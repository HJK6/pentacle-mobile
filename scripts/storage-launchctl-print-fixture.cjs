'use strict';

// Fixture stand-in for the parts of `launchctl print gui/<uid>/<label>` the scheduler reads back. The block is the
// exact shape real launchd printed for a plist SpawnConstraint on macOS 27.0 (the data element is redacted to `0 = `);
// scripts/storage-scheduler-spawn-constraint.test.cjs compares it with a real disposable launchd job.
const SPAWN_CONSTRAINT_BLOCK = [
  '\tspawn constraint = {',
  '\t\t"reqs" => {',
  '\t\t\t"cdhash" => {',
  '\t\t\t\t"$in" => [',
  '\t\t\t\t\t0 = \t\t\t\t]',
  '\t\t\t}',
  '\t\t}',
  '\t\t"vers" => 1',
  '\t\t"comp" => 1',
  '\t\t"ccat" => 0',
  '\t}',
].join('\n');

function printLoadedService(label, plistText) {
  const constrained = String(plistText).includes('<key>SpawnConstraint</key>');
  return `gui/501/${label} = {\n\tstate = not running\n${constrained ? `${SPAWN_CONSTRAINT_BLOCK}\n` : ''}\tproperties = inferred program${constrained ? ' | has spawn constraint' : ''}\n}\n`;
}

module.exports = { SPAWN_CONSTRAINT_BLOCK, printLoadedService };
