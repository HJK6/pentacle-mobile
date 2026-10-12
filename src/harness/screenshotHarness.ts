/**
 * Screenshot-harness bootstrap (spec: pentacle-mobile mock screenshot harness).
 *
 * `installScreenshotHarness()` flips the pentacleStream module into offline
 * mode, seeds a fully-populated default fixture so the first paint isn't empty,
 * and installs `window.__pentacleHarness` so the Playwright driver can re-seed
 * per (screen, variant) and read a readiness flag.
 *
 * It is invoked once at module scope from app/_layout.tsx, strictly gated on
 * EXPO_PUBLIC_SCREENSHOT_HARNESS === '1', so production bundles dead-code the
 * entire path (the require() is never reached and metro tree-shakes it).
 */
import {
  harnessSeedSnapshot,
  harnessSetOffline,
} from "../services/pentacleStream";
import { DEFAULT_FIXTURE, getFixture } from "./screenshotFixtures";
import { harnessSeedReports } from "../services/pentacleAssets";

type PentacleHarnessApi = {
  seed: (screen: string, variant: string) => boolean;
  markReady: () => void;
  ready: boolean;
  voice?: ReturnType<typeof installVoiceRenderBoundary>;
};

declare global {
  // eslint-disable-next-line no-var
  var __pentacleHarness: PentacleHarnessApi | undefined;
}

let installed = false;

export function installScreenshotHarness() {
  if (installed) return;
  installed = true;

  harnessSetOffline(true);
  // Seed a default combined fixture so the first paint of any route is
  // populated rather than empty/loading.
  const defaultFixtureKey = process.env.EXPO_PUBLIC_SCREENSHOT_HARNESS_DEFAULT;
  const [defaultScreen, defaultVariant] = String(defaultFixtureKey || "").split(
    ":",
    2,
  );
  const defaultFixture =
    defaultScreen && defaultVariant
      ? getFixture(defaultScreen, defaultVariant) || DEFAULT_FIXTURE
      : DEFAULT_FIXTURE;
  harnessSeedSnapshot(defaultFixture.snapshot, defaultFixture.opts);
  harnessSeedReports(
    defaultFixture.assets?.streamId || "",
    defaultFixture.assets?.reports,
    defaultFixture.assets?.comments,
    defaultFixture.assets?.closed,
    defaultFixture.assets?.error,
    defaultFixture.assets?.loading,
  );

  const api: PentacleHarnessApi = {
    ready: false,
    voice: installVoiceRenderBoundary(),
    seed(screen: string, variant: string) {
      const fixture = getFixture(screen, variant);
      if (!fixture) {
        // eslint-disable-next-line no-console
        console.warn(
          `[screenshot-harness] no fixture for ${screen}:${variant}`,
        );
        return false;
      }
      harnessSeedSnapshot(fixture.snapshot, fixture.opts);
      harnessSeedReports(
        fixture.assets?.streamId || "",
        fixture.assets?.reports,
        fixture.assets?.comments,
        fixture.assets?.closed,
        fixture.assets?.error,
        fixture.assets?.loading,
      );
      return true;
    },
    markReady() {
      this.ready = true;
    },
  };

  if (typeof window !== "undefined") {
    window.__pentacleHarness = api;
  }
}

/** Render acceptance uses the real controller, recorder, store, upload and transport.
 * Only OS capture/filesystem and the external socket are synthetic. This is an
 * explicit second gate: ordinary screenshots and production never install it.
 */
