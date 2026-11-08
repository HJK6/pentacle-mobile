#!/usr/bin/env node
'use strict';
// Supplemental real-screen layout capture. Native keyboard proof remains a separate Release gate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.PENTACLE_RENDER_OUTPUT || '');
const url = new URL(process.env.PENTACLE_RENDER_URL || 'http://127.0.0.1:8097');
assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Use the admitted local screenshot server');
assert(process.env.PENTACLE_RENDER_OUTPUT && output !== root && !output.startsWith(root + path.sep), 'Keep raw evidence outside the repository');
const receipt = {
  kind: 'questions-embedded-render',
  evidence_class: 'Supplemental synthetic fixture: real Assistant components and geometry',
  accommodation: 'Approved supplemental capture accommodation: hide only the unrelated voice-recording-overlay web storage banner. Native Release hides nothing.',
  keyboard: 'Web reduced-viewport approximation with focused composer; real OS keyboard proof is required separately on configured Release.',
  source: require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  widths: [], screenshots: [], errors: [],
};
const tid = id => `[data-testid="${id}"]`;
fs.mkdirSync(output, { recursive: true });
async function shot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file });
  receipt.screenshots.push({ name, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
}
async function gap(page) {
  const card = await page.locator(tid('question-deck-card')).boundingBox();
  const composer = await page.locator(tid('composer-wrap')).boundingBox();
  assert(card && composer && card.height > 100, 'The card must have an intrinsic height');
  const spacing = composer.y - (card.y + card.height);
  assert(spacing >= -1 && spacing <= 16, `Card/composer gap ${spacing} exceeds transcript spacing`);
  return { card, composer, spacing };
}
async function run() {
  const browser = await chromium.launch({ headless: true, ...(process.env.PENTACLE_CHROMIUM_BIN ? { executablePath: process.env.PENTACLE_CHROMIUM_BIN } : {}) });
  try {
    receipt.browser = browser.version();
    for (const width of [390, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
      page.on('pageerror', error => receipt.errors.push(String(error)));
      await page.goto(new URL('/assistant', url).toString());
      await page.locator(tid('question-deck-card')).waitFor();
      await page.addStyleTag({ content: `${tid('voice-recording-overlay')} {display:none !important}` });
      await page.locator(tid('questions-option-1')).click();
      await page.locator(tid('questions-submit-label')).filter({ hasText: 'Submit 1 of 2' }).waitFor();
      await page.waitForTimeout(500);
      const shown = await gap(page);
      const button = page.getByRole('button', { name: 'Questions, 2 pending', exact: true });
      const before = await button.getAttribute('class');
      await shot(page, `${width}-shown`);
      await page.locator(tid('questions-close')).click();
      await page.locator(tid('question-deck-card')).waitFor({ state: 'detached' });
      assert.equal(await page.locator(tid('assistant-questions-badge')).innerText(), '2');
      assert.equal(await button.getAttribute('class'), before, 'Header styling changes when hidden');
      await shot(page, `${width}-hidden-count`);
      await button.click();
      await page.locator(tid('question-deck-card')).waitFor();
      assert.match(await page.locator(tid('questions-submit-label')).innerText(), /Submit 1 of 2/, 'Draft lost after hide');
      assert.equal(new URL(page.url()).pathname, '/assistant', 'Question toggle navigated');
      await page.setViewportSize({ width, height: 552 });
      await page.locator(tid('composer-input')).focus();
      await page.waitForTimeout(600);
      const keyboardViewport = await gap(page);
      await shot(page, `${width}-keyboard-viewport`);
      receipt.widths.push({ width, shown, keyboardViewport });
      await page.close();
    }
    assert.deepEqual(receipt.errors, [], 'Unexpected browser errors');
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
