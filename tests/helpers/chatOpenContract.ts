export type ChatOpenLoadInput = {
  preview?: boolean;
  retainedRows?: number;
  connected?: boolean;
  request?: 'idle' | 'loading' | 'prefetching' | 'ready' | 'error';
};

export type ChatOpenLoadOutput = {
  shell: 'preview' | 'empty' | 'none';
  list: 'deferred' | 'authoritative';
  spinner: boolean;
  status: 'syncing' | 'ready' | 'empty' | 'offline' | 'error';
};

export type ChatOpenLoadFixture = {
  id: string;
  input: Required<ChatOpenLoadInput>;
  output: ChatOpenLoadOutput;
  expectedFuture: readonly string[];
};

export type ChatOpenTransitionFixture = {
  id: string;
  from: string;
  event: string;
  to: string;
  expectedFuture: readonly string[];
};

/**
 * Binding observable-state contract. Lanes consume these fixtures before their
 * implementation turns the expected-future markers green.
 */
export const CHAT_OPEN_LOAD_FIXTURES: readonly ChatOpenLoadFixture[] = [
  {
    id: 'preview-loading-connected',
    input: { preview: true, retainedRows: 0, connected: true, request: 'loading' },
    output: { shell: 'preview', list: 'deferred', spinner: false, status: 'syncing' },
    expectedFuture: [],
  },
  {
    id: 'retained-loading-connected',
    input: { preview: false, retainedRows: 3, connected: true, request: 'loading' },
    output: { shell: 'none', list: 'authoritative', spinner: false, status: 'syncing' },
    expectedFuture: [],
  },
  {
    id: 'empty-loading-connected',
    input: { preview: false, retainedRows: 0, connected: true, request: 'loading' },
    output: { shell: 'none', list: 'deferred', spinner: true, status: 'syncing' },
    expectedFuture: [],
  },
  {
    id: 'success-empty',
    input: { preview: false, retainedRows: 0, connected: true, request: 'ready' },
    output: { shell: 'empty', list: 'deferred', spinner: false, status: 'empty' },
    expectedFuture: ['bucket-coverage'],
  },
  {
    id: 'failure-with-preview',
    input: { preview: true, retainedRows: 0, connected: true, request: 'error' },
    output: { shell: 'preview', list: 'deferred', spinner: false, status: 'error' },
    expectedFuture: [],
  },
  {
    id: 'offline-with-retained-rows',
    input: { preview: false, retainedRows: 2, connected: false, request: 'idle' },
    output: { shell: 'none', list: 'authoritative', spinner: false, status: 'offline' },
    expectedFuture: [],
  },
];

export const CHAT_OPEN_TRANSITION_FIXTURES: readonly ChatOpenTransitionFixture[] = [
  { id: 'success-empty', from: 'loading', event: 'complete-empty', to: 'empty', expectedFuture: ['bucket-coverage'] },
  { id: 'failure', from: 'loading', event: 'request-failed', to: 'error', expectedFuture: ['request-coordinator'] },
  { id: 'retry', from: 'error', event: 'retry', to: 'loading', expectedFuture: ['request-coordinator'] },
  { id: 'offline', from: 'loading', event: 'disconnect', to: 'offline', expectedFuture: ['request-coordinator'] },
  { id: 'reconnect', from: 'offline', event: 'reconnect', to: 'retained-stale', expectedFuture: ['request-coordinator'] },
  { id: 'reset', from: 'retained-stale', event: 'explicit-reset', to: 'empty', expectedFuture: ['bucket-reset'] },
  { id: 'eviction', from: 'retained-ready', event: 'lru-evict', to: 'preview-or-empty', expectedFuture: ['bucket-retention'] },
  { id: 'stale-completion', from: 'new-generation-loading', event: 'old-request-complete', to: 'new-generation-loading', expectedFuture: ['generation-fence'] },
];

export type ChatOpenNavigationFixture = {
  id: string;
  pendingTarget: string | null;
  event: 'tap-same' | 'tap-different' | 'ack-matching' | 'ack-mismatched' | 'timeout';
  target?: string;
  expectedAction: 'push' | 'replace' | 'noop' | 'clear-pending';
  expectedFuture: readonly string[];
};

export const CHAT_OPEN_NAVIGATION_FIXTURES: readonly ChatOpenNavigationFixture[] = [
  { id: 'first-tap', pendingTarget: null, event: 'tap-different', target: 'stream-a', expectedAction: 'push', expectedFuture: [] },
  { id: 'retap-same-target', pendingTarget: 'stream-a', event: 'tap-same', target: 'stream-a', expectedAction: 'noop', expectedFuture: [] },
  { id: 'tap-different-target', pendingTarget: 'stream-a', event: 'tap-different', target: 'stream-b', expectedAction: 'replace', expectedFuture: [] },
  { id: 'matching-ack', pendingTarget: 'stream-b', event: 'ack-matching', target: 'stream-b', expectedAction: 'clear-pending', expectedFuture: [] },
  { id: 'late-ack', pendingTarget: 'stream-b', event: 'ack-mismatched', target: 'stream-a', expectedAction: 'noop', expectedFuture: [] },
  { id: 'recovery-timeout', pendingTarget: 'stream-b', event: 'timeout', expectedAction: 'clear-pending', expectedFuture: [] },
];
