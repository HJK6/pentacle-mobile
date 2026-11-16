'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const driver = path.join(__dirname, 'lanes-flow-v2-render.cjs');
const source = fs.readFileSync(driver, 'utf8');
// Execute the actual driver with only browser and filesystem boundaries replaced.
// No Playwright import, process, listener or network access occurs in these tests.
async function execute({ mode, count = 12, mapError, overlap = false, dotError, pageError } = {}) {
  const files = new Map(), shots = [], visits = [], closes = { page: 0, browser: 0 };
  const processStub = { env: { PENTACLE_RENDER_OUTPUT: '/synthetic-render-output', ...(mode ? { PENTACLE_RENDER_MODE: mode } : {}) }, exitCode: undefined };
  let resolveReceipt;
  const completed = new Promise(resolve => { resolveReceipt = resolve; });
  let onPageError;
  const bounds = text => text === 'Prepare the next release and verify every supported client' ? { x: 64, y: 90, width: 140, height: 42 }
    : text === 'waiting on Dot · 3h' ? { x: overlap ? 100 : 214, y: 90, width: 140, height: 14 }
      : { x: 16, y: text === 'Dot' ? 100 : text === 'Now' ? 130 : 160, width: 80, height: 20 };
  const locator = (selector, text) => ({
    async evaluate(fn) {
      if (selector.includes('lanes-map-assistant') && mapError) throw mapError;
      return fn({ getBoundingClientRect: () => text ? bounds(text) : selector.includes('lane-card-')
        ? { x: 16, y: 80, width: 358, height: 100 } : { x: 100, y: 100, width: 24, height: 24 } });
    },
    async evaluateAll(fn) { return fn(Array.from({ length: count }, (_, i) => ({ dataset: { testid: `lanes-map-lane-synthetic-${i}` } }))); },
    async scrollIntoViewIfNeeded() {},
    async click() {},
    async waitFor() { if (text === 'Waiting for Dot' && dotError) throw dotError; },
    getByText(value) { return locator(selector, value); },
  });
  const page = {
    locator,
    getByText(text) { return locator('', text); },
    on(name, callback) { if (name === 'pageerror') onPageError = callback; },
    async goto(url) { visits.push(url); },
    async waitForFunction() {}, async addStyleTag() {}, async waitForTimeout() {},
    async evaluate() { return true; },
    async screenshot({ path: output }) {
      shots.push(path.basename(output)); files.set(output, Buffer.from(`synthetic:${output}`));
      if (pageError && output.endsWith('dot-item.png')) onPageError(pageError);
    },
    async close() { closes.page++; },
  };
  const browser = { async newPage() { return page; }, async close() { closes.browser++; } };
  const modules = {
    'node:assert/strict': assert, 'node:path': path, 'node:crypto': crypto,
    'node:fs': { mkdirSync() {}, readFileSync(file) { assert(files.has(file), `Missing synthetic file ${file}`); return files.get(file); },
      writeFileSync(file, data) { files.set(file, data); if (file.endsWith('receipt.json')) resolveReceipt(JSON.parse(data)); } },
    playwright: { chromium: { async launch() { return browser; } } },
  };
  vm.runInNewContext(source, { require(name) { assert(Object.hasOwn(modules, name), `Unexpected dependency ${name}`); return modules[name]; },
    __dirname, process: processStub, URL, Buffer, console }, { filename: driver });
  const receipt = await completed;
  return { receipt, exitCode: processStub.exitCode, shots, visits, closes };
}

const mode = 'dot-with-known-map-red';
test('default driver still fails at the original map count before any Dot capture', { timeout: 2000 }, async () => {
  const result = await execute();
  assert.equal(result.receipt.passed, false);
  assert.match(result.receipt.failure, /12 !== 20/);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.shots, []);
  assert.equal(result.receipt.known_reds, undefined);
  assert.equal(result.closes.browser, 1);
});

