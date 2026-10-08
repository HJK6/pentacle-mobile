// Selected accepted Retry and delivery controls; deterministic local WebSocket fixtures.
import AsyncStorage from '@react-native-async-storage/async-storage';

const mockAsyncStorageValues = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => mockAsyncStorageValues.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => { mockAsyncStorageValues.set(key, value); }),
    removeItem: jest.fn(async (key: string) => { mockAsyncStorageValues.delete(key); }),
    clear: jest.fn(async () => { mockAsyncStorageValues.clear(); }),
  },
}));

jest.mock('expo-notifications', () => ({}));

jest.mock('../src/config/pentacle', () => ({
  getDefaultPentacleWsUrl: () => 'ws://default.example/ws',
}));

type MockSocketEvent = { data?: string };

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MockSocketEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(message: string) {
    this.sent.push(message);
  }

  close(code?: number, reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: false });
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  message(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  closeFromServer() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

function loadStream() {
  jest.resetModules();
  MockWebSocket.instances = [];
  Object.assign(MockWebSocket, {
    CONNECTING: MockWebSocket.CONNECTING,
    OPEN: MockWebSocket.OPEN,
    CLOSED: MockWebSocket.CLOSED,
  });
  global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  return require('../src/services/pentacleStream') as typeof import('../src/services/pentacleStream');
}

beforeEach(async () => {
  await AsyncStorage.clear();
  delete process.env.EXPO_PUBLIC_HARNESS;
  delete process.env.EXPO_PUBLIC_HARNESS_FORCE_WS_RECONNECT;
  jest.useFakeTimers();
});

async function flushMicrotasks(times = 3) {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

function subscribeAndCreateSocket(stream: typeof import('../src/services/pentacleStream')) {
  const unsubscribe = stream.subscribePentacleStream(jest.fn());
  jest.advanceTimersByTime(0);
  return { unsubscribe, socket: MockWebSocket.instances.at(-1) as MockWebSocket };
}

function sentFrames(socket: MockWebSocket, type: string): Array<Record<string, unknown>> {
  return socket.sent
    .map((frame) => JSON.parse(frame) as Record<string, unknown>)
    .filter((frame) => frame.type === type);
}

const OPERATOR_V2_ENVELOPE = 'pentacle-auth-v2:' + Buffer.from(JSON.stringify({ client_kind: 'pentacle-mobile', credential_id: '123e4567-e89b-12d3-a456-426614174000', proof_key: Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString('base64url'), version: 2 })).toString('base64url');

const OPERATOR_V2_NONCE = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8';

function operatorV2Welcome(overrides: Record<string, unknown> = {}) {
  return {
    type: 'welcome',
    auth: {
      operator: {
        protocol_version: 2,
        scheme: 'hmac-sha256-v2',
        nonce: OPERATOR_V2_NONCE,
        expires_at: Date.now() / 1000 + 10,
        ...overrides,
      },
    },
  };
}

function sessionSummary(streamId = 'hosta:codex:one', overrides: Record<string, unknown> = {}) {
  return {
    stream_id: streamId,
    host: 'hosta',
    provider: 'codex',
    session_name: streamId.split(':').pop() || 'one',
    last_event_at: '2026-05-08T00:00:00Z',
    last_text: 'live summary',
    last_kind: 'ASSIST',
    draft: '',
    pending: false,
    working: true,
    online: true,
    ...overrides,
  };
}

function pentacleEvent(overrides: Record<string, unknown> = {}) {
  return {
    daemon_seq: 1,
    stream_id: 'hosta:codex:one',
    host: 'hosta',
    provider: 'codex',
    session_id: 'hosta:codex:one',
    session_name: 'one',
    timestamp: '2026-05-08T00:00:01Z',
    kind: 'ASSIST',
    text: 'hello',
    ...overrides,
  };
}


jest.mock('../src/services/voiceSendUnit', () => ({
 runVoiceUploadTranscribe: jest.fn().mockResolvedValue({blobSha: 'audio', transcript: {text: 'retained voice'}}),
 voiceTranscribeFailureMessage: () => 'Transcription failed.', NOTHING_RECOGNIZED_MESSAGE: 'Nothing was recognized.'
}));
jest.mock('expo-file-system/legacy', () => ({deleteAsync: jest.fn().mockResolvedValue(undefined)}));
test('voice retry must not send to a generation replaced while reconnect is awaited', async () => {
 const stream = loadStream();
 const { voiceDelivery, retryVoiceMessage } = require('../src/services/voiceDelivery');
 const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
 socket.open();
 socket.message({type:'snapshot', sessions:[sessionSummary('hosta:codex:one',{working:false, session_generation:'original'})], events:[]});
 const work = voiceDelivery.accept({streamId:'hosta:codex:one', recordingId:'qa-rec',uri:'file://qa.m4a',mime:'audio/mp4',durationS:3,levels:[],interrupted:false,draft:{originGeneration:'original',originLabel:'One',textPrefix:'',images:[]}});
 await flushMicrotasks(10);
 const first=sentFrames(socket,'send')[0];
 expect(first).toBeDefined();
 socket.closeFromServer();
 await work;
 stream.markOptimisticFailed(first.optimistic_id as string,'unconfirmed');
 const retry=retryVoiceMessage(first.optimistic_id,stream.retryOptimisticSend);
 await flushMicrotasks(10);
 const recovered=MockWebSocket.instances.at(-1)!;
 expect(recovered).not.toBe(socket);
 stream.__handlePentacleStreamMessageForTests({type:'session.inventory',sessions:[sessionSummary('hosta:codex:one',{working:false,session_generation:'replacement'})]});
 expect(stream.getPentacleStreamState().sessions[0].session_generation).toBe('replacement');
 recovered.open();
 recovered.message({type:'snapshot',sessions:[sessionSummary('hosta:codex:one',{working:false,session_generation:'replacement'})],events:[]});
 await flushMicrotasks(10);
 const sends=sentFrames(recovered,'send');

 if(sends[0]) recovered.message({type:'send.result',request_id:sends[0].request_id,delivery:'landed'});
 await retry;
 unsubscribe();
 expect(sends).toHaveLength(0);
});

test.each(['original', 'replacement'])('offline voice replay waits for fresh inventory and respects %s generation', async (generation) => {
 const stream = loadStream();
 const { voiceDelivery } = require('../src/services/voiceDelivery');
 const { unsubscribe, socket } = subscribeAndCreateSocket(stream);
 socket.open();
 socket.message({type:'snapshot', sessions:[sessionSummary('hosta:codex:one',{working:false,session_generation:'original'})],events:[]});
 socket.closeFromServer();
 await voiceDelivery.accept({streamId:'hosta:codex:one',recordingId:'offline-rec',uri:'file://offline.m4a',mime:'audio/mp4',durationS:3,levels:[],interrupted:false,draft:{originGeneration:'original',originLabel:'One',textPrefix:'',images:[]}});
 jest.advanceTimersByTime(2000);
 const recovered=MockWebSocket.instances.at(-1)!;
 expect(recovered).not.toBe(socket);
 recovered.open();
 await flushMicrotasks(10);
 expect(sentFrames(recovered,'send')).toHaveLength(0);
 recovered.message({type:'snapshot',sessions:[sessionSummary('hosta:codex:one',{working:false,session_generation:generation})],events:[]});
 await flushMicrotasks(10);
 const sends=sentFrames(recovered,'send');
 expect(sends).toHaveLength(generation === 'original' ? 1 : 0);
 if(sends[0]) recovered.message({type:'send.result',request_id:sends[0].request_id,delivery:'landed'});
 else expect(Object.values(stream.getPentacleStreamState().optimisticSends ?? {})[0]).toMatchObject({status:'failed',origin_generation:'original'});
 unsubscribe();
});
