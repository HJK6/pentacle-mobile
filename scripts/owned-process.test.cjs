'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runOwnedSync } = require('./owned-process.cjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

test('timeout and normal nonzero exit preserve status and reap only their group', () => {
  const sentinel = spawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore' }); sentinel.unref();
  try {
    const timeout = runOwnedSync(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 150 });
    assert.equal(timeout.status, 124);
    assert.equal(timeout.error.code, 'ETIMEDOUT');
    assert.equal(timeout.ownership.group_alive_after, false);
    assert.equal(alive(sentinel.pid), true);
    const nonzero = runOwnedSync(process.execPath, ['-e', 'process.exit(7)']);
    assert.equal(nonzero.status, 7);
    assert.equal(nonzero.ownership.group_alive_after, false);
  } finally { sentinel.kill(); }
});

for (const signal of ['SIGTERM', 'SIGKILL']) test(`guardian survives owner ${signal} and reaps descendants`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-owner-death-'));
  const marker = path.join(root, 'child.json');
  const subject = `require('fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,receipt:process.env.PENTACLE_OWNED_GROUP_RECEIPT}));setInterval(()=>{},1000)`;
  const runner = `require(${JSON.stringify(require.resolve('./owned-process.cjs'))}).runOwnedSync(process.execPath,['-e',${JSON.stringify(subject)}],{timeout:60000})`;
  const owner = spawn(process.execPath, ['-e', runner], { detached: true, stdio: 'ignore' });
  let child;
  try {
    const start = Date.now();
    while (!fs.existsSync(marker) && Date.now() - start < 5000) await sleep(25);
    assert.equal(fs.existsSync(marker), true, 'the actual child must start before the owner-death injection');
    child = JSON.parse(fs.readFileSync(marker, 'utf8'));
    owner.kill(signal);
    while ((alive(child.pid) || fs.existsSync(child.receipt)) && Date.now() - start < 8000) await sleep(25);
    assert.equal(alive(child.pid), false);
    assert.equal(fs.existsSync(child.receipt), false, 'the guardian must clean the dead creator temporary directory');
  } finally { owner.kill('SIGKILL'); if (child && alive(child.pid)) process.kill(child.pid, 'SIGKILL'); fs.rmSync(root, { recursive: true, force: true }); }
});
