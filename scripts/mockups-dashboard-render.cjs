#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { webkit } = require('playwright');
const root = path.resolve(__dirname, '..');
const url = new URL(process.env.PENTACLE_RENDER_URL || 'http://127.0.0.1:8081');
const output = path.resolve(process.env.PENTACLE_RENDER_OUTPUT || '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Use the local screenshot server');
assert(process.env.PENTACLE_RENDER_OUTPUT && output !== root && !output.startsWith(root + path.sep), 'Evidence must stay outside the repository');
fs.mkdirSync(output, { recursive: true });
const receipt = {
  kind: 'mockups-dashboard-render',
  evidence_class: 'WebKit phone-size synthetic fixture preflight; NOT physical iPhone/Safari/Tailscale/media proof',
  accommodation: 'FD approved hiding the unrelated voice-recording-overlay storage_unavailable banner in these web-only fixture captures; native proof untouched',
  source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  screenshots: [], handoffs: [], errors: [],
};
const tid = id => `[data-testid="${id}"]`;
async function shot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file });
  receipt.screenshots.push({ name, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
}
async function run() {
  const browser = await webkit.launch({ headless: true });
  try {
    for (const width of [390, 375]) {
      for (const variant of ['mockups', 'empty']) {
        const page = await browser.newPage({ viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
        page.on('pageerror', error => receipt.errors.push(String(error)));
        await page.addInitScript(() => {
          window.__mockupsOpens = [];
          window.__mockupsRefuse = false;
          window.open = url => {
            window.__mockupsOpens.push(url);
            if (window.__mockupsRefuse) { window.__mockupsRefuse = false; throw new Error('Synthetic browser refusal'); }
            return null;
          };
        });
        await page.goto(new URL('/chats', url).toString());
        await page.waitForFunction(() => typeof window.__pentacleHarness?.seed === 'function');
        await page.addStyleTag({ content: '[data-testid="voice-recording-overlay"] { display: none !important; }' });
        assert(await page.evaluate(variant => window.__pentacleHarness.seed('dashboards', variant), variant));
        await page.locator(tid('dashboards-tab-button')).click();
        if (variant === 'empty') {
          await page.locator(tid('dashboards-empty-state')).waitFor();
          assert.equal(await page.locator(tid('dashboard-selector-ui-review')).count(), 0);
          assert.deepEqual(await page.evaluate(() => window.__mockupsOpens), []);
          await shot(page, `empty-${width}`);
        } else {
          const card = page.locator(tid('dashboard-selector-ui-review'));
          await card.waitFor();
          const rect = await card.boundingBox();
          assert(rect && rect.x >= 0 && rect.x + rect.width <= width, 'Mockups card fits the phone width');
          assert.deepEqual(await page.evaluate(() => window.__mockupsOpens), []);
          await shot(page, `mockups-${width}`);
          await page.evaluate(() => { window.__mockupsRefuse = true; });
          await card.click();
          await page.locator(tid('dashboard-hosted-error')).waitFor();
          assert.match(await page.locator(tid('dashboard-hosted-error')).textContent(), /Could not open dashboard/);
          await shot(page, `retry-${width}`);
          await page.locator(tid('dashboard-hosted-open')).click();
          await page.locator(tid('dashboard-hosted-error')).waitFor({ state: 'detached' });
          const opens = await page.evaluate(() => window.__mockupsOpens);
          assert.deepEqual(opens, ['https://chat.example.ts.net/designs/', 'https://chat.example.ts.net/designs/']);
          receipt.handoffs.push({ width, opens });
          await shot(page, `opened-${width}`);
        }
        await page.close();
      }
    }
    assert.deepEqual(receipt.errors, []);
  } finally { await browser.close(); }
}
run().then(() => { receipt.passed = true; }).catch(error => {
  receipt.passed = false; receipt.failure = String(error.stack || error); process.exitCode = 1;
}).finally(() => {
  fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
});
