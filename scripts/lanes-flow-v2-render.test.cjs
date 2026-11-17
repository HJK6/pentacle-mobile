'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const driver = path.join(__dirname, 'lanes-flow-v2-render.cjs');
const source = fs.readFileSync(driver, 'utf8');
const views = n => Array.from({ length: n }, (_, i) => `road-lane-views-${i + 1}`);
const chip = (id, count) => ({ id, text: `+${count}`, label: `${count} more lanes` });
// Run the actual driver, replacing only browser/filesystem boundaries. No browser,
// server, child process, real screenshot or network is used by these tests.
async function execute({ mode, nodes = views(12), chips = [chip('lanes-map-more', 8)],
  innerCount = 6, mapError, geometryError = false, labelOverlap = false, overlap = false, dotError, pageError, dotRow = false } = {}) {
  const files = new Map(), shots = [], closes = { page: 0, browser: 0 };
  const processStub = { env: { PENTACLE_RENDER_OUTPUT: '/synthetic-render-output', ...(mode ? { PENTACLE_RENDER_MODE: mode } : {}) }, exitCode: undefined };
  let resolveReceipt;
  const completed = new Promise(resolve => { resolveReceipt = resolve; });
  const box = (x, y, width, height) => ({ x, y, width, height, right: x + width, bottom: y + height });
  const browser = {
    async newPage({ viewport }) {
      let fixture = 'roadmap_views', onPageError;
      const currentNodes = () => fixture === 'roadmap_busy' ? Array.from({ length: 13 }, (_, i) => `road-lane-busy-${i + 1}`) : nodes;
      const currentChips = () => fixture === 'roadmap_busy' ? [] : chips;
      const hub = { x: viewport.width / 2, y: 220 }, radius = 98, size = 46;
      const bounds = (selector, text) => {
        if (text) return text === 'Prepare the next release and verify every supported client' ? box(64, 90, 140, 42)
          : text === 'waiting on Dot · 3h' ? box(overlap ? 100 : 214, 90, 140, 14)
            : box(16, text === 'Now' ? 130 : 160, 80, 20);
        if (selector.includes('lane-card-')) return box(16, 80, 358, 100);
        if (selector.includes('lanes-map-assistant')) return box(hub.x - size / 2, hub.y - size / 2, size, size);
        const match = selector.match(/lanes-map-(lane|link-end|link)-(road-lane-[a-z]+-\d+)/);
        if (match) {
          const i = currentNodes().indexOf(match[2]), angle = i * Math.PI * 2 / innerCount;
          const distance = match[1] === 'link' ? size / 2 : match[1] === 'link-end' ? radius - size / 2 : radius;
          const x = hub.x + distance * Math.cos(angle), y = hub.y + distance * Math.sin(angle);
          return match[1] === 'lane' ? box(x - size / 2, y - size / 2, geometryError ? size + 4 : size, size) : box(x, y, 0, 0);
        }
        return box(16, 20, 100, 20);
      };
      const locator = (selector, text) => ({
        async evaluate(fn) {
          if (selector.includes('lanes-map-assistant') && mapError) throw mapError;
          return fn({ getBoundingClientRect: () => bounds(selector, text), scrollIntoView() {}, scrollWidth: 100, clientWidth: 100 });
        },
        async evaluateAll(fn) {
          if (selector.includes('lanes-map-more')) return fn(currentChips().map(entry => ({ dataset: { testid: entry.id }, textContent: entry.text,
            getAttribute(name) { return name === 'aria-label' ? entry.label : null; } })));
          return fn(currentNodes().map((id, i) => ({ dataset: { testid: `${selector.includes('lanes-map-label-') ? 'lanes-map-label-' : 'lanes-map-lane-'}${id}` },
            getBoundingClientRect: () => box(16, labelOverlap ? 10 : 10 + i * 40, 80, 20) })));
        },
        async count() {
          const link = selector.match(/lanes-map-link-(road-lane-[a-z]+-\d+)/);
          if (link) { const i = currentNodes().indexOf(link[1]); return i >= 0 && i < innerCount ? 1 : 0; }
          if (selector.includes('lanes-map-more')) return currentChips().filter(c => selector.includes(`"${c.id}"`)).length;
          if (selector.includes('lanes-map-lane-road-lane-busy-14')) return 0;
          if (dotRow && text === 'Dot') return 1;
          return 0;
        },
        async innerText() { return ''; }, async scrollIntoViewIfNeeded() {}, async click() {},
        async waitFor() { if (text === 'Waiting for Dot' && dotError) throw dotError; },
        getByText(value) { return locator(selector, value); }, locator(child) { return locator(child); },
      });
      return {
        locator, getByText(text) { return locator('', text); },
        on(name, callback) { if (name === 'pageerror') onPageError = callback; },
        async goto() {}, async waitForFunction() {}, async addStyleTag() {}, async waitForTimeout() {},
        async evaluate(_fn, arg) { if (typeof arg === 'string') fixture = arg; return true; },
        async screenshot({ path: output }) {
          shots.push(path.basename(output)); files.set(output, Buffer.from(`synthetic:${output}`));
          if (pageError && output.endsWith('dot-item.png')) onPageError(pageError);
        },
        async close() { closes.page++; },
      };
    },
    async close() { closes.browser++; },
  };
  const modules = {
    'node:assert/strict': assert, 'node:path': path, 'node:crypto': crypto,
    'node:fs': { mkdirSync() {}, readFileSync(file) { assert(files.has(file)); return files.get(file); },
      writeFileSync(file, data) { files.set(file, data); if (file.endsWith('receipt.json')) resolveReceipt(JSON.parse(data)); } },
    playwright: { chromium: { async launch() { return browser; } } },
  };
  vm.runInNewContext(source, { require(name) { assert(Object.hasOwn(modules, name)); return modules[name]; },
    __dirname, process: processStub, URL, Buffer, console }, { filename: driver, timeout: 1000 });
  return { receipt: await completed, exitCode: processStub.exitCode, shots, closes };
}

