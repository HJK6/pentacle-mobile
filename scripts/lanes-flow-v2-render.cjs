#!/usr/bin/env node
'use strict';
// Captures the actual route from reducer-seeded synthetic fixtures, not native touch proof.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.PENTACLE_RENDER_OUTPUT || '');
const url = new URL(process.env.PENTACLE_RENDER_URL || 'http://127.0.0.1:8081');
assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Use the admitted local screenshot server');
assert(process.env.PENTACLE_RENDER_OUTPUT && output !== root && !output.startsWith(root + path.sep), 'Render evidence must stay outside the repository');
fs.mkdirSync(output, { recursive: true });
const receipt = { kind: 'readable-lanes-render', evidence_class: 'Supplemental fixture renders, not native touch proof', widths: [], maps: [], screenshots: [], errors: [] };
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
/** The hub sits at the centre of the lane ring circle; every link runs from the hub's edge to the ring's edge. */
async function checkMap(page, width) {
  const hub = await rect(page.locator(tid('lanes-map-assistant'))), hc = centre(hub);
  const nodes = await page.locator('[data-testid^="lanes-map-lane-"]:visible').evaluateAll(list => list.map(n => n.dataset.testid));
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
  assert(inner.length >= 7, `${width}: expected seven lanes on the inner ring, saw ${inner.length}`);
  for (const d of inner) near(d, inner[0], 1, `${width} hub is not the centre of the lane ring circle`);
  receipt.maps.push({ width, hub: hub.width, inner: inner.length, radius: inner[0] });
}
async function open(page, id, screen) { const target = page.locator(tid(id)); await target.scrollIntoViewIfNeeded(); await target.click(); await page.locator(tid(screen)).waitFor(); }
async function back(page) { await page.locator(tid('lanes-back')).click(); await page.waitForTimeout(50); }
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
      await checkMap(page, width);
      if (width !== 430) await checkLabels(page, width);
      if (width !== 390) { await page.close(); continue; }
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
      await back(page); await back(page); await back(page);
      await open(page, `lane-row-${lane(2)}`, 'readable-lane');
      await shot(page, 'lane-question');
      await back(page);
      await open(page, 'parked-button', 'readable-parked');
      await shot(page, 'parked');
      await open(page, `parked-lane-${lane(12)}`, 'readable-lane');
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
run().then(() => { receipt.passed = true; }).catch(error => { receipt.passed = false; receipt.failure = String(error.stack || error); process.exitCode = 1; }).finally(() => fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2)));