function installVoiceRenderBoundary() {
  if (process.env.EXPO_PUBLIC_SCREENSHOT_HARNESS !== '1'
      || process.env.EXPO_PUBLIC_VOICE_RENDER_FIXTURE !== '1') return undefined;
  const stream = require('../services/pentacleStream') as typeof import('../services/pentacleStream');
  const capture = require('../services/voiceRecordingEngine') as typeof import('../services/voiceRecordingEngine');
  const { voiceTakeStore } = require('../services/voiceTakeStore') as typeof import('../services/voiceTakeStore');
  const { voiceDelivery } = require('../services/voiceDelivery') as typeof import('../services/voiceDelivery');
  const { runVoiceUploadTranscribe } = require('../services/voiceSendUnit') as typeof import('../services/voiceSendUnit');
  const { runVoiceUpload } = require('../services/voiceUpload') as typeof import('../services/voiceUpload');
  const { sha256 } = require('@noble/hashes/sha2.js') as typeof import('@noble/hashes/sha2.js');
  const { bytesToHex, utf8ToBytes } = require('@noble/hashes/utils.js') as typeof import('@noble/hashes/utils.js');
  const { toByteArray } = require('base64-js') as typeof import('base64-js');
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>();
  const digest = (bytes: Uint8Array) => bytesToHex(sha256(bytes));
  const readBytes = (uri: string) => { const value = files.get(uri); if (!value) throw new Error('ENOENT'); return value; };
  let serial = 0;
  const io: import('../services/voiceTakeStore').VoiceTakeIO = {
    root: 'file:///voice-render/documents/voice-takes-v1/', cacheRoot: 'file:///voice-render/cache/',
    now: () => Date.now(), uuid: () => `123e4567-e89b-42d3-a456-${String(++serial).padStart(12, '0')}`,
    stat: async uri => ({ exists: files.has(uri) || directories.has(uri), size: files.get(uri)?.length ?? 0, directory: directories.has(uri) }),
    list: async uri => [...new Set([...files.keys(), ...directories].filter(key => key.startsWith(uri) && key !== uri).map(key => key.slice(uri.length).split('/')[0]).filter(Boolean))],
    mkdir: async uri => { for (let i = 8; i < uri.length; i++) if (uri[i] === '/') directories.add(uri.slice(0, i + 1)); directories.add(uri); },
    read: async uri => new TextDecoder().decode(readBytes(uri)),
    write: async (uri, value) => { files.set(uri, utf8ToBytes(value)); },
    move: async (from, to) => { files.set(to, readBytes(from).slice()); files.delete(from); },
    copy: async (from, to) => { files.set(to, readBytes(from).slice()); },
    remove: async uri => { const prefix = uri.endsWith('/') ? uri : `${uri}/`; for (const key of files.keys()) if (key === uri || key.startsWith(prefix)) files.delete(key); for (const key of directories) if (key === uri || key.startsWith(prefix)) directories.delete(key); },
    free: async () => 1024 ** 3,
    inspect: async uri => { const bytes = readBytes(uri); return { bytes: bytes.length, sha256: digest(bytes) }; },
  };
  // Singleton private IO fields are replaced only here, before app mount. No
  // production API permits swapping controller state or faking presentation.
  (voiceTakeStore as unknown as { io: typeof io }).io = io;
  const mp4 = () => {
    const box = (kind: string, payload: string) => { const out = new Uint8Array(8 + payload.length); new DataView(out.buffer).setUint32(0, out.length); out.set(utf8ToBytes(kind), 4); out.set(utf8ToBytes(payload), 8); return out; };
    const boxes = [box('ftyp', 'M4A \0\0\0\0'), box('moov', 'synthetic-render-only'), box('mdat', 'synthetic-audio-boundary')];
    const out = new Uint8Array(boxes.reduce((sum, part) => sum + part.length, 0)); let at = 0;
    boxes.forEach(part => { out.set(part, at); at += part.length; }); return out;
  };
  let status: import('../../modules/pentacle-voice-capture').CaptureStatus = { state: 'idle', reason: null, pauseEpoch: 0, capturedMs: 0, metering: -30, uri: null, recordingId: null };
  let startedAt = 0;
  let accumulated = 0;
  let starts = 0;
  let permission = true;
  let supported = true;
  let gate: 'none' | 'uploading' | 'transcribing' | 'checking' | 'failure' = 'none';
  const held: Array<() => void> = [];
  const sample = () => {
    const capturedMs = accumulated + (status.state === 'recording' ? Date.now() - startedAt : 0);
    return { ...status, capturedMs, metering: -42 + 34 * (0.5 + 0.5 * Math.sin(capturedMs / 193)) };
  };
  const stopClock = (state: typeof status.state, reason: string | null = null) => {
    accumulated = sample().capturedMs; status = { ...status, state, reason, capturedMs: accumulated, pauseEpoch: status.pauseEpoch + 1 }; return sample();
  };
  const native: import('../../modules/pentacle-voice-capture').NativeVoiceCapture = {
    getCaptureContract: () => ({ contract: 'pentacle-voice-capture', revision: capture.ACCEPTED_CAPTURE_REVISION, nativeBuild: 'voice-render-synthetic' }),
    getStatus: sample, getAdmission: () => 1, revokeAdmissions: () => {},
    getPermission: async () => ({ granted: permission, canAskAgain: false }), requestPermission: async () => ({ granted: permission, canAskAgain: false }),
    start: async id => { starts++; startedAt = Date.now(); accumulated = 0; const uri = `${io.cacheRoot}capture-${starts}.m4a`; files.set(uri, mp4()); status = { state: 'recording', reason: null, pauseEpoch: 0, capturedMs: 0, metering: -30, uri, recordingId: id }; return sample(); },
    pause: async () => stopClock('paused'), resume: async () => { startedAt = Date.now(); status = { ...status, state: 'recording', reason: null }; return sample(); },
    stop: async () => stopClock('stopped'), discard: async () => { stopClock('discarded'); },
  };
  const engine = (capture.voiceRecorder as unknown as { engine: { bindings: unknown } }).engine;
  engine.bindings = { module: () => supported ? native : null, contract: native.getCaptureContract, build: () => 'voice-render-synthetic' };
  const deliveryIO = (voiceDelivery as unknown as { io: import('../services/voiceDelivery').VoiceDeliveryIO }).io;
  deliveryIO.transcribe = args => runVoiceUploadTranscribe({ ...args, io: {
    upload: upload => runVoiceUpload({ ...upload, io: { readRange: async (uri, offset, length) => readBytes(uri).slice(offset, offset + length) } }),
  } });
  const fixture = {
    ...DEFAULT_FIXTURE.snapshot,
    sessions: [
      { stream_id: 'bart:assistant', host: 'hosta', session_name: 'assistant', provider: 'codex', title: 'Bart', display_name: 'Bart', session_kind: 'assistant_composite', session_generation: 'voice-render-assistant-1', online: true },
      ...(DEFAULT_FIXTURE.snapshot.sessions ?? []).filter(row => row.stream_id !== 'bart:assistant').map(row => ({ ...row, session_generation: `voice-render-${row.session_name}-1`, title: row.stream_id === 'hosta:analysis-sample' ? 'Design review' : row.title })),
    ],
  };
  type Frame = Record<string, any>;
  const frames: Frame[] = [];
  const sockets: RenderWebSocket[] = [];
  const uploads = new Map<string, { total: number; sha: string; bytes: Uint8Array }>();
  class RenderWebSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
    readyState = 0; onopen: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null; onerror: (() => void) | null = null;
    constructor(public url: string) { sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); this.message({ type: 'welcome', auth: { operator: { protocol_version: 2, scheme: 'hmac-sha256-v2', nonce: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8', expires_at: Date.now() / 1000 + 60 } } }); }, 0); }
    message(value: unknown) { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(value) }); }
    close(code = 1000, reason = '') { this.readyState = 3; this.onclose?.({ code, reason, wasClean: true }); }
    send(raw: string) {
      const frame = JSON.parse(raw) as Frame; frames.push(frame);
      const reply = () => {
        const request_id = frame.request_id;
        if (frame.type === 'hello') { this.message({ type: 'snapshot', ...fixture }); if (fixture.hosts_stats) this.message({ type: 'hosts.stats', hosts: fixture.hosts_stats }); }
        else if (frame.type === 'household.snapshot') this.message({ type: 'household.snapshot.ok', request_id, today: '2026-10-12', month: frame.month ?? '2026-10', server_now: '2026-10-12T12:00:00.000Z',
          lists: { tasks: [{ id: 1, list: 'tasks', label: 'Review the design packet', priority: 'hi', due_date: '2026-10-12', position: 0, category: null, scope: 'private', created_by: 'app', done_at: null, routine_id: null }], grocery: [], meals: [], chores: [], study: [] },
          events: [{ id: 1, date: '2026-10-12', time: '14:00', title: 'Design review', who: 'self', location: null, star: true, scope: 'private', created_by: 'app' }], people: { partner: 'Partner' } });
        else if (frame.type === 'ping') this.message({ type: 'pong', ...('id' in frame ? { id: frame.id } : {}) });
        else if (frame.type === 'upload_blob_init') {
          uploads.set(frame.upload_id, { total: frame.total_bytes, sha: frame.sha256, bytes: new Uint8Array() });
          this.message({ type: 'upload_blob.init.ok', request_id, protocol: 2, upload_id: frame.upload_id, next_offset: 0, complete: false });
        } else if (frame.type === 'upload_blob_chunk') {
          const upload = uploads.get(frame.upload_id)!; const chunk = toByteArray(frame.data_b64);
          if (frame.offset !== upload.bytes.length || digest(chunk) !== frame.chunk_sha256) throw new Error('Synthetic upload boundary rejected bytes');
          const joined = new Uint8Array(upload.bytes.length + chunk.length); joined.set(upload.bytes); joined.set(chunk, upload.bytes.length); upload.bytes = joined;
          const complete = !!frame.final;
          if (complete && (joined.length !== upload.total || digest(joined) !== upload.sha)) throw new Error('Synthetic upload boundary rejected digest');
          this.message({ type: 'upload_blob.ok', request_id, protocol: 2, upload_id: frame.upload_id, next_offset: joined.length, complete, ...(complete ? { blob_sha: upload.sha } : {}) });
        } else if (frame.type === 'transcribe_blob') {
          this.message(gate === 'failure' ? { type: 'transcribe_blob.error', request_id, error_code: 'backend_unavailable' } : { type: 'transcribe_blob.ok', request_id, text: 'Synthetic voice acceptance message.' });
        } else if (frame.type === 'send.receipt.get') this.message({ type: 'send.receipt.get.ok', request_id, found: false, receipts: [] });
        else if (frame.type === 'send' && gate !== 'checking') this.message({ type: 'send.result', request_id, to_stream_id: frame.stream_id ?? 'hosta:analysis-sample', delivery: 'landed' });
      };
      if ((gate === 'uploading' && frame.type.startsWith('upload_blob')) || (gate === 'transcribing' && frame.type === 'transcribe_blob')) held.push(reply);
      else setTimeout(reply, 20);
    }
  }
  globalThis.WebSocket = RenderWebSocket as unknown as typeof WebSocket;
  stream.harnessSetOffline(false);
  return {
    snapshot: () => ({ recorder: capture.voiceRecorder.snapshot(), delivery: voiceDelivery.snapshot(), store: voiceTakeStore.snapshot(), transport: stream.voiceTransportSnapshot(), native: sample(), nativeStarts: starts, frames: frames.filter(frame => frame.type !== 'hello'), ownedFiles: [...files.keys()] }),
    gate: (next: typeof gate) => { gate = next; if (next === 'none') held.splice(0).forEach(release => release()); },
    release: () => { held.splice(0).forEach(release => release()); },
    captured: (milliseconds: number) => { accumulated = Math.max(0, milliseconds); startedAt = Date.now(); },
    interrupt: () => { stopClock('paused', 'interrupted'); },
    permission: (granted: boolean) => { permission = granted; },
    supported: (value: boolean) => { supported = value; },
    lifecycle: capture.setVoiceLifecycle,
    land: () => { const frame = [...frames].reverse().find(row => row.type === 'send'); if (!frame) throw new Error('No immutable send frame'); sockets.at(-1)?.message({ type: 'send.result', request_id: frame.request_id, to_stream_id: frame.stream_id ?? 'hosta:analysis-sample', delivery: 'landed' }); },
    discard: () => capture.voiceRecorder.discard(),
    resume: () => capture.voiceRecorder.resume(),
  };
}
