'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const WebSocketServer = WebSocket.WebSocketServer || WebSocket.Server;

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function required(name) {
  const value = arg(name);
  if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
    throw new Error(`--${name} is required`);
  }
  return value;
}
const port = Number(required('port'));
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid loopback port');
const fixtureDir = path.resolve(required('fixture-dir'));
const deviceToken = required('device-token');
const readonlyToken = required('readonly-token');
if (deviceToken === readonlyToken) throw new Error('write and readonly tokens must differ');
const dashboardId = required('dashboard-id');
const fixtureNames = required('fixtures').split(',');
if (fixtureNames.some((name) => !name || path.basename(name) !== name || name === '.' || name === '..')) {
  throw new Error('fixture names must be local basenames');
}
const gateContract = JSON.parse(fs.readFileSync(path.resolve(required('gate-contract')), 'utf8'));
const gateCases = new Map(gateContract.cases.map((entry) => [entry.case, entry]));
for (const name of ['reject_no_token', 'reject_device_without_scope', 'reject_invalid_batch',
                    'reject_invalid_gate', 'reject_invalid_setting', 'writer_failure']) {
  if (!gateCases.get(name)?.response) throw new Error('missing gate response: '+name);
}
const envelopes = new Map(fixtureNames.map((name) => {
  const value = JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
  return [value.dashboard_id, value];
}));
if (!envelopes.get(dashboardId)?.data?.snapshots) throw new Error('configured dashboard has no snapshots');
const timers = new Set();
const sockets = new Set();
const stats = { connections: 0, subscriptions: 0, invalid_read_attempts: 0, gate_mutations: [], gate_broadcasts: 0 };

function json(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function contractError(response, caseName) {
  const entry = gateCases.get(caseName);
  return json(response, entry.response.status, entry.response.body);
}

function broadcast(envelope) {
  const frame = JSON.stringify({ type: 'snapshot', envelope });
  sockets.forEach((socket) => socket.readyState === 1 && socket.send(frame));
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') return json(response, 200, { ok: true });
  if (request.method === 'GET' && request.url === '/stats') return json(response, 200, stats);
  if (request.method !== 'POST' || request.url !== '/control/batch-gate') return json(response, 404, { error: 'not_found' });
  if (!request.headers.authorization || request.headers.authorization !== `Bearer ${deviceToken}` && request.headers.authorization !== `Bearer ${readonlyToken}`) {
    return contractError(response, 'reject_no_token');
  }
  if (request.headers.authorization === `Bearer ${readonlyToken}`) return contractError(response, 'reject_device_without_scope');
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    let mutation;
    try { mutation = JSON.parse(body); } catch { return json(response, 400, { error: 'invalid_json' }); }
    if (!mutation.batch) return contractError(response, 'reject_invalid_batch');
    if (!['open', 'closed'].includes(mutation.gate)) return contractError(response, 'reject_invalid_gate');
    if (mutation.setting && mutation.setting !== 'auto_submit_skipmatrix') return contractError(response, 'reject_invalid_setting');
    if (mutation.batch === '__writer_failure__') return contractError(response, 'writer_failure');
    stats.gate_mutations.push(mutation);
    const current = envelopes.get(dashboardId);
    const snapshots = { ...current.data.snapshots };
    const selected = snapshots[mutation.batch];
    if (!selected) return contractError(response, 'reject_invalid_batch');
    const setting = mutation.setting || 'auto_submit_skipmatrix';
    const changed = selected.pipeline_summary.skiptrace_gate !== mutation.gate;
    snapshots[mutation.batch] = {
      ...selected,
      pipeline_summary: { ...selected.pipeline_summary, state_machine_batch: mutation.batch, skiptrace_gate: mutation.gate },
    };
    const next = {
      ...current,
      updated_at: new Date().toISOString(),
      server_received_at: new Date().toISOString(),
      data: {
        ...current.data,
        snapshots,
      },
    };
    envelopes.set(dashboardId, next);
    json(response, 200, {
      ok: true,
      batch: mutation.batch,
      gate: mutation.gate,
      setting,
      changed,
      device_id: 'synthetic-device',
      updated_at: next.updated_at,
    });
    const timer = setTimeout(() => {
      timers.delete(timer);
      stats.gate_broadcasts += 1;
      broadcast(next);
    }, 3000);
    timers.add(timer);
  });
});

const webSockets = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname !== '/live' || url.searchParams.get('token') !== deviceToken) {
    stats.invalid_read_attempts += 1;
    return socket.destroy();
  }
  webSockets.handleUpgrade(request, socket, head, (webSocket) => webSockets.emit('connection', webSocket));
});

webSockets.on('connection', (socket) => {
  sockets.add(socket);
  stats.connections += 1;
  socket.on('close', () => sockets.delete(socket));
  socket.on('message', (raw) => {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (message.type === 'pong') return;
    if (message.type !== 'hello') return;
    stats.subscriptions += 1;
    socket.send(JSON.stringify({ type: 'welcome', dashboards: [...envelopes.keys()] }));
    [...envelopes.keys()].forEach((dashboardId) => {
      let envelope = envelopes.get(dashboardId);
      if (envelope) socket.send(JSON.stringify({ type: 'snapshot', envelope }));
    });
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ ready: true, host: '127.0.0.1', port: server.address().port }));
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  timers.forEach((timer) => clearTimeout(timer));
  timers.clear();
  sockets.forEach((socket) => socket.terminate());
  let remaining = 2;
  const closed = () => { if (--remaining === 0) process.exit(0); };
  webSockets.close(closed);
  server.close(closed);
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