test('opt-in retains KNOWN RED and citations, runs real Dot assertions, lists unexecuted checks and never passes the full driver', { timeout: 2000 }, async () => {
  const { receipt, exitCode, shots, closes } = await execute({ mode });
  assert.equal(receipt.status, 'KNOWN RED');
  assert.equal(receipt.passed, false);
  assert.equal(exitCode, 1);
  assert.equal(receipt.spec8.status, 'PASS');
  assert.equal(receipt.known_reds.length, 1);
  assert.deepEqual(receipt.known_reds[0].observed, { actual: 12, expected: 20, width: 390, fixture: 'roadmap_views' });
  assert.equal(receipt.known_reds[0].rule.ref, '67898c29');
  assert.equal(receipt.known_reds[0].evidence.sha256, 'debfb35fd3fb4380a7aad7c21982bac4c6fc7e77230a3cf94a7d17aa6b443ffa');
  assert.equal(receipt.known_reds[0].evidence.base, 'cfccc24c6b3a7315f43c24aa9100ce7287909325');
  assert.equal(receipt.known_reds[0].evidence.candidate, '1280be28846e6ad398f37438b49bde0fb67fc571');
  assert.deepEqual(receipt.maps, []);
  assert(receipt.not_executed.some(entry => entry.check === 'map.zero-overflow-markers' && entry.reason === 'Stopped after KNOWN RED lane count'));
  assert(receipt.not_executed.some(entry => entry.check === 'map.geometry' && entry.width === 390));
  assert(receipt.not_executed.some(entry => entry.check === 'default.other-viewports'));
  assert(receipt.not_executed.some(entry => entry.check === 'default.roadmap-busy'));
  assert.deepEqual(shots, ['dot-home-waiting.png', 'dot-waiting-lane.png', 'dot-item.png']);
  assert.equal(receipt.waitingCard.overlap, false);
  assert.equal(receipt.spec8.checks.includes('Dot / Now / Latest row order'), true);
  assert.deepEqual(closes, { page: 1, browser: 1 });
});

test('opt-in never suppresses a different map count', { timeout: 2000 }, async () => {
  const { receipt, shots } = await execute({ mode, count: 13 });
  assert.equal(receipt.passed, false);
  assert.equal(receipt.status, 'FAIL');
  assert.match(receipt.failure, /13 !== 20/);
  assert.deepEqual(receipt.known_reds, []);
  assert.equal(receipt.spec8.status, 'NOT EXECUTED');
  assert.deepEqual(shots, []);
});

test('opt-in propagates unrelated map/browser errors before the known predicate', { timeout: 2000 }, async () => {
  const failure = new Error('detached map page');
  const { receipt, shots, closes } = await execute({ mode, mapError: failure });
  assert.match(receipt.failure, /detached map page/);
  assert.equal(receipt.status, 'FAIL');
  assert.deepEqual(receipt.known_reds, []);
  assert.deepEqual(shots, []);
  assert.equal(closes.browser, 1);
});

test('waiting-card overlap remains a hard failure after KNOWN RED', { timeout: 2000 }, async () => {
  const { receipt, shots } = await execute({ mode, overlap: true });
  assert.equal(receipt.status, 'FAIL');
  assert.equal(receipt.spec8.status, 'FAIL');
  assert.equal(receipt.known_reds.length, 1);
  assert.match(receipt.failure, /Waiting card title overlaps word-plus-age/);
  assert.deepEqual(shots, []);
});

test('missing Dot text remains a hard failure and retains earlier known-red evidence', { timeout: 2000 }, async () => {
  const { receipt, shots } = await execute({ mode, dotError: new Error('Dot text timeout') });
  assert.equal(receipt.status, 'FAIL');
  assert.equal(receipt.spec8.status, 'FAIL');
  assert.equal(receipt.known_reds.length, 1);
  assert.match(receipt.failure, /Dot text timeout/);
  assert.deepEqual(shots, ['dot-home-waiting.png', 'dot-waiting-lane.png']);
});

test('rendered page errors cannot produce a scoped PASS', { timeout: 2000 }, async () => {
  const { receipt } = await execute({ mode, pageError: new Error('render failed') });
  assert.equal(receipt.status, 'FAIL');
  assert.equal(receipt.spec8.status, 'FAIL');
  assert.equal(receipt.passed, false);
  assert.match(receipt.failure, /Rendered route emitted page errors/);
  assert.deepEqual(receipt.errors, ['Error: render failed']);
});
