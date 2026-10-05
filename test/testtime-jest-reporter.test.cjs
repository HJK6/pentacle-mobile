'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('configured shared reporter performs runtime output and returns callback results', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-jest-reporter-'));
  const prior = process.env.TESTTIME_JEST_REPORTER;
  t.after(() => { if (prior === undefined) delete process.env.TESTTIME_JEST_REPORTER; else process.env.TESTTIME_JEST_REPORTER = prior; fs.rmSync(root, { recursive: true, force: true }); });
  const output = path.join(root, 'events.jsonl');
  const shared = path.join(root, 'shared.cjs');
  fs.writeFileSync(shared, `const fs = require('node:fs');
module.exports = class Shared {
  constructor(...args) { this.out = args[1].output; this.record('constructor', args); }
  record(name, args) { fs.appendFileSync(this.out, JSON.stringify({name,args}) + '\\n'); }
  onRunStart(...args) { this.record('start', args); return 'started'; }
  async onTestResult(...args) { this.record('test', args); return 'recorded'; }
  onRunComplete(...args) { this.record('complete', args); }
  getLastError() { return this.failure; }
};\n`);
  process.env.TESTTIME_JEST_REPORTER = shared;
  const Reporter = require('./testtime-jest-reporter.cjs');
  const instance = new Reporter({ enabled: true }, { output }, { extra: 'context' });
  assert.equal(instance.onRunStart({ numTotalTests: 1 }, { estimatedTime: 1 }), 'started');
  assert.equal(await instance.onTestResult({ path: 'synthetic.test.js' }, { numPassingTests: 1 }, { numPassedTests: 1 }), 'recorded');
  instance.onRunComplete(new Set(), { success: true });
  const rows = fs.readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.name), ['constructor', 'start', 'test', 'complete']);
  assert.equal(rows[0].args[2].extra, 'context');
  assert.equal(rows[2].args[1].numPassingTests, 1);
  const failure = new Error('shared reporter failed');
  instance.delegate.failure = failure;
  assert.equal(instance.getLastError(), failure);
});

test('an installed broken shared reporter is not silently replaced', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broken-jest-reporter-'));
  const prior = process.env.TESTTIME_JEST_REPORTER;
  t.after(() => { if (prior === undefined) delete process.env.TESTTIME_JEST_REPORTER; else process.env.TESTTIME_JEST_REPORTER = prior; fs.rmSync(root, { recursive: true, force: true }); });
  const shared = path.join(root, 'broken.cjs');
  fs.writeFileSync(shared, "require('./missing-dependency.cjs');\n");
  process.env.TESTTIME_JEST_REPORTER = shared;
  assert.throws(() => new (require('./testtime-jest-reporter.cjs'))(), /missing-dependency/);
});