for (const [name, options] of [
  ['overflow', {}], ['no overflow', { nodes: views(20), chips: [] }],
  ['busy and quiet overflow', { nodes: views(6), chips: [chip('lanes-map-more-busy', 1), chip('lanes-map-more', 13)] }],
]) test(`default validates ${name}, six inner links, geometry and full driver checks`, { timeout: 2000 }, async () => {
  const { receipt, exitCode, shots, closes } = await execute(options);
  assert.equal(receipt.passed, true, receipt.failure);
  assert.equal(exitCode, undefined);
  assert.equal(receipt.maps.length, 3);
  assert(receipt.maps.every(map => map.inner === 6));
  assert.equal(receipt.map_coverage[0].total, 20);
  assert.equal(receipt.map_coverage[0].visible.length, options.nodes?.length ?? 12);
  assert.equal(receipt.map_coverage.at(-1).total, 20);
  assert(receipt.map_coverage.some(map => map.fixture === 'roadmap_busy' && map.total === 13));
  assert.equal(receipt.widths.length, 3);
  assert(shots.includes('dot-item.png') && shots.includes('motion-lane.png') && shots.includes('readable_old-spec.png'));
  assert.deepEqual(closes, { page: 4, browser: 1 });
});

for (const mode of ['dot', 'dot-with-known-map-red']) test(`${mode} retains corrected provenance and scoped Dot proof without a live known-red waiver`, { timeout: 2000 }, async () => {
  const { receipt, exitCode, shots } = await execute({ mode });
  assert.equal(receipt.mode, 'dot');
  assert.equal(receipt.requested_mode, mode);
  assert.equal(receipt.status, 'SCOPED ONLY');
  assert.equal(receipt.passed, false);
  assert.equal(exitCode, 1);
  assert.equal(receipt.spec8.status, 'PASS');
  assert.deepEqual(receipt.known_reds, []);
  assert.equal(receipt.superseded_reds[0].status, 'SUPERSEDED');
  assert.equal(receipt.superseded_reds[0].work_item, 'pentacle-mobile__lanes_map_show_all_non_parked_2026_11');
  assert.equal(receipt.superseded_reds[0].superseded_by, 'assistant-direct-c089c686');
  assert.equal(receipt.superseded_reds[0].rule.ref, '67898c29');
  assert.equal(receipt.superseded_reds[0].evidence.sha256, 'debfb35fd3fb4380a7aad7c21982bac4c6fc7e77230a3cf94a7d17aa6b443ffa');
  assert.equal(receipt.map_rule.ref, 'assistant-direct-c089c686');
  assert.equal(receipt.maps[0].inner, 6);
  assert.equal(receipt.widths.length, 1);
  assert(receipt.not_executed.some(entry => entry.check === 'default.other-viewports'));
  assert(!receipt.not_executed.some(entry => entry.reason.includes('KNOWN RED')));
  assert.deepEqual(shots, ['dot-home-waiting.png', 'dot-waiting-lane.png', 'dot-goal.png', 'dot-item.png']);
  assert.equal(receipt.waitingCard.overlap, false);
});

