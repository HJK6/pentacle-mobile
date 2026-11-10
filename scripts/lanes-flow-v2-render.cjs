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
const receipt = { kind: 'readable-lanes-render', evidence_class: 'Supplemental fixture renders, not native touch proof', widths: [], screenshots: [], errors: [] };
const tid = id => `[data-testid="${id}"]`;
async function shot(page, name) {
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file });
  receipt.screenshots.push({ name, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
}
async function seed(page, variant) {
  assert(await page.evaluate(v => window.__pentacleHarness.seed('lanes', v), variant), `Fixture ${variant} was not installed`);
  await page.locator(tid('readable-home')).waitFor();
}
async function checkLabels(page, width) {
  const labels = await page.locator('[data-testid^="lanes-map-label-"]').evaluateAll(nodes => nodes.map(node => {
    const r = node.getBoundingClientRect(); return { id: node.dataset.testid, x: r.x, y: r.y, width: r.width, height: r.height };
  }));
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
    const a = labels[i], b = labels[j];
    assert(!(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height), `Overlapping labels at ${width}: ${a.id}, ${b.id}`);
  }
  receipt.widths.push({ width, labels, overlap: false });
}
async function openLane(page, id) { const row = page.locator(tid(`lane-row-${id}`)); await row.scrollIntoViewIfNeeded(); await row.click(); await page.locator(tid('readable-lane')).waitFor(); }
async function back(page) { await page.locator(tid('lanes-back')).click(); }
async function run() {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [390, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
      page.on('pageerror', error => receipt.errors.push(String(error)));
      await page.goto(new URL('/pentacle/lanes', url).toString());
      await page.waitForFunction(() => typeof window.__pentacleHarness?.seed === 'function');
      await page.addStyleTag({ content: '[data-testid="voice-recording-overlay"] { display: none !important; }' });
      await seed(page, 'readable_full');
      await page.evaluate(() => document.fonts.ready);
      await checkLabels(page, width);
      await shot(page, `${width}-home`);
      await page.locator(tid('lane-row-sample-lane-4')).scrollIntoViewIfNeeded();
      await shot(page, `${width}-home-list`);
      await openLane(page, 'sample-lane-4');
      await shot(page, `${width}-lane`);
      await page.locator(tid('goal-head-g_sample_3_0')).click();
      await page.locator(tid('readable-goal')).waitFor();
      await shot(page, `${width}-goal`);
      await page.locator(tid('spec-row-spec_sample__flow_1')).click();
      await page.locator(tid('readable-spec')).waitFor();
      await shot(page, `${width}-spec-question`);
      await back(page);
      await page.locator(tid('spec-row-spec_sample__flow_4')).click();
      await page.locator(tid('readable-spec')).waitFor();
      await shot(page, `${width}-spec`);
      await back(page);
      await page.locator(tid('spec-row-spec_sample__flow_3')).click();
      await page.locator(tid('readable-spec')).waitFor();
      await shot(page, `${width}-spec-trouble`);
      await back(page); await back(page); await back(page);
      await openLane(page, 'sample-lane-2');
      await shot(page, `${width}-stalled-lane`);
      await back(page);
      for (const variant of ['readable_sparse', 'readable_old']) {
        await seed(page, variant);
        await openLane(page, 'sample-lane-4');
        await shot(page, `${width}-${variant}`);
        await back(page);
      }
      await page.close();
    }
    assert.deepEqual(receipt.errors, [], 'Rendered route emitted page errors');
  } finally { await browser.close(); }
}
run().then(() => { receipt.passed = true; }).catch(error => { receipt.passed = false; receipt.failure = String(error.stack || error); process.exitCode = 1; }).finally(() => fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2)));
