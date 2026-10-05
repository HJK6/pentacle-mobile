'use strict';

// The actual Expo client against an owned scripted counterpart. All identities
// and auth are synthetic by default; a locally supplied producer stays in artifacts.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { WebSocketServer } = require('ws');
const { chromium, expect } = require('playwright/test');

const root = process.cwd();
const output = path.resolve(process.env.CARD_ROW_ARTIFACT_DIR || '_artifacts/card-row/browser');
const producer = process.env.CARD_ROW_PRODUCER_STREAM_ID || 'hosta:v2-bound';
const composite = process.env.CARD_ROW_SURFACE_STREAM_ID || 'example:assistant';
const title = process.env.CARD_ROW_TITLE || 'Example assistant';
const queueStream = 'hosta:v2-send-probe';
const otherStream = 'hostb:v2-independent';
const fixtureToken = `example-${crypto.randomUUID()}`;
const cardsOnly = process.env.CARD_ROW_CARDS_ONLY === '1';
const wire = [];
const consoleLines = [];
const telemetry = [];
const pageErrors = [];
const wireErrors = [];
const pendingEchoes = new Map();
const history = [];
let sequence = 20;
let expo, browser, daemon, web, activePage;
let stage = 'setup';

function card(index, ownProducer, surface) {
  return {
    notification_id: `fixture-card-${index}`, producer: 'agent_question.v1', state: 'open',
    title: `Fixture decision ${index}`, body: 'Choose a fixture path.', severity: 'info',
    created_at: '2026-10-05T12:00:00Z', updated_at: '2026-10-05T12:00:00Z',
    answer_to_stream_id: ownProducer, ...(surface ? { surfaced_to_stream_id: surface } : {}),
    dedup_key: `fixture-card-${index}`, actions: [{ kind: 'yes_no' }], resolution: null,
    question: { question_id: `fixture-question-${index}`, producer_stream_id: ownProducer,
      response_mode: 'single_choice', options: [{ label: 'Proceed', value: 'proceed' }], state: 'open', answer: null },
    ttl_seconds: 0, expires_at: '', resolved_at: null,
  };
}

const notifications = [1, 2, 3, 4].map((i) => card(i, producer, composite)).concat(card(5, otherStream));
const sessions = [
  { stream_id: composite, host: composite.split(':')[0], provider: 'composite', session_name: 'assistant',
    display_name: title, session_kind: 'assistant_composite', role: 'assistant_composite', visibility: 'default',
    online: true, last_event_at: '2026-10-05T12:00:00Z', last_text: 'Fixture assistant preview', last_kind: 'ASSIST',
    capabilities: { pane: false, terminal: false, assistant_composite_v1: true } },
  { stream_id: queueStream, host: 'hosta', provider: 'claude', session_name: 'v2-send-probe', title: 'Native queue probe',
    visibility: 'default', online: true, last_event_at: '2026-10-05T12:00:00Z', last_text: '', last_kind: '' },
];

function send(socket, frame) {
  wire.push({ direction: 'out', at: Date.now(), frame });
  socket.send(JSON.stringify(frame));
}

