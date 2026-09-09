'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixedLayout } = require('./storage-authority.cjs');
const { profileForRun } = require('./storage-sandbox.cjs');

if (process.argv.length !== 2) throw new Error('Q7_ARGUMENT');
const layout = fixedLayout();
for (const target of [layout.scratchMount, layout.evidenceMount, layout.state]) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(layout.state, 'authority.json'), '{}\n');
const profile = profileForRun();
const run = (argv) => spawnSync('/usr/bin/sandbox-exec', ['-p', profile, ...argv], { encoding: 'utf8' }).status;
const result = {
  state_read: run(['/bin/cat', path.join(layout.state, 'authority.json')]),
  state_write: run(['/usr/bin/touch', path.join(layout.state, 'forged.json')]),
  scratch_write: run(['/usr/bin/touch', path.join(layout.scratchMount, 'allowed')]),
  forged: fs.existsSync(path.join(layout.state, 'forged.json')),
};
process.stdout.write(`${JSON.stringify(result)}\n`);
