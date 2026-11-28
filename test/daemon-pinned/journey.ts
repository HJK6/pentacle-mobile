import { readFileSync } from 'node:fs';

jest.mock('expo-notifications', () => ({}));
jest.mock('expo-constants', () => require('../../tests/helpers/stubs/expoConstants.cjs'));
jest.mock('../../src/config/pentacle', () => ({ getDefaultPentacleWsUrl: () => process.env.PINNED_DAEMON_URL }));

const frames: Record<string, any>[] = [];
const WebSocketImpl = require('ws');
class ObservedSocket extends WebSocketImpl {
  constructor(url: string) {
    // Presence of Origin disables the daemon's loopback trust exception.
    super(url, { headers: { Origin: 'null' } });
    this.addEventListener('message', (event: { data: string }) => {
      try { frames.push(JSON.parse(String(event.data))); } catch { /* Transport handles malformed data. */ }
    });
  }
}

async function waitForFrame(type: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = frames.find(item => item.type === type);
    if (frame) return frame;
    const error = frames.find(item => item.type === 'hello.error');
    if (error) throw new Error(`Authenticated hello rejected: ${JSON.stringify(error)}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for authenticated daemon ${type}`);
}

test('pinned daemon authenticates and returns the seeded history', async () => {
  const url = process.env.PINNED_DAEMON_URL;
  const tokenFile = process.env.PINNED_DAEMON_TOKEN_FILE;
  const seedFile = process.env.PINNED_DAEMON_SEED_FILE;
  const daemonHead = process.env.PINNED_DAEMON_HEAD;
  if (!url || !tokenFile || !seedFile || !daemonHead) throw new Error('Missing pinned daemon journey inputs');
  const seed = JSON.parse(readFileSync(seedFile, 'utf8'));
  global.WebSocket = ObservedSocket as unknown as typeof WebSocket;
  const stream = require('../../src/services/pentacleStream') as typeof import('../../src/services/pentacleStream');
  stream.setPentacleWsUrl(url);
  stream.setPentacleAuthToken(readFileSync(tokenFile, 'utf8').trim());
  const unsubscribe = stream.subscribePentacleStream(() => {});
  try {
    const welcome = await waitForFrame('welcome');
    console.log(`welcome runtime_sha: ${welcome.runtime_sha}`);
    expect(welcome.runtime_sha).toBe(daemonHead);
    await waitForFrame('hello');
    const snapshot = await waitForFrame('snapshot');
    expect(snapshot.sessions.some((row: { stream_id: string }) => row.stream_id === seed.stream_id)).toBe(true);
    const rows = await stream.requestStreamEvents(seed.stream_id, 500);
    const readback = rows.map(row => [row.kind, row.text]);
    console.log(`seeded rows: ${JSON.stringify({ stream_id: seed.stream_id, count: rows.length, rows: readback })}`);
    expect(rows).toHaveLength(seed.events);
    expect(rows.every(row => row.stream_id === seed.stream_id)).toBe(true);
    expect(readback).toEqual(seed.transcript);
  } finally {
    unsubscribe();
    stream.__resetPentacleStreamForTests();
  }
}, 45000);
