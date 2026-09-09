'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runGate } = require('./full-gate.cjs');
const { writeEvidenceTree } = require('./storage-evidence-fixture.cjs');

test('failed evidence fixture matches runGate\'s N+1 files against N summary entries', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-mobile-failed-stage-shape-'));
  const actual = path.join(tempRoot, 'actual');
  const fixture = path.join(tempRoot, 'fixture');
  fs.mkdirSync(actual);
  try {
    const gates = [runGate('focused-jest', [process.execPath, '-e', 'process.exit(0)'], actual)];
    assert.throws(
      () => runGate('serial-jest', [process.execPath, '-e', 'process.exit(7)'], actual),
      /serial-jest failed/,
    );
    fs.writeFileSync(path.join(actual, 'run.json'), `${JSON.stringify({ status: 'failed', gates })}\n`);
    writeEvidenceTree(fixture, { gateStatus: 7, stageCount: 1 });

    const stageShape = (root) => fs.readdirSync(root)
      .filter((name) => /^(focused-jest|serial-jest)\.(json|log)$/.test(name))
      .sort();
    assert.deepEqual(stageShape(fixture), stageShape(actual));
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture, 'run.json'), 'utf8')).gates.length, 1);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