for (const [name, options, failure] of [
  ['missing lane', { chips: [chip('lanes-map-more', 7)] }, /Quiet lane accounting/],
  ['double-counted overflow', { chips: [chip('lanes-map-more', 9)] }, /Quiet lane accounting/],
  ['duplicate named lane', { nodes: [...views(11), 'road-lane-views-1'] }, /Duplicate named lanes/],
  ['unknown or parked named lane', { nodes: [...views(11), 'road-lane-views-21'] }, /Unexpected named lane/],
  ['duplicate overflow chip', { chips: [chip('lanes-map-more', 4), chip('lanes-map-more', 4)] }, /Duplicate overflow/],
  ['balanced missing quiet and double-counted busy', { chips: [chip('lanes-map-more-busy', 1), chip('lanes-map-more', 7)] }, /Busy lane accounting/],
  ['malformed overflow', { chips: [{ id: 'lanes-map-more', text: '+8x', label: '8 more lanes' }] }, /Invalid overflow count/],
  ['inconsistent accessible count', { chips: [{ id: 'lanes-map-more', text: '+8', label: '7 more lanes' }] }, /Overflow label/],
]) test(`default and legacy scoped mode reject ${name}`, { timeout: 2000 }, async () => {
  for (const mode of [undefined, 'dot-with-known-map-red']) {
    const { receipt, exitCode } = await execute({ ...options, mode });
    assert.equal(receipt.passed, false);
    assert.equal(exitCode, 1);
    assert.match(receipt.failure, failure);
    assert.deepEqual(receipt.known_reds, []);
    if (mode) { assert.equal(receipt.status, 'FAIL'); assert.equal(receipt.spec8.status, 'NOT EXECUTED'); }
  }
});

for (const innerCount of [5, 7]) test(`wrong inner cardinality ${innerCount} fails`, { timeout: 2000 }, async () => {
  const { receipt } = await execute({ mode: 'dot', innerCount });
  assert.match(receipt.failure, /expected six lanes on the inner ring/);
  assert.equal(receipt.spec8.status, 'NOT EXECUTED');
});

for (const [options, failure] of [
  [{ mapError: new Error('detached map page') }, /detached map page/],
  [{ geometryError: true }, /off the ring edge|hub and ring sizes differ/],
  [{ labelOverlap: true }, /Overlapping labels/],
  [{ overlap: true }, /Waiting card title overlaps word-plus-age/],
  [{ dotError: new Error('Dot text timeout') }, /Dot text timeout/],
  [{ dotRow: true }, /separate Dot row/],
  [{ pageError: new Error('render failed') }, /Rendered route emitted page errors/],
]) test(`scoped mode preserves hard failure ${failure}`, { timeout: 2000 }, async () => {
  const { receipt, closes } = await execute({ mode: 'dot', ...options });
  assert.equal(receipt.status, 'FAIL');
  assert.equal(receipt.passed, false);
  assert.match(receipt.failure, failure);
  assert.notEqual(receipt.spec8.status, 'PASS');
  assert.equal(closes.browser, 1);
});
