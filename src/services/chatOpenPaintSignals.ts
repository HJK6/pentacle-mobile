export type ChatOpenPaintPhase =
  | 'tap'
  | 'router-dispatch-return'
  | 'shell-layout-commit'
  | 'first-authoritative-row-mount';

export type ChatOpenPaintSignal = {
  correlationId: string;
  streamId: string;
  phase: ChatOpenPaintPhase;
  monotonicMs: number;
  wallTimeMs: number;
};

export type ChatOpenPaintSink = (signal: ChatOpenPaintSignal) => void;

export type ChatOpenPaintClock = {
  monotonicNow: () => number;
  wallNow: () => number;
};

const NOOP_SINK: ChatOpenPaintSink = () => undefined;

const defaultClock: ChatOpenPaintClock = {
  monotonicNow: () => globalThis.performance?.now?.() ?? Date.now(),
  wallNow: () => Date.now(),
};

export type ChatOpenPaintSignals = {
  begin: (streamId: string) => string | null;
  routerDispatchReturned: (correlationId: string | null | undefined, streamId: string) => void;
  shellLayoutCommitted: (correlationId: string | null | undefined, streamId: string) => void;
  firstAuthoritativeRowMounted: (correlationId: string | null | undefined, streamId: string) => void;
};

export function createChatOpenPaintSignals(
  sink: ChatOpenPaintSink = NOOP_SINK,
  clock: ChatOpenPaintClock = defaultClock,
): ChatOpenPaintSignals {
  let nextId = 0;
  const enabled = sink !== NOOP_SINK;

  const emit = (correlationId: string | null | undefined, streamId: string, phase: ChatOpenPaintPhase) => {
    if (!enabled || !correlationId) return;
    sink({
      correlationId,
      streamId,
      phase,
      monotonicMs: clock.monotonicNow(),
      wallTimeMs: clock.wallNow(),
    });
  };

  return {
    begin(streamId) {
      if (!enabled) return null;
      const correlationId = `chat-open:${++nextId}`;
      emit(correlationId, streamId, 'tap');
      return correlationId;
    },
    routerDispatchReturned(correlationId, streamId) {
      emit(correlationId, streamId, 'router-dispatch-return');
    },
    shellLayoutCommitted(correlationId, streamId) {
      emit(correlationId, streamId, 'shell-layout-commit');
    },
    firstAuthoritativeRowMounted(correlationId, streamId) {
      emit(correlationId, streamId, 'first-authoritative-row-mount');
    },
  };
}

let activeSink: ChatOpenPaintSink = NOOP_SINK;
let appSignals = createChatOpenPaintSignals(activeSink);

/** Installs a harness/test observer; production keeps the default no-op sink. */
export function setChatOpenPaintSink(sink: ChatOpenPaintSink | null | undefined): () => void {
  const previous = activeSink;
  activeSink = sink || NOOP_SINK;
  appSignals = createChatOpenPaintSignals(activeSink);
  return () => {
    activeSink = previous;
    appSignals = createChatOpenPaintSignals(activeSink);
  };
}

export function beginChatOpenPaint(streamId: string): string | null {
  return appSignals.begin(streamId);
}

export function markChatOpenRouterDispatchReturned(correlationId: string | null | undefined, streamId: string): void {
  appSignals.routerDispatchReturned(correlationId, streamId);
}

export function markChatOpenShellLayoutCommitted(correlationId: string | null | undefined, streamId: string): void {
  appSignals.shellLayoutCommitted(correlationId, streamId);
}

export function markChatOpenFirstAuthoritativeRowMounted(correlationId: string | null | undefined, streamId: string): void {
  appSignals.firstAuthoritativeRowMounted(correlationId, streamId);
}
