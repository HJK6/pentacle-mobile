#!/usr/bin/env node
"use strict";
// Scoped render journey, separate from the native certification runner.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
const output = path.resolve(process.env.PENTACLE_RENDER_OUTPUT || "");
const url = new URL(process.env.PENTACLE_RENDER_URL || "http://127.0.0.1:8081");
assert(
  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
  "Use the admitted local screenshot server",
);
assert(
  process.env.PENTACLE_RENDER_OUTPUT &&
    output !== root &&
    !output.startsWith(root + path.sep),
  "Raw render evidence must stay outside the repository",
);
fs.mkdirSync(output, { recursive: true });
const receipt = {
  kind: "lanes-flow-v2-render",
  source: require("node:child_process")
    .execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
    .trim(),
  widths: [],
  screenshots: [],
  errors: [],
};
const tid = (id) => `[data-testid="${id}"]`;
async function shot(page, name) {
  await page.waitForTimeout(300); // Settle the sheet's 240 ms native-style transition.
  const file = path.join(output, name + ".png");
  await page.screenshot({ path: file });
  receipt.screenshots.push({
    name,
    sha256: crypto
      .createHash("sha256")
      .update(fs.readFileSync(file))
      .digest("hex"),
  });
}
async function seed(page, variant) {
  assert(
    await page.evaluate(
      (variant) => window.__pentacleHarness.seed("lanes", variant),
      variant,
    ),
    "Fixture was not installed",
  );
  await page.locator(tid("lanes-map")).waitFor();
}
async function run() {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [390, 375]) {
      const page = await browser.newPage({
        viewport: { width, height: 844 },
        deviceScaleFactor: 2,
        reducedMotion: "reduce",
      });
      page.on("pageerror", (error) => receipt.errors.push(String(error)));
      await page.goto(new URL("/pentacle/lanes", url).toString());
      await page.waitForFunction(() => !!window.__pentacleHarness?.ready);
      await seed(page, "flow_v2");
      await page.evaluate(() => document.fonts.ready);
      await page.locator('[data-testid^="lanes-map-label-"]').first().waitFor();
      const labels = await page
        .locator('[data-testid^="lanes-map-label-"]')
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const r = node.getBoundingClientRect();
            return {
              id: node.dataset.testid,
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
            };
          }),
        );
      assert.equal(
        labels.length,
        6,
        "Six actual label rectangles are required",
      );
      for (let i = 0; i < labels.length; i++)
        for (let j = i + 1; j < labels.length; j++) {
          const a = labels[i],
            b = labels[j];
          assert(
            !(
              a.x < b.x + b.width &&
              b.x < a.x + a.width &&
              a.y < b.y + b.height &&
              b.y < a.y + a.height
            ),
            `Overlapping labels at ${width}: ${a.id}, ${b.id}`,
          );
        }
      receipt.widths.push({ width, labels, overlap: false });
      await shot(page, width + "-map-peek");
      await page.locator(tid("lanes-sheet-handle")).click();
      await page.locator(tid("lanes-header-mini-ring")).waitFor();
      await shot(page, width + "-sheet-full");
      await page.locator(tid("lanes-dormant-fold")).click();
      assert.equal(
        await page.locator('[data-testid^="lane-row-"]').count(),
        13,
      );
      await page.locator(tid("lane-row-sample-lane-4")).click();
      await page.locator(tid("spec-done-fold")).waitFor();
      await shot(page, width + "-lane-zoom");
      await page.locator(tid("lanes-sheet-handle")).click();
      await page.locator(tid("spec-done-fold")).scrollIntoViewIfNeeded();
      await page.locator(tid("spec-done-fold")).click();
      await page.locator(tid("spec-row-spec_sample__flow_27")).waitFor();
      await shot(page, width + "-done-unfolded");
      await page.getByRole("button", { name: "Back", exact: true }).click();
      for (const [variant, hasFields] of [
        ["spec_detail_full", true],
        ["spec_detail_sparse", false],
      ]) {
        await seed(page, variant);
        await page
          .locator(tid("lane-row-sample-lane-4"))
          .scrollIntoViewIfNeeded();
        await page.locator(tid("lane-row-sample-lane-4")).click();
        await page.locator(tid("spec-done-fold")).waitFor();
        await page.locator(tid("spec-node-spec_sample__flow_1")).click();
        await page.locator(tid("member-detail-spec_sample__flow_1")).waitFor();
        await page.locator(tid("lanes-sheet-handle")).click();
        for (const field of [
          "member-worked",
          "member-lead",
          "member-lifecycle",
          "member-criteria",
          "member-open-questions",
        ])
          assert.equal(
            await page.locator(tid(field)).count(),
            hasFields ? 1 : 0,
            variant + ": " + field,
          );
        await shot(page, width + "-" + variant);
        await page.getByRole("button", { name: "Back", exact: true }).click();
        await page.getByRole("button", { name: "Back", exact: true }).click();
      }
      await page.close();
    }
    assert.deepEqual(
      receipt.errors,
      [],
      "The real rendered route emitted page errors",
    );
  } finally {
    await browser.close();
  }
}
run()
  .then(() => {
    receipt.passed = true;
  })
  .catch((error) => {
    receipt.passed = false;
    receipt.failure = String(error.stack || error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.writeFileSync(
      path.join(output, "render-receipt.json"),
      JSON.stringify(receipt, null, 2) + "\n",
    );
    process.stdout.write(
      JSON.stringify({
        passed: receipt.passed,
        output,
        widths: receipt.widths.map((row) => row.width),
        screenshots: receipt.screenshots.length,
        failure: receipt.failure,
      }) + "\n",
    );
  });