function event(kind, text, request) {
  return { daemon_seq: ++sequence, host: 'hosta', provider: 'claude', session_id: queueStream,
    session_name: 'v2-send-probe', stream_id: queueStream, timestamp: new Date().toISOString(), kind, text,
    ...(kind === 'USER' ? { optimistic_id: request.optimistic_id, request_id: request.request_id,
      raw: { receipt_state: 'landed', receipt_delivery: 'landed' } } : {}) };
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const wsPort = await unusedPort();
  daemon = new WebSocketServer({ host: '127.0.0.1', port: wsPort });
  daemon.on('connection', (socket) => {
    socket.on('message', (raw) => {
      try {
      const frame = JSON.parse(String(raw));
      wire.push({ direction: 'in', at: Date.now(), frame });
      if (frame.type === 'hello') {
        assert.equal(frame.token, fixtureToken);
        assert.equal(frame.subscribe.include_subagents, false);
        assert.equal(frame.capabilities.assistant_composite_v1, true);
        send(socket, { type: 'snapshot', events_mode: 'summary', sessions, notifications,
          hosts: { hosta: { online: true }, hostb: { online: true } }, working_states: {}, capabilities: {} });
      } else if (frame.type === 'ping') {
        send(socket, { type: 'pong' });
      } else if (frame.type === 'specs.capabilities') {
        send(socket, { type: 'specs.capabilities.ok', request_id: frame.request_id, statuses: [] });
      } else if (frame.type === 'request_stream_events') {
        send(socket, { type: 'request_stream_events.ok', request_id: frame.request_id,
          stream_id: frame.stream_id || queueStream, events: history, complete: true });
      } else if (frame.type === 'asset.list') {
        send(socket, { type: 'asset.list.ok', request_id: frame.request_id, assets: [], reports: [] });
      } else if (frame.type === 'send') {
        assert.ok(frame.optimistic_id, 'The correlated echo requires the wire optimistic_id');
        assert.equal(frame.stream_id || `${frame.host}:${frame.session_name}`, queueStream);
        const text = frame.message || frame.text;
        const queued = text === 'Fixture native queue';
        assert.ok(queued || text === 'Fixture idle send', 'Only fixture sends are allowed');
        send(socket, { type: 'send.result', request_id: frame.request_id, delivery: 'landed', provider_queued: queued });
        pendingEchoes.set(text, () => {
          const user = event('USER', text, frame);
          const reply = event('ASSIST', queued ? 'Fixture reply queued' : 'Fixture reply idle', frame);
          history.push(user, reply);
          send(socket, { type: 'chat.event', event: user });
          send(socket, { type: 'chat.event', event: reply });
          pendingEchoes.delete(text);
        });
      }
      } catch (error) { wireErrors.push(String(error)); }
    });
  });
  const expoLog = fs.createWriteStream(path.join(output, 'expo.log'));
  const exportRoot = path.join(output, 'web-export');
  // The manifest embeds the per-run counterpart URL. Clear Metro's transform
  // cache so a previous ephemeral endpoint cannot survive into this bundle.
  expo = spawn(path.join(root, 'node_modules/.bin/expo'), ['export', '--clear', '--platform', 'web', '--output-dir', exportRoot], {
    cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1', EXPO_PUBLIC_HARNESS: '1',
      EXPO_PUBLIC_HARNESS_TOKEN: fixtureToken, EXPO_PUBLIC_PENTACLE_WS_URL: `ws://127.0.0.1:${wsPort}` },
  });
  expo.stdout.pipe(expoLog); expo.stderr.pipe(expoLog);
  expo.once('error', (error) => pageErrors.push(String(error)));
  await waitFor(() => expo.exitCode !== null || expo.signalCode !== null, 'Expo web export', 180000);
  assert.equal(expo.exitCode, 0, 'The actual Expo client must export successfully');
  const contentTypes = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' };
  web = http.createServer((request, response) => {
    const requested = path.resolve(exportRoot, `.${new URL(request.url, 'http://localhost').pathname}`);
    let file = requested.startsWith(`${exportRoot}${path.sep}`) ? requested : '';
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(exportRoot, 'index.html');
    response.setHeader('Content-Type', contentTypes[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).on('error', () => { response.statusCode = 500; response.end(); }).pipe(response);
  });
  await new Promise((resolve, reject) => { web.once('error', reject); web.listen(0, '127.0.0.1', resolve); });
  const webPort = web.address().port;
  fs.writeFileSync(path.join(output, 'runtime.json'), JSON.stringify({ websocket_url: `ws://127.0.0.1:${wsPort}`,
    browser_url: `http://127.0.0.1:${webPort}`, producer, composite }, null, 2));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 });
  activePage = page;
  page.on('console', (message) => {
    const text = message.text(); consoleLines.push({ at: Date.now(), type: message.type(), text });
    if (text.startsWith('[TELEMETRY] ')) {
      try { telemetry.push({ at: Date.now(), ...JSON.parse(text.slice(12)) }); } catch {}
    }
  });
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.goto(`http://127.0.0.1:${webPort}/chats`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByText(title, { exact: true }).waitFor({ timeout: 120000 });
  stage = 'question-rows';
  const compositeRow = page.getByTestId(`chat-row-${composite.replace(/[^a-zA-Z0-9_-]/g, '-')}`);
  await expect(compositeRow).toHaveCount(1);
  await expect(compositeRow.getByText('Assistant', { exact: true })).toBeVisible();
  await expect(compositeRow.locator('..').getByRole('button', { name: 'Answer 4 questions', exact: true })).toHaveCount(1);
  await expect(page.getByTestId(`chat-row-${producer.replace(/[^a-zA-Z0-9_-]/g, '-')}`)).toHaveCount(0);
  await expect(page.getByText('Fixture decision 1', { exact: true })).toHaveCount(0);
  const independent = page.getByTestId(`chat-row-${otherStream.replace(/[^a-zA-Z0-9_-]/g, '-')}`);
  await expect(independent.getByText('Agent', { exact: true })).toBeVisible();
  await expect(independent.getByText('Codex', { exact: true })).toHaveCount(0);
  await expect(independent.locator('..').getByRole('button', { name: 'Answer 1 question', exact: true })).toHaveCount(1);
  await page.screenshot({ path: path.join(output, 'question-rows.png'), fullPage: true });
  if (!cardsOnly) {
    await page.getByTestId('chat-row-hosta-v2-send-probe').click();
    const input = page.getByTestId('composer-input');
    const button = page.getByTestId('composer-send-button');
    for (const [text, caption, reply] of [
      ['Fixture native queue', 'queued-message-row', 'Fixture reply queued'],
      ['Fixture idle send', 'user-send-sent', 'Fixture reply idle'],
    ]) {
      stage = text;
      await input.fill(text); await button.click();
      await expect(page.getByTestId(caption)).toBeVisible();
      assert.ok(pendingEchoes.has(text), 'Caption must be measured before the daemon echo');
      const sending = wire.filter((row) => row.direction === 'in' && row.frame.type === 'send');
      assert.equal(sending.filter((row) => (row.frame.message || row.frame.text) === text).length, 1);
      await page.screenshot({ path: path.join(output, `${caption}-${sending.length}.png`), fullPage: true });
      pendingEchoes.get(text)();
      await expect(page.getByText(reply, { exact: true })).toBeVisible();
      await expect(page.getByTestId('user-send-sent')).toHaveCount(1);
      await waitFor(() => telemetry.some((entry) => entry.message === 'harness:row_rendered' &&
        entry.data?.lifecycle === 'mount' && entry.data?.display_rule === 'bubble:assistant' &&
        entry.data?.text_prefix === reply), `mounted assistant reply ${reply}`);
    }
    await expect(page.getByTestId('queued-message-row')).toHaveCount(0);
    assert.equal(wire.filter((row) => row.direction === 'in' && row.frame.type === 'send').length, 2);
    await page.screenshot({ path: path.join(output, 'settled-sends.png'), fullPage: true });
  }
  assert.equal(wire.filter((row) => row.direction === 'in' && /^(prompt\.(answer|cancel)|notification\.resolve)/.test(row.frame.type)).length, 0);
  assert.equal(pageErrors.length, 0, 'No browser runtime errors');
  assert.equal(wireErrors.length, 0, 'Scripted counterpart contract errors');
  fs.writeFileSync(path.join(output, 'verdict.json'), JSON.stringify({ verdict: 'PASS', scope: cardsOnly ? 'question rows' : 'question rows and native-queue/idle send captions',
    source_sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    producer, composite, open_questions: notifications.length, questions_resolved: 0,
    harness_sha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
    viewport: { width: 430, height: 932 }, browser_version: browser.version() }, null, 2));
  console.log(`PASS: ${output}`);
}

