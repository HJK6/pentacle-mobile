#!/usr/bin/env node
'use strict';
// Captures the actual route from reducer-seeded synthetic fixtures, not native touch proof.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
// PENTACLE_RENDER_MODE=dot runs the scoped checks; the old mode name remains an
// alias, but no longer waives map failures. A scoped receipt is never a full-driver PASS.
const requestedMode = process.env.PENTACLE_RENDER_MODE || 'default';
assert(['default', 'dot', 'dot-with-known-map-red'].includes(requestedMode), 'Unknown lanes render mode');
const scoped = requestedMode !== 'default', mode = scoped ? 'dot' : 'default';
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.PENTACLE_RENDER_OUTPUT || '');
const url = new URL(process.env.PENTACLE_RENDER_URL || 'http://127.0.0.1:8081');
assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Use the admitted local screenshot server');
assert(process.env.PENTACLE_RENDER_OUTPUT && output !== root && !output.startsWith(root + path.sep), 'Render evidence must stay outside the repository');
fs.mkdirSync(output, { recursive: true });
const receipt = {
  kind: 'readable-lanes-render', evidence_class: 'Supplemental fixture renders, not native touch proof',
  widths: [], maps: [], map_coverage: [], screenshots: [], errors: [], known_reds: [],
  map_rule: { ref: 'assistant-direct-c089c686', requirement: 'Visible named lanes plus +N overflow account for every non-parked lane',
    design_revision: '9a8affbae054b814b2ee102402f214a9eea210842bb9152f1e746d17925c28df' },
  superseded_reds: [{
    status: 'SUPERSEDED', former_status: 'KNOWN RED', check: 'map.non-parked-lane-count',
    work_item: 'pentacle-mobile__lanes_map_show_all_non_parked_2026_11',
    disposition: 'Historical no-overflow oracle superseded by operator correction; work item closure belongs to the release owner.',
    superseded_by: 'assistant-direct-c089c686',
    observed: { actual: 12, expected: 20, width: 390, fixture: 'roadmap_views' },
    rule: { ref: '67898c29', status: 'SUPERSEDED' },
    evidence: { description: 'Historical base and candidate diagnosis receipts; not a current product failure',
      base: 'cfccc24c6b3a7315f43c24aa9100ce7287909325', candidate: '1280be28846e6ad398f37438b49bde0fb67fc571',
      sha256: 'debfb35fd3fb4380a7aad7c21982bac4c6fc7e77230a3cf94a7d17aa6b443ffa' },
  }],
};
if (scoped) Object.assign(receipt, {
  mode, requested_mode: requestedMode, scope: '390x844 map accounting/geometry/overlap and spec 8 Dot display only',
  spec8: { status: 'NOT EXECUTED', checks: [] },
  not_executed: [
    { check: 'default.other-viewports', details: '375/430 map checks and 375 goal/spec bar containment' },
    { check: 'default.map-label-overlap', details: 'roadmap_views at 375 (390 runs in scoped mode)' },
    { check: 'default.roadmap-busy', details: '13-lane count, parked exclusion, label overlap and outer-lane navigation' },
    { check: 'default.roadmap-views-journeys', details: 'Home/list/question/quiet, lane/blocked lane, goal, Later/Done, item, parked journeys and bar containment' },
    { check: 'default.other-fixtures', details: 'Overflow, loose, loose_done, no_classes, sparse/old missing-field checks and captures' },
    { check: 'default.motion', details: 'Motion-enabled home/lane captures' },
  ].map(entry => ({ ...entry, reason: 'Outside explicitly selected Dot-only scope' })),
});
// Screens stay mounted under the top one, so every locator targets the visible copy.
const tid = id => `[data-testid="${id}"]:visible`;
const lane = n => `road-lane-views-${n}`;
async function shot(page, name) {
  const file = path.join(output, `${name}.png`);
  await page.waitForTimeout(150);
  await page.screenshot({ path: file });
  receipt.screenshots.push({ name, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
}
async function seed(page, variant) {
  assert(await page.evaluate(v => window.__pentacleHarness.seed('lanes', v), variant), `Fixture ${variant} was not installed`);
  await page.locator(tid('readable-home')).waitFor();
}
const rect = async locator => locator.evaluate(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
const centre = r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const near = (a, b, tolerance, message) => assert(Math.abs(a - b) <= tolerance, `${message}: ${a.toFixed(2)} vs ${b.toFixed(2)}`);
async function checkLabels(page, width) {
  const labels = await page.locator('[data-testid^="lanes-map-label-"]:visible').evaluateAll(nodes => nodes.map(node => {
    const r = node.getBoundingClientRect(); return { id: node.dataset.testid, x: r.x, y: r.y, width: r.width, height: r.height };
  }));
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
    const a = labels[i], b = labels[j];
    assert(!(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height), `Overlapping labels at ${width}: ${a.id}, ${b.id}`);
  }
  receipt.widths.push({ width, labels: labels.length, overlap: false });
}
/** Account for both overflow tones; reject duplicate/unknown names and chips before totaling. */
async function checkMapCoverage(page, width, fixture, total, busy) {
  const prefix = `road-lane-${fixture.slice('roadmap_'.length)}-`;
  const expected = new Set(Array.from({ length: total }, (_, i) => `${prefix}${i + 1}`));
  const busyIds = new Set(Array.from({ length: busy }, (_, i) => `${prefix}${i + 1}`));
  const nodes = await page.locator('[data-testid^="lanes-map-lane-"]:visible').evaluateAll(list => list.map(n => n.dataset.testid));
  const visible = nodes.map(id => id.slice('lanes-map-lane-'.length));
  assert.equal(new Set(visible).size, visible.length, 'Duplicate named lanes on map');
  for (const id of visible) assert(expected.has(id), `Unexpected named lane ${id} in ${fixture}`);
  const overflow = await page.locator('[data-testid^="lanes-map-more"]:visible').evaluateAll(list => list.map(n => ({
    id: n.dataset.testid, text: n.textContent.trim(), label: n.getAttribute('aria-label'),
  })));
  assert.equal(new Set(overflow.map(chip => chip.id)).size, overflow.length, 'Duplicate overflow chips');
  const counts = { busy: 0, quiet: 0 };
  for (const chip of overflow) {
    assert(['lanes-map-more', 'lanes-map-more-busy'].includes(chip.id), `Unexpected overflow chip ${chip.id}`);
    assert(/^\+[1-9]\d*$/.test(chip.text), `Invalid overflow count ${chip.text}`);
    const count = Number(chip.text.slice(1));
    assert(Number.isSafeInteger(count), `Invalid overflow count ${chip.text}`);
    assert.equal(chip.label, `${count} more lanes`, 'Overflow label disagrees with visible count');
    counts[chip.id === 'lanes-map-more-busy' ? 'busy' : 'quiet'] += count;
  }
  const namedBusy = visible.filter(id => busyIds.has(id)).length;
  assert.equal(namedBusy + counts.busy, busy, 'Busy lane accounting: visible names plus overflow must cover every busy lane once');
  assert.equal(visible.length - namedBusy + counts.quiet, total - busy, 'Quiet lane accounting: visible names plus overflow must cover every quiet lane once');
  assert.equal(visible.length + counts.busy + counts.quiet, total, 'Non-parked lane accounting is incomplete or double-counted');
  receipt.map_coverage.push({ fixture, width, visible, overflow, total, busy, quiet: total - busy, status: 'PASS' });
  return nodes;
}
/** The hub sits at the centre of the lane ring circle; every link runs from the hub's edge to the ring's edge. */
async function checkMap(page, width) {
  const hub = await rect(page.locator(tid('lanes-map-assistant'))), hc = centre(hub);
  const nodes = await checkMapCoverage(page, width, 'roadmap_views', 20, 7);
  assert(!(await page.locator(tid('lanes-constellation')).innerText()).split('\n').some(line => /^paused(?: ·|$)/i.test(line)));
  const inner = [];
  for (const id of nodes) {
    const laneId = id.slice('lanes-map-lane-'.length);
    // Link ends are zero-size markers, which Playwright never counts as visible; scope them to the visible home.
    const marker = name => page.locator(tid('readable-home')).locator(`[data-testid="${name}"]`);
    if (!(await marker(`lanes-map-link-${laneId}`).count())) continue;
    const ring = await rect(page.locator(tid(id))), rc = centre(ring);
    const from = await rect(marker(`lanes-map-link-${laneId}`)), to = await rect(marker(`lanes-map-link-end-${laneId}`));
    near(Math.hypot(from.x - hc.x, from.y - hc.y), hub.width / 2, 1, `${width} ${laneId} link start off the hub edge`);
    near(Math.hypot(to.x - rc.x, to.y - rc.y), ring.width / 2, 1, `${width} ${laneId} link end off the ring edge`);
    near(ring.width, hub.width, 0.5, `${width} hub and ring sizes differ`);
    inner.push(Math.hypot(rc.x - hc.x, rc.y - hc.y));
  }
  assert.equal(inner.length, 6, `${width}: expected six lanes on the inner ring, saw ${inner.length}`);
  for (const d of inner) near(d, inner[0], 1, `${width} hub is not the centre of the lane ring circle`);
  receipt.maps.push({ width, hub: hub.width, inner: inner.length, radius: inner[0] });
}
/** A bar label stays whole and inside the screen's side gutter. */
async function checkLabel(page, id, width) {
  const box = await page.locator(tid(id)).evaluate(node => { const r = node.getBoundingClientRect(); return { right: r.right, clipped: node.scrollWidth > node.clientWidth + 0.5 }; });
  assert(!box.clipped && box.right <= width - 16 + 0.5, `${id} clipped at ${width}: ${JSON.stringify(box)}`);
  receipt.labels = [...(receipt.labels || []), { id, width, right: box.right }];
}
/** Added lane words share the existing age slot without colliding with a long title. */
async function checkWaitingCard(page) {
  const card = page.locator(tid('lane-card-sample-lane-1'));
  await card.scrollIntoViewIfNeeded();
  const title = await rect(card.getByText('Prepare the next release and verify every supported client', { exact: true }));
  const word = await rect(card.getByText('waiting on Dot · 3h', { exact: true }));
  const bounds = await rect(card);
  for (const [name, box] of [['title', title], ['word-plus-age', word]]) {
    assert(box.x >= bounds.x - 0.5 && box.x + box.width <= bounds.x + bounds.width + 0.5
      && box.y >= bounds.y - 0.5 && box.y + box.height <= bounds.y + bounds.height + 0.5,
    `Waiting card ${name} escapes card: ${JSON.stringify({ box, bounds })}`);
  }
  assert(!(title.x < word.x + word.width && word.x < title.x + title.width
    && title.y < word.y + word.height && word.y < title.y + title.height), 'Waiting card title overlaps word-plus-age');
  receipt.waitingCard = { title, word, bounds, overlap: false };
}
async function open(page, id, screen) { const target = page.locator(tid(id)); await target.scrollIntoViewIfNeeded(); await target.click(); await page.locator(tid(screen)).waitFor(); }
async function back(page) { await page.locator(tid('lanes-back')).click(); await page.waitForTimeout(50); }
async function checkDot(page) {
  await seed(page, 'readable_dot');
  await checkWaitingCard(page);
  await shot(page, 'dot-home-waiting');
  await open(page, 'lane-row-sample-lane-1', 'readable-lane');
  await page.getByText('waiting on Dot · 3h ago', { exact: true }).waitFor();
  await shot(page, 'dot-waiting-lane');
  await back(page);
  await open(page, 'lane-row-sample-lane-4', 'readable-lane');
  await open(page, 'goal-head-g_sample_3_0', 'readable-goal');
  await page.locator(tid('spec-row-spec_sample__flow_9')).getByText('Waiting for Dot', { exact: true }).waitFor();
  await shot(page, 'dot-goal');
  await open(page, 'spec-row-spec_sample__flow_1', 'readable-spec');
  const item = page.locator(tid('readable-spec'));
  await item.getByText('1 on it now', { exact: false }).waitFor();
  await item.getByText('Lead reported done · 2h ago', { exact: true }).waitFor();
  assert.equal(await item.getByText('Dot', { exact: true }).count(), 0, 'Item screen has a separate Dot row');
  const now = await rect(item.getByText('Now', { exact: true }));
  const latest = await rect(item.getByText('Latest', { exact: true }));
  assert(now.y < latest.y, 'Now / Latest row order changed');
  await shot(page, 'dot-item');
  await back(page); await back(page); await back(page);
}
/** Scoped mode uses the same map checks as default; no known-red bypass remains. */
async function scopedDotRun(page, width) {
  await checkMap(page, width);
  await checkLabels(page, width);
  receipt.spec8.status = 'RUNNING';
  try {
    await checkDot(page);
    assert.deepEqual(receipt.errors, [], 'Rendered route emitted page errors');
    receipt.spec8 = { status: 'PASS', width, height: 844,
      checks: ['Waiting card containment and title/word-plus-age overlap', 'Waiting lane header',
        'Queued Waiting for Dot row', 'Working Dot counted on the item and no separate Dot row', 'Now / Latest row order', 'Four Dot screenshots'] };
  } catch (error) {
    receipt.spec8.status = 'FAIL';
    throw error;
  }
}
async function run() {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [390, 375, 430]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
      page.on('pageerror', error => receipt.errors.push(String(error)));
      await page.goto(new URL('/pentacle/lanes', url).toString());
      await page.waitForFunction(() => typeof window.__pentacleHarness?.seed === 'function');
      await page.addStyleTag({ content: '[data-testid="voice-recording-overlay"] { display: none !important; }' });
      await seed(page, 'roadmap_views');
      await page.evaluate(() => document.fonts.ready);
      if (scoped) {
        await scopedDotRun(page, width);
        await page.close();
        return;
      }
      await checkMap(page, width);
      if (width !== 430) await checkLabels(page, width);
      if (width === 375) {
        await open(page, `lane-row-${lane(1)}`, 'readable-lane');
        await open(page, 'goal-head-g_road_views_1_5', 'readable-goal');
        await checkLabel(page, 'goal-bar-label', width);
        await open(page, 'spec-row-spec_road__views_1_23', 'readable-spec');
        await checkLabel(page, 'spec-bar-label', width);
      }
      if (width !== 390) { await page.close(); continue; }
      await seed(page, 'roadmap_busy');
      await checkMapCoverage(page, width, 'roadmap_busy', 13, 13);
      assert.equal(await page.locator(tid('lanes-map-lane-road-lane-busy-14')).count(), 0);
      await checkLabels(page, width);
      await open(page, 'lanes-map-lane-road-lane-busy-13', 'readable-lane');
      await back(page);
      await seed(page, 'roadmap_views');
      await shot(page, 'home');
      await page.locator(tid('readable-section-working-now')).evaluate(node => node.scrollIntoView());
      await shot(page, 'home-list');
      await page.locator(tid(`lane-question-button-${lane(2)}`)).click();
      await page.locator(tid(`lane-question-expanded-${lane(2)}`)).waitFor();
      await page.locator(tid(`lane-row-${lane(2)}`)).evaluate(node => node.scrollIntoView());
      await shot(page, 'home-question-expanded');
      await page.locator(tid(`lane-question-button-${lane(2)}`)).click();
      await page.locator(tid('readable-section-idle')).evaluate(node => node.scrollIntoView());
      await shot(page, 'home-quiet');
      await open(page, `lane-row-${lane(1)}`, 'readable-lane');
      await shot(page, 'lane');
      await page.locator(tid('goal-head-g_road_views_1_5')).evaluate(node => node.scrollIntoView());
      await shot(page, 'lane-blocked');
      await open(page, 'goal-head-g_road_views_1_3', 'readable-goal');
      await shot(page, 'goal');
      await checkLabel(page, 'goal-bar-label', width);
      await page.locator(tid('goal-done-open')).click();
      await page.locator(tid('readable-section-later')).evaluate(node => node.scrollIntoView());
      await shot(page, 'goal-later-done');
      await open(page, 'spec-row-spec_road__views_1_17', 'readable-spec');
      await shot(page, 'item-done');
      await back(page);
      await open(page, 'spec-row-spec_road__views_1_9', 'readable-spec');
      await shot(page, 'item');
      await back(page); await back(page);
      await open(page, 'goal-head-g_road_views_1_5', 'readable-goal');
      await open(page, 'spec-row-spec_road__views_1_23', 'readable-spec');
      await shot(page, 'item-blocked');
      await checkLabel(page, 'spec-bar-label', width);
      await back(page); await back(page); await back(page);
      await open(page, `lane-row-${lane(2)}`, 'readable-lane');
      await shot(page, 'lane-question');
      await back(page);
      await open(page, 'parked-button', 'readable-parked');
      await shot(page, 'parked');
      await open(page, `parked-lane-${lane(21)}`, 'readable-lane');
      await shot(page, 'lane-parked');
      await back(page); await back(page);
      for (const [variant, laneId] of [['roadmap_overflow', 'road-lane-overflow-1'], ['roadmap_loose', 'road-lane-loose-1'], ['roadmap_loose_done', 'road-lane-loose_done-1'], ['roadmap_no_classes', 'road-lane-no_classes-1']]) {
        await seed(page, variant);
        await shot(page, `${variant}-home`);
        await open(page, `lane-row-${laneId}`, 'readable-lane');
        if (variant === 'roadmap_loose_done') await page.locator(tid('finished-earlier-open')).click();
        await shot(page, `${variant}-lane`);
        await back(page);
      }
      await checkDot(page);
      for (const variant of ['readable_sparse', 'readable_old']) {
        await seed(page, variant);
        await open(page, 'lane-row-sample-lane-4', 'readable-lane');
        await open(page, 'goal-head-g_sample_3_0', 'readable-goal');
        await open(page, 'spec-row-spec_sample__flow_1', 'readable-spec');
        assert.equal(await page.getByText('Make the release checks reliable.').count(), 0, `${variant} invented a summary`);
        assert.equal(await page.getByText('Review window requested.', { exact: false }).count(), 0, `${variant} invented recent data`);
        await shot(page, `${variant}-spec`);
        await back(page); await back(page); await back(page);
      }
      await page.close();
    }
    const motion = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, reducedMotion: 'no-preference' });
    motion.on('pageerror', error => receipt.errors.push(String(error)));
    await motion.goto(new URL('/pentacle/lanes', url).toString());
    await motion.waitForFunction(() => typeof window.__pentacleHarness?.seed === 'function');
    await motion.addStyleTag({ content: '[data-testid="voice-recording-overlay"] { display: none !important; }' });
    await seed(motion, 'roadmap_views');
    await shot(motion, 'motion-home');
    await open(motion, `lane-row-${lane(1)}`, 'readable-lane');
    await motion.waitForTimeout(900);
    await shot(motion, 'motion-lane');
    await motion.close();
    assert.deepEqual(receipt.errors, [], 'Rendered route emitted page errors');
  } finally { await browser.close(); }
}
run().then(() => {
  if (scoped) {
    receipt.passed = false;
    receipt.status = 'SCOPED ONLY';
    receipt.failure = 'Scoped run only; default driver checks remain unexecuted. Historical map red is superseded, not waived.';
    process.exitCode = 1;
  } else receipt.passed = true;
}).catch(error => {
  receipt.passed = false;
  if (scoped) receipt.status = 'FAIL';
  receipt.failure = String(error.stack || error);
  process.exitCode = 1;
}).finally(() => fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2)));
