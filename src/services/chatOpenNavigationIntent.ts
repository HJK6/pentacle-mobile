export type ChatOpenNavigationAction = 'push' | 'replace' | 'noop';

export type ChatOpenNavigationIntent = {
  streamId: string;
  correlationId: string | null;
};

type Timer = ReturnType<typeof setTimeout>;
type TerminalStatus = 'completed' | 'cancelled' | 'expired';

const CHAT_OPEN_NAVIGATION_TTL_MS = 2500;

type CorrelationRecord = ChatOpenNavigationIntent & {
  status: 'pending' | TerminalStatus;
  ackReturned: boolean;
};

type PendingRecord = CorrelationRecord & {
  token: number;
  timeout: Timer;
};

export type ChatOpenNavigationCoordinator = {
  open: (intent: ChatOpenNavigationIntent) => ChatOpenNavigationAction;
  ack: (streamId: string) => string | null;
  pendingTarget: () => string | null;
  reset: () => void;
};

export function createChatOpenNavigationCoordinator(
  timeoutMs = CHAT_OPEN_NAVIGATION_TTL_MS,
  timers: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> = globalThis,
): ChatOpenNavigationCoordinator {
  let pending: PendingRecord | null = null;
  const recordsByStream = new Map<string, CorrelationRecord>();
  const recordsByCorrelation = new Map<string, CorrelationRecord>();
  let nextToken = 0;

  const remember = (record: CorrelationRecord) => {
    recordsByStream.set(record.streamId, record);
    if (record.correlationId) recordsByCorrelation.set(record.correlationId, record);
  };

  const finishPending = (status: TerminalStatus): CorrelationRecord | null => {
    if (!pending) return null;
    const record = pending;
    timers.clearTimeout(record.timeout);
    pending = null;
    record.status = status;
    remember(record);
    return record;
  };

  const clearPending = () => {
    if (pending) timers.clearTimeout(pending.timeout);
    pending = null;
    recordsByStream.clear();
    recordsByCorrelation.clear();
  };

  const open = (intent: ChatOpenNavigationIntent): ChatOpenNavigationAction => {
    if (!intent.streamId) return 'noop';
    if (pending?.streamId === intent.streamId) return 'noop';
    if (intent.correlationId && recordsByCorrelation.has(intent.correlationId)) return 'noop';

    // Suppression is IN-FLIGHT only (the two guards above): a duplicate tap while
    // the same stream's intent is still pending, or a replayed correlation id.
    // A TERMINAL record must never veto a later open — the terminals exist so a
    // late or out-of-order ack can still resolve its correlation, not to decide
    // navigation. Vetoing on a completed terminal is what made "open A, back,
    // tap A again" do nothing in production
    // (public_behavior_spec).
    const action: ChatOpenNavigationAction = pending ? 'replace' : 'push';
    if (pending) finishPending('cancelled');

    const token = ++nextToken;
    const timeout = timers.setTimeout(() => {
      if (pending?.token !== token) return;
      const expired = pending;
      pending = null;
      expired.status = 'expired';
      remember(expired);
    }, timeoutMs);
    const record: PendingRecord = {
      ...intent,
      status: 'pending',
      ackReturned: false,
      token,
      timeout,
    };
    record.timeout = timeout;
    pending = record;
    remember(record);
    return action;
  };

  return {
    open,
    ack(streamId) {
      if (pending?.streamId === streamId) {
        const completed = finishPending('completed');
        if (!completed || completed.ackReturned) return null;
        completed.ackReturned = true;
        return completed.correlationId;
      }

      const terminal = recordsByStream.get(streamId);
      if (!terminal || terminal.status !== 'cancelled' || terminal.ackReturned) return null;
      terminal.ackReturned = true;
      return terminal.correlationId;
    },
    pendingTarget() {
      return pending?.streamId ?? null;
    },
    reset: clearPending,
  };
}

// This singleton is intentionally consumed only by Chats row opens and the
// destination focus acknowledgement. Harness tab navigation retains its own
// deliberate idempotent push behavior.
const appCoordinator = createChatOpenNavigationCoordinator();

export function openChatRowNavigationIntent(
  streamId: string,
  correlationId: string | null,
): ChatOpenNavigationAction {
  return appCoordinator.open({ streamId, correlationId });
}

export function acknowledgeChatRowNavigationIntent(streamId: string): string | null {
  return appCoordinator.ack(streamId);
}

// Called when the Chats list regains focus (app/(tabs)/chats.tsx) — the user is
// back at the list, so every intent from the previous open is stale. This runs in
// EVERY environment: it is the release point that keeps the per-stream and
// per-correlation terminal maps bounded across a session. Tests reuse it as setup.
export function resetChatOpenNavigationIntents() {
  appCoordinator.reset();
}