async function cleanup() {
  if (browser) await browser.close();
  if (web) await new Promise((resolve) => web.close(resolve));
  if (daemon) {
    for (const socket of daemon.clients) socket.terminate();
    await new Promise((resolve) => daemon.close(resolve));
  }
  if (expo && expo.exitCode === null) {
    process.kill(-expo.pid, 'SIGTERM');
    await waitFor(() => expo.exitCode !== null || expo.signalCode !== null, 'owned Expo cleanup', 10000);
  }
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'wire.json'), JSON.stringify(wire, null, 2));
  fs.writeFileSync(path.join(output, 'console.json'), JSON.stringify(consoleLines, null, 2));
  fs.writeFileSync(path.join(output, 'telemetry.json'), JSON.stringify(telemetry, null, 2));
  fs.writeFileSync(path.join(output, 'cleanup.json'), JSON.stringify({ verdict: 'PASS', owned_browser_closed: true,
    owned_web_closed: true, owned_daemon_closed: true, owned_exporter_stopped: !expo || expo.exitCode !== null || expo.signalCode !== null }, null, 2));
}

main().catch(async (error) => {
  fs.mkdirSync(output, { recursive: true });
  if (activePage) {
    await activePage.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(output, 'failure-dom.txt'), await activePage.locator('body').innerText().catch(() => ''));
  }
  fs.writeFileSync(path.join(output, 'verdict.json'), JSON.stringify({ verdict: 'FAIL', stage,
    classification: stage === 'setup' || wireErrors.length ? 'HARNESS_ERROR' : 'PRODUCT_FAIL', error: String(error), wire_errors: wireErrors,
    source_sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    producer, composite, open_questions: notifications.length, questions_resolved: 0,
    harness_sha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex') }, null, 2));
  console.error(error); process.exitCode = 1;
}).finally(cleanup).catch((error) => {
  fs.writeFileSync(path.join(output, 'cleanup.json'), JSON.stringify({ verdict: 'FAIL', classification: 'CLEANUP_FAIL', error: String(error) }, null, 2));
  process.exitCode = 1;
});
