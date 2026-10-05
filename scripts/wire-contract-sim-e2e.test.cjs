'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseArgs, run } = require('./wire-contract-sim-e2e.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-wire-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  const checkout = 'a'.repeat(40);
  const provenance = { checkout_commit: checkout };
  for (const key of ['chat_streamd', 'spawn_profiles', 'daemon_init_code', 'handle_client_code', 'validate_v2_code', 'spawn_catalog_code']) provenance[`loaded_${key}_sha256`] = 'b'.repeat(64);
  put('provenance.json', provenance);
  put('cleanup.json', { cleaned: true });
  const options = [{ label: 'Synthetic choice', value: 'choice' }];
  put('fixture.json', { schema_version: 1, case: 'question_options', question: { options }, answer: { expected_selection: options[0] } });
  put('requests.json', [{ parsed: { type: 'notification.resolve', request_id: 'synthetic', selections: options } }]);
  put('responses.json', [
    { type: 'prompt.ask.ok', request_id: 'seed-question_options', question: { envelope: { options } } },
    { type: 'notification', notification: { state: 'open', question: { options } } },
    { type: 'notification.resolve.ok' },
  ].map(parsed => ({ parsed })));
  const args = ['--artifact-dir', root, '--fixture', path.join(root, 'fixture.json'), '--expected-checkout', checkout];
  return { root, put, args };
}

test('wire runner invokes the actual public validator and proves protocol mutation rejection', t => {
  const { root, args } = fixture(t);
  assert.equal(run(args).status, 0);
  const proofPath = path.join(root, 'mutation.json');
  const mutation = run([...args, '--mutation-proof-out', proofPath]);
  assert.equal(mutation.status, 0, mutation.stdout + mutation.stderr);
  assert.equal(JSON.parse(fs.readFileSync(proofPath)).validator_rejected, true);
});

test('wire runner rejects missing or stale provenance and uncleared server ownership', t => {
  const { root, put, args } = fixture(t);
  assert.notEqual(run([...args.slice(0, -1), 'c'.repeat(40)]).status, 0);
  put('cleanup.json', { cleaned: false });
  assert.notEqual(run(args).status, 0);
  put('cleanup.json', { cleaned: true });
  fs.unlinkSync(path.join(root, 'provenance.json'));
  assert.notEqual(run(args).status, 0);
});

test('wire runner requires explicit full checkout identity and never permits live-cleanup bypass', () => {
  for (const args of [[], ['--artifact-dir', '/tmp'], ['--artifact-dir', '/tmp', '--fixture', '/tmp/f', '--expected-checkout', 'HEAD'], ['--allow-live', '1']]) assert.throws(() => parseArgs(args));
});
