/**
 * Screenshot-harness fixtures (spec: example-mobile mock screenshot harness).
 *
 * Each entry is a snapshot-shaped object — the same shape the WS `snapshot`
 * message carries (see pentacleStream.handleMessage `message.type ===
 * 'snapshot'`). The harness seeds these via `harnessSeedSnapshot`, which runs
 * them through the production reducers (applySnapshotWithOptimisticReconciliation
 * + applyNotificationList) so the seeded state is faithful to the live wire
 * path. Shapes are built from pentacle-chat-core exported TYPES so `tsc`
 * catches drift, and the host keys (hosta/hostc/hostb) match
 * pentacle.config.local.ts so host themes resolve to real colors.
 *
 * This module is only imported by src/harness/screenshotHarness.ts, which is
 * itself gated on EXPO_PUBLIC_SCREENSHOT_HARNESS, so production dead-codes it.
 */
import type {
  PentacleEvent,
  PentacleHostStatus,
  PentacleLimit,
  PentacleMachineStats,
  PentacleNotification,
  PentacleQuestion,
  PentacleSessionSummary,
  SessionStatusCard,
  PentacleUpdateMessage,
} from "pentacle-chat-core";
import type { AssetComment, PentacleReport } from "../services/pentacleAssets";

export type HarnessSnapshot = {
  events?: PentacleEvent[];
  drafts?: Record<string, PentacleEvent>;
  hosts?: Record<string, PentacleHostStatus>;
  hosts_stats?: Record<string, PentacleMachineStats>;
  sessions?: PentacleSessionSummary[];
  limits?: PentacleLimit[];
  updates?: PentacleUpdateMessage[];
  notifications?: PentacleNotification[];
};

export type HarnessSeedOpts = {
  connected?: boolean;
  connecting?: boolean;
  hasHydrated?: boolean;
  lastError?: string;
};

export type HarnessFixture = {
  snapshot: HarnessSnapshot;
  opts?: HarnessSeedOpts;
  assets?: {
    streamId: string;
    reports: PentacleReport[];
    comments?: AssetComment[];
    closed?: boolean;
    error?: string | null;
    loading?: boolean;
  };
};

export type HarnessScreen =
  "chats" | "updates" | "settings" | "enroll" | "session";
export type HarnessVariant =
  | 'populated'
  | 'empty'
  | 'loading'
  | 'error'
  | 'default'
  | 'question'
  | 'rich_markdown'
  | 'wide_table'
  | 'tool_call_latest'
  | 'offline'
  | 'native_question'
  | 'status_card';

// ---------------------------------------------------------------------------
// Shared building blocks (fixed timestamps for deterministic renders).
// ---------------------------------------------------------------------------

const T0 = "2026-05-30T16:00:00.000Z";

function hostStatus(
  host: string,
  online: boolean,
  sessionCount: number,
): PentacleHostStatus {
  return {
    host,
    online,
    checked_at: T0,
    session_count: sessionCount,
    ...(online ? {} : { error: "example network unreachable" }),
  };
}

const GiB = 1024 * 1024 * 1024;

function machineStats(
  over: Partial<PentacleMachineStats> & { host: string },
): PentacleMachineStats {
  return {
    cpu_load_1m: 1.42,
    memory_used_bytes: 30 * GiB,
    memory_total_bytes: 64 * GiB,
    disk_used_bytes: 300 * GiB,
    disk_total_bytes: 512 * GiB,
    uptime_seconds: 4 * 86400,
    // Fresh by default so populated fixtures render "LIVE"; a stale fixture can
    // override sampled_at.
    sampled_at: new Date().toISOString(),
    ...over,
  };
}

function session(
  over: Partial<PentacleSessionSummary> & {
    stream_id: string;
    host: string;
    provider: string;
    session_name: string;
  },
): PentacleSessionSummary {
  return {
    last_event_at: T0,
    last_text: "",
    last_kind: "ASSIST",
    draft: "",
    pending: false,
    working: false,
    online: true,
    ...over,
  };
}

function userEvent(
  streamId: string,
  host: string,
  provider: string,
  sessionName: string,
  seq: number,
  text: string,
  timestamp: string,
): PentacleEvent {
  return {
    daemon_seq: seq,
    host,
    provider,
    session_id: streamId,
    session_name: sessionName,
    stream_id: streamId,
    timestamp,
    kind: "USER",
    text,
  };
}

function assistEvent(
  streamId: string,
  host: string,
  provider: string,
  sessionName: string,
  seq: number,
  text: string,
  timestamp: string,
): PentacleEvent {
  return {
    daemon_seq: seq,
    host,
    provider,
    session_id: streamId,
    session_name: sessionName,
    stream_id: streamId,
    timestamp,
    kind: "ASSIST",
    text,
  };
}

function toolUseEvent(
  streamId: string,
  host: string,
  provider: string,
  sessionName: string,
  seq: number,
  text: string,
  timestamp: string,
): PentacleEvent {
  return {
    daemon_seq: seq,
    host,
    provider,
    session_id: streamId,
    session_name: sessionName,
    stream_id: streamId,
    timestamp,
    kind: "TOOL_USE",
    text,
  };
}

// ---------------------------------------------------------------------------
// Populated combined snapshot — three themed machines, several live chats,
// machine stats, codex usage, updates, and a varied notification set. Used as
// the default first-paint seed and the `populated` variant for chats/settings.
// ---------------------------------------------------------------------------

const POPULATED_HOSTS: Record<string, PentacleHostStatus> = {
  'hosta': hostStatus("hosta", true, 2),
  'hostc': hostStatus("hostc", true, 1),
  'hostb': hostStatus("hostb", false, 0),
};

const POPULATED_MACHINE_STATS: Record<string, PentacleMachineStats> = {
  'hosta': machineStats({
    host: "hosta",
    cpu_load_1m: 2.31,
    memory_used_bytes: 45 * GiB,
    memory_total_bytes: 64 * GiB,
    disk_used_bytes: 279 * GiB,
    disk_total_bytes: 512 * GiB,
    uptime_seconds: 11 * 86400 + 5 * 3600,
  }),
  'hostc': machineStats({
    host: "hostc",
    cpu_load_1m: 0.62,
    memory_used_bytes: 6 * GiB,
    memory_total_bytes: 16 * GiB,
    disk_used_bytes: 424 * GiB,
    disk_total_bytes: 512 * GiB,
    uptime_seconds: 2 * 86400 + 3600,
  }),
  'hostb': machineStats({
    host: "hostb",
    cpu_load_1m: 1.05,
    memory_used_bytes: 20 * GiB,
    memory_total_bytes: 32 * GiB,
    disk_used_bytes: 700 * GiB,
    disk_total_bytes: 1024 * GiB,
    uptime_seconds: 5 * 3600,
  }),
};

const POPULATED_SESSIONS: PentacleSessionSummary[] = [
  session({
    stream_id: "hosta:sample-import",
    host: "hosta",
    provider: "codex",
    session_name: "sample-import",
    display_name: "Sample importer",
    title: "Sample importer",
    last_event_at: "2026-05-30T15:58:40.000Z",
    last_text:
      "Running the example region pass now — 412 rows queued for enrichment.",
    last_kind: "ASSIST",
    working: true,
    working_label: "1m 12s",
  }),
  session({
    stream_id: "hosta:analysis-sample",
    host: "hosta",
    provider: "claude",
    session_name: "analysis-sample",
    display_name: "Analysis session",
    title: "Analysis session",
    last_event_at: "2026-05-30T15:40:00.000Z",
    last_text:
      "Completed the sample comparison.",
    last_kind: "ASSIST",
    draft: "check the OCR coverage report",
  }),
  session({
    stream_id: "hostc:metrics-sample",
    host: "hostc",
    provider: "codex",
    session_name: "metrics-sample",
    display_name: "Metric sample",
    title: "Metric sample",
    last_event_at: "2026-05-30T14:05:00.000Z",
    last_text: "Sample metric calculation finished: score 1.8.",
    last_kind: "ASSIST",
  }),
];

// The stream whose transcript the `session` screen captures. Exported so the
// Playwright driver builds the same /pentacle/session/<id> route the fixture
// seeds events for, and reused by the session:* snapshots below to target the
// analysis-sample transcript. Contains a ':' — URL-encode it in the route.
export const SESSION_STREAM_ID = "hosta:analysis-sample";

const POPULATED_EVENTS: PentacleEvent[] = [
  userEvent(
    "hosta:sample-import",
    "hosta",
    "codex",
    "sample-import",
    1,
    "Kick off the example region scrape.",
    "2026-05-30T15:57:00.000Z",
  ),
  assistEvent(
    "hosta:sample-import",
    "hosta",
    "codex",
    "sample-import",
    2,
    "Running the example region pass now — 412 rows queued for enrichment.",
    "2026-05-30T15:58:40.000Z",
  ),
  userEvent(
    "hosta:analysis-sample",
    "hosta",
    "claude",
    "analysis-sample",
    1,
    "Pull up the sample event market — where's the venue-a/venue-b spread right now?",
    "2026-05-30T15:30:00.000Z",
  ),
  assistEvent(
    "hosta:analysis-sample",
    "hosta",
    "claude",
    "analysis-sample",
    2,
    'venue-a has "option A in June" at 38 units, venue-b at 31 units — a 7 units gross spread, roughly 4.6¢ net per contract after fees.',
    "2026-05-30T15:31:10.000Z",
  ),
  userEvent(
    "hosta:analysis-sample",
    "hosta",
    "claude",
    "analysis-sample",
    3,
    "What size can we get on before it moves?",
    "2026-05-30T15:33:00.000Z",
  ),
  assistEvent(
    "hosta:analysis-sample",
    "hosta",
    "claude",
    "analysis-sample",
    4,
    "venue-b's book is thin above sample-size-a; venue-a can absorb ~sample-size-c. I'd cap the venue-b leg at sample-size-a to stay inside its depth.",
    "2026-05-30T15:34:30.000Z",
  ),
  userEvent(
    "hosta:analysis-sample",
    "hosta",
    "claude",
    "analysis-sample",
    5,
    "Do it — long venue-b, short venue-a, sample-size-a.",
    "2026-05-30T15:38:00.000Z",
  ),
  assistEvent(
    "hosta:analysis-sample",
    "hosta",
    "claude",
    "analysis-sample",
    6,
    "Filled. Long 3,870 venue-b @ 31 units, short 3,158 venue-a @ 38 units — net credit locked: $221 (≈4.6%).",
    "2026-05-30T15:39:30.000Z",
  ),
  assistEvent(
    "hosta:analysis-sample",
    "hosta",
    "claude",
    "analysis-sample",
    7,
    "Completed the sample comparison.",
    "2026-05-30T15:40:00.000Z",
  ),
  userEvent(
    "hostc:metrics-sample",
    "hostc",
    "codex",
    "metrics-sample",
    1,
    "Run the sample metric calculation.",
    "2026-05-30T14:03:00.000Z",
  ),
  assistEvent(
    "hostc:metrics-sample",
    "hostc",
    "codex",
    "metrics-sample",
    2,
    "Sample metric calculation finished: score 1.8.",
    "2026-05-30T14:05:00.000Z",
  ),
];

const POPULATED_LIMITS: PentacleLimit[] = [
  { id: "claude", label: "Claude", pct: 44, resets_at_iso: null, resets_text: "Sun 22:00" },
  { id: "fable", label: "Fable", pct: 31, resets_at_iso: null, resets_text: "Sun 22:00" },
  { id: "codex", label: "Codex", pct: 67, resets_at_iso: "2026-06-01T14:00:00Z", resets_text: "Mon 09:00" },
];

const NULL_LIMITS: PentacleLimit[] = [
  { id: "claude", label: "Claude", pct: null, resets_at_iso: null, resets_text: null },
  { id: "fable", label: "Fable", pct: null, resets_at_iso: null, resets_text: null },
  { id: "codex", label: "Codex", pct: null, resets_at_iso: null, resets_text: null },
];

const POPULATED_UPDATES: PentacleUpdateMessage[] = [
  {
    agent_id: "Example integration-crm",
    timestamp: 1748620800000,
    direction: "inbound",
    message: "CRM sync completed — 38 new sample leads imported.",
    sender: "Example integration",
  },
  {
    agent_id: "example-service",
    timestamp: 1748617200000,
    direction: "outbound",
    message: "Published a sample build to example.local.",
    sender: "Ops",
  },
];

function notification(
  over: Partial<PentacleNotification> & {
    notification_id: string;
    title: string;
    body: string;
  },
): PentacleNotification {
  return {
    created_at: T0,
    updated_at: T0,
    producer: "pentacle",
    severity: "info",
    dedup_key: over.notification_id,
    state: "open",
    actions: [{ kind: "ack", action_id: "a0" }],
    resolution: null,
    ttl_seconds: 86400,
    expires_at: "2026-05-31T16:00:00.000Z",
    resolved_at: null,
    ...over,
  };
}

const POPULATED_NOTIFICATIONS: PentacleNotification[] = [
  notification({
    notification_id: "notif-agent-question-spread",
    title: "Pick the next spread",
    body: "Which sample pair should the analysis agent stage next?",
    severity: "info",
    producer: "agent_question.v1",
    answer_to_stream_id: SESSION_STREAM_ID,
    actions: [{ kind: "yes_no", action_id: "a0" }],
    question: {
      question_id: "q-spread",
      producer_stream_id: SESSION_STREAM_ID,
      response_mode: "single_choice",
      options: [
        { label: "option A", value: "fed_cuts" },
        { label: "option B", value: "cpi_print" },
      ],
      state: "open",
      answer: null,
    },
  }),
  notification({
    notification_id: "notif-approve-deploy",
    title: "Approve production deploy?",
    body: "example-service wants to roll v2026.05.30 to all example network hosts.",
    severity: "warning",
    producer: "example-service",
    actions: [{ kind: "yes_no", action_id: "a0" }],
  }),
  notification({
    notification_id: "notif-gpu-temp",
    title: "hostb GPU temperature high",
    body: "sample device hit 84°C during the last training run.",
    severity: "critical",
    producer: "hostb",
    actions: [{ kind: "ack", action_id: "a0" }],
  }),
  notification({
    notification_id: "notif-spawn-worker",
    title: "Spawn a worker for the scrape backlog?",
    body: "412 sample rows are queued for enrichment on hosta.",
    severity: "info",
    producer: "Example integration",
    actions: [{ kind: "spawn_worker", action_id: "a0" }],
  }),
];

const POPULATED_SNAPSHOT: HarnessSnapshot = {
  hosts: POPULATED_HOSTS,
  hosts_stats: POPULATED_MACHINE_STATS,
  sessions: POPULATED_SESSIONS,
  events: POPULATED_EVENTS,
  limits: POPULATED_LIMITS,
  updates: POPULATED_UPDATES,
  notifications: POPULATED_NOTIFICATIONS,
};

const STATUS_CARD: SessionStatusCard = {
  goal: 'Match the mobile status card to the public session example.',
  plan: [
    { text: 'Lock visual tokens', status: 'done' },
    { text: 'Implement overlay panel', status: 'done' },
    { text: 'Show status states', status: 'active' },
    { text: 'Run checks', status: 'pending' },
    { text: 'Prepare public sample', status: 'pending' },
  ],
  update: 'The status panel is ready for review.',
  updates: [
    { ts: '2026-05-30T15:42:00.000Z', text: 'The fixture includes all status states.' },
    { ts: '2026-05-30T15:50:00.000Z', text: 'The overlay panel and session sheet are ready.' },
    { ts: '2026-05-30T15:58:00.000Z', text: 'The status panel is ready for review.' },
  ],
  specs: [
    { id: 'status-card', label: 'Status-card fidelity', ok: true, updated: 'just now' },
    { id: 'navigation', label: 'Overlay navigation', ok: true, updated: '2m ago' },
    { id: 'review', label: 'Layout review', ok: false, updated: '1m ago', note: 'Awaiting comparison.' },
  ],
  handoff_planned: true,
  updated_at: '2026-05-30T15:58:00.000Z',
};

const STATUS_CARD_SNAPSHOT: HarnessSnapshot = {
  ...POPULATED_SNAPSHOT,
  sessions: POPULATED_SESSIONS.map((item) => (
    item.stream_id === 'hosta:sample-import' || item.stream_id === SESSION_STREAM_ID
      ? { ...item, status_card: STATUS_CARD, context_tokens: 125000, model_context_window: 250000, context_level: 'advisory' }
      : item
  )),
};

// An empty-but-hydrated snapshot still carries hosts + machine stats so the
// machine strip/tabs render; only the per-screen content list is empty.
const EMPTY_SNAPSHOT: HarnessSnapshot = {
  hosts: POPULATED_HOSTS,
  hosts_stats: POPULATED_MACHINE_STATS,
  sessions: [],
  events: [],
  updates: [],
  notifications: [],
};

const SEEDED: HarnessSeedOpts = {
  connected: true,
  connecting: false,
  hasHydrated: true,
};
const LOADING: HarnessSeedOpts = {
  connected: false,
  connecting: true,
  hasHydrated: false,
};
const ERRORED: HarnessSeedOpts = {
  connected: false,
  connecting: false,
  hasHydrated: true,
  lastError:
    "Pentacle could not reach the example network endpoint. Make sure example network is connected.",
};

// Default first-paint seed: fully populated so no screen flashes empty before
// the driver re-seeds the specific (screen, variant).
export const DEFAULT_FIXTURE: HarnessFixture = {
  snapshot: POPULATED_SNAPSHOT,
  opts: SEEDED,
};

// ---------------------------------------------------------------------------
// session:question — the FAB + full-screen AskUserQuestion surface.
// The daemon sets `question` on the session summary when an agent is asking an
// interactive question (PentacleSessionSummary.question); the session screen
// exposes the question FAB when it is present. We mirror that wire shape on the
// analysis-sample session so the real overlay renders
// through the real reducers (cf. spec example-mobile__question_flow_bugs_and_notes).
//
// Note on "multi-select": the question UI is one-choice-per-question (radio
// chips), batched across several questions behind one Submit — there is no
// checkbox multi-select in this component. We exercise the closest real shape:
// a multi-question payload (multi: true) with one pre-selected chip question, a
// second choice question, and a free-text question. Choice bodies use the
// shared label/description/Custom model; supplied question headers are not
// rendered by the mobile surface.
// ---------------------------------------------------------------------------

const QUESTION_PAYLOAD: PentacleQuestion = {
  multi: true,
  prompt: "A couple of checks before I place the next spread:",
  options: [],
  active_index: 1,
  submit_present: true,
  questions: [
    {
      index: 1,
      header: "Source selection",
      prompt: "Which source should I use for the sample?",
      selected_index: 1,
      options: [
        {
          index: 1,
          label: "venue-a",
          description: "Deeper book (~sample-size-c), regulated, ~1.2% fees.",
        },
        {
          index: 2,
          label: "venue-b",
          description: "Thin above sample-size-a, ~0.6% fees, crypto settlement.",
        },
        {
          index: 3,
          label: "Split evenly",
          description: "Halve size across both to cut venue risk.",
        },
      ],
    },
    {
      index: 2,
      header: "Size cap",
      prompt: "What sample size should I use?",
      options: [
        {
          index: 1,
          label: "sample-size-a",
          description: "Stay inside the current book depth.",
        },
        {
          index: 2,
          label: "sample-size-b",
          description: "Accept some slippage for more edge.",
        },
      ],
    },
    {
      index: 3,
      header: "Notes",
      prompt: "Any other notes? (optional)",
      free_text: true,
      options: [],
    },
  ],
};

const QUESTION_SESSIONS: PentacleSessionSummary[] = POPULATED_SESSIONS.map(
  (s) =>
    s.stream_id === SESSION_STREAM_ID
      ? {
          ...s,
          last_kind: "ASSIST",
          last_text:
            "Before I place it — a couple of quick calls for you below.",
          last_event_at: "2026-05-30T15:58:30.000Z",
          draft: "",
          working: false,
          question: QUESTION_PAYLOAD,
        }
      : s,
);

const QUESTION_EVENTS: PentacleEvent[] = [
  ...POPULATED_EVENTS,
  userEvent(
    SESSION_STREAM_ID,
    "hosta",
    "claude",
    "analysis-sample",
    8,
    "Let's line up the next spread.",
    "2026-05-30T15:58:00.000Z",
  ),
  assistEvent(
    SESSION_STREAM_ID,
    "hosta",
    "claude",
    "analysis-sample",
    9,
    "Before I place it — a couple of quick calls for you below.",
    "2026-05-30T15:58:30.000Z",
  ),
];

const QUESTION_SNAPSHOT: HarnessSnapshot = {
  ...POPULATED_SNAPSHOT,
  sessions: QUESTION_SESSIONS,
  events: QUESTION_EVENTS,
};

const TOOL_CALL_LATEST_STREAM_ID = "hostc:claude-tool-call-latest";

const TOOL_CALL_LATEST_SNAPSHOT: HarnessSnapshot = {
  ...POPULATED_SNAPSHOT,
  sessions: [
    session({
      stream_id: TOOL_CALL_LATEST_STREAM_ID,
      host: "hostc",
      provider: "claude",
      session_name: "claude-tool-call-latest",
      display_name: "Tool latest repro",
      title: "Tool latest repro",
      last_event_at: "2026-05-30T16:05:00.000Z",
      last_text: "Tool\nsearch sample",
      last_kind: "TOOL_USE",
    }),
    ...POPULATED_SESSIONS,
  ],
  events: [
    ...POPULATED_EVENTS,
    userEvent(
      TOOL_CALL_LATEST_STREAM_ID,
      "hostc",
      "claude",
      "claude-tool-call-latest",
      20,
      "Please inspect the sample data sync.",
      "2026-05-30T16:04:30.000Z",
    ),
    toolUseEvent(
      TOOL_CALL_LATEST_STREAM_ID,
      "hostc",
      "claude",
      "claude-tool-call-latest",
      21,
      "Tool\nsearch sample",
      "2026-05-30T16:05:00.000Z",
    ),
  ],
};

const OFFLINE_STATUS_SNAPSHOT: HarnessSnapshot = {
  ...POPULATED_SNAPSHOT,
  hosts: {
    ...POPULATED_HOSTS,
    'hostc': {
      ...POPULATED_HOSTS['hostc'],
      online: false,
      host_status_reason: "unreachable",
      host_status_since: "2026-05-30T15:20:00.000Z",
      error: "example network unreachable",
    },
  },
  sessions: POPULATED_SESSIONS.map((item) =>
    item.host === "hostc"
      ? {
          ...item,
          online: false,
          host_status: "offline",
          host_status_reason: "unreachable",
          host_status_since: "2026-05-30T15:20:00.000Z",
        }
      : item,
  ),
};

// ---------------------------------------------------------------------------
// session:rich_markdown — one long assistant bubble exercising the markdown
// renderer (parseTextBlocks → renderMdBlocks → parseMarkdown): H2/H3 headings,
// a bulleted AND a numbered list, a fenced code block, inline `code`, **bold**
// + *italic*, a blockquote, and a small table. Long enough to show wrapping/
// scroll inside the bubble.
// ---------------------------------------------------------------------------

const RICH_MARKDOWN_TEXT = [
  "## Strategy recap",
  "",
  "Here's the **full plan** for the *Fed-decision* spread, end to end.",
  "",
  "### Entry logic",
  "",
  "- Watch the `venue-a/venue-b` basis every minute",
  "- Enter once the gross spread clears **5¢**",
  "- Size the thin leg to the visible book depth",
  "",
  "Execution order:",
  "",
  "1. Pull both order books",
  "2. Compute net edge after fees",
  "3. Fill the short leg first, then hedge the long leg",
  "",
  "> Rule of thumb: never lift more than 60% of the visible top-of-book in a single clip.",
  "",
  "Reference snippet:",
  "",
  "```python",
  "def net_edge(gross, fee=0.012):",
  '    """Net edge per contract after both legs\' fees."""',
  "    return round(gross - 2 * fee, 4)",
  "print(net_edge(0.07))  # -> 0.046",
  "```",
  "",
  "Venue comparison:",
  "",
  "| Venue      | Depth  | Fee  |",
  "| ---------- | ------ | ---- |",
  "| venue-a     | ~$4.0k | 1.2% |",
  "| venue-b | ~sample-size-a | 0.6% |",
  "",
  "Net credit locked so far: `$221` (≈4.6%). Holding both legs into the print.",
].join("\n");

// last_text is left empty so the chat model does NOT synthesize a
// session-summary "fallback tail" row. The summary fallback is built through
// the plain-ASSIST interpreter (which collapses fenced code to "[code hidden]"),
// so any non-empty last_text would never match the rendered claude-jsonl bubble
// and would append a duplicated, code-collapsed tail row below the real one.
const RICH_MARKDOWN_SESSIONS: PentacleSessionSummary[] = POPULATED_SESSIONS.map(
  (s) =>
    s.stream_id === SESSION_STREAM_ID
      ? {
          ...s,
          last_kind: "ASSIST",
          last_text: "",
          last_event_at: "2026-05-30T15:59:40.000Z",
          draft: "",
          working: false,
        }
      : s,
);

// The markdown bubble is seeded as a structured Claude (`claude-jsonl`)
// ASSIST_TEXT event. Plain ASSIST text events have their fenced code blocks
// collapsed to "[code hidden]" by the interpreter (collapseCodeBlocks); the
// structured Claude path preserves them, which is the real wire shape for a
// claude session and what lets the renderer paint the fenced code block.
const richMarkdownEvent: PentacleEvent = {
  ...assistEvent(
    SESSION_STREAM_ID,
    "hosta",
    "claude",
    "analysis-sample",
    9,
    RICH_MARKDOWN_TEXT,
    "2026-05-30T15:59:40.000Z",
  ),
  kind: "ASSIST_TEXT",
  raw: { source: "claude-jsonl" },
};

const RICH_MARKDOWN_EVENTS: PentacleEvent[] = [
  ...POPULATED_EVENTS,
  userEvent(
    SESSION_STREAM_ID,
    "hosta",
    "claude",
    "analysis-sample",
    8,
    "Walk me through the whole strategy in detail.",
    "2026-05-30T15:59:00.000Z",
  ),
  richMarkdownEvent,
];

const RICH_MARKDOWN_SNAPSHOT: HarnessSnapshot = {
  ...POPULATED_SNAPSHOT,
  sessions: RICH_MARKDOWN_SESSIONS,
  events: RICH_MARKDOWN_EVENTS,
};

// ---------------------------------------------------------------------------
// session:wide_table — a single assistant bubble with a table wider than the
// phone viewport, used to prove horizontal panning reveals clipped columns.
// ---------------------------------------------------------------------------

const WIDE_TABLE_TEXT = [
  "Mobile table repro:",
  "",
  "| Spec | State | Decision baked in | Evidence path | Checks owner | Device-build note |",
  "| :--- | :---: | ---: | --- | --- | --- |",
  "| `public_behavior_spec` | In progress | Render parsed cells as a real grid, not flattened text | `artifacts/mobile-screens/session__wide_table_after.png` | hostc Codex Checks | The public build follows this report |",
  "| Narrow tables | Covered | Do not force overflow when two short columns fit | `tests/assistantMarkdown.test.tsx` | Jest | No extra device work |",
  "",
  "Long code line check:",
  "",
  "```ts",
  'const scrollProbe = "abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789-wide-code-line";',
  "```",
].join("\n");

const WIDE_TABLE_SESSIONS: PentacleSessionSummary[] = POPULATED_SESSIONS.map(
  (s) =>
    s.stream_id === SESSION_STREAM_ID
      ? {
          ...s,
          last_kind: "ASSIST",
          last_text: "",
          last_event_at: "2026-05-30T15:59:50.000Z",
          draft: "",
          working: false,
        }
      : s,
);

const wideTableEvent: PentacleEvent = {
  ...assistEvent(
    SESSION_STREAM_ID,
    "hosta",
    "claude",
    "table-scroll-repro",
    11,
    WIDE_TABLE_TEXT,
    "2026-05-30T15:59:50.000Z",
  ),
  kind: "ASSIST_TEXT",
  raw: { source: "claude-jsonl" },
};

const WIDE_TABLE_SNAPSHOT: HarnessSnapshot = {
  ...POPULATED_SNAPSHOT,
  sessions: WIDE_TABLE_SESSIONS,
  events: [
    ...POPULATED_EVENTS,
    userEvent(
      SESSION_STREAM_ID,
      "hosta",
      "claude",
      "table-scroll-repro",
      10,
      "Show me the mobile table overflow repro.",
      "2026-05-30T15:59:30.000Z",
    ),
    wideTableEvent,
  ],
};

// ---------------------------------------------------------------------------
// (screen, variant) registry.
// ---------------------------------------------------------------------------

export const FIXTURES: Record<string, HarnessFixture> = {
  "enroll:default": { snapshot: POPULATED_SNAPSHOT, opts: SEEDED },
  'chats:populated': { snapshot: POPULATED_SNAPSHOT, opts: SEEDED },
  'chats:tool_call_latest': { snapshot: TOOL_CALL_LATEST_SNAPSHOT, opts: SEEDED },
  'chats:offline': { snapshot: OFFLINE_STATUS_SNAPSHOT, opts: SEEDED },
  'chats:native_question': { snapshot: { ...QUESTION_SNAPSHOT, notifications: [] }, opts: SEEDED },
  'chats:status_card': { snapshot: STATUS_CARD_SNAPSHOT, opts: SEEDED },
  'chats:empty': { snapshot: EMPTY_SNAPSHOT, opts: SEEDED },
  'chats:loading': { snapshot: {}, opts: LOADING },
  'chats:error': { snapshot: { hosts: POPULATED_HOSTS, hosts_stats: POPULATED_MACHINE_STATS, sessions: [] }, opts: ERRORED },

  'updates:populated': { snapshot: POPULATED_SNAPSHOT, opts: SEEDED },
  'updates:empty': { snapshot: EMPTY_SNAPSHOT, opts: SEEDED },
  'updates:loading': { snapshot: {}, opts: LOADING },
  'updates:error': { snapshot: { hosts: POPULATED_HOSTS, notifications: [], updates: [] }, opts: ERRORED },

  'settings:populated': { snapshot: POPULATED_SNAPSHOT, opts: SEEDED },
  'settings:empty': { snapshot: { hosts: {}, hosts_stats: {}, sessions: [], limits: NULL_LIMITS }, opts: SEEDED },
  'settings:loading': { snapshot: {}, opts: LOADING },
  'settings:error': { snapshot: { hosts: POPULATED_HOSTS, hosts_stats: POPULATED_MACHINE_STATS, sessions: [] }, opts: ERRORED },
  "session:report_reader": {
    snapshot: POPULATED_SNAPSHOT,
    opts: SEEDED,
    assets: {
      streamId: SESSION_STREAM_ID,
      reports: [
        {
          asset_id: "report-reader-1",
          title: "Sample review",
          content_type: "report",
          producer: "example-source",
          read: false,
          updated_at: T0,
          body: {
            schema_version: 1,
            title: "Sample review",
            sections: [
              {
                id: "findings",
                title: "Findings",
                status: "attention",
                blocks: [
                  {
                    id: "summary",
                    type: "para",
                    runs: [
                      "The reader now uses the dark report surface with ",
                      { chip: "exact tokens", kind: "file" },
                      ".",
                    ],
                  },
                  {
                    id: "checks",
                    type: "list",
                    ordered: true,
                    items: [
                      ["Review the report chrome"],
                      ["Confirm thread states"],
                    ],
                  },
                  {
                    id: "matrix",
                    type: "table",
                    columns: ["Gate", "State"],
                    rows: [
                      [["Visual"], [{ chip: "Ready", status: "ok" }]],
                      [["Harness"], [{ chip: "Review", status: "warn" }]],
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
      comments: [
        {
          comment_id: "fixture-comment-1",
          asset_id: "report-reader-1",
          section_id: "findings",
          block_id: "summary",
          excerpt: "The reader now uses the dark report surface.",
          body: "Keep the title hierarchy visible.",
          author: "user@example.com",
          created_at: T0,
        },
      ],
    },
  },
  "session:report_multi_unread": {
    snapshot: POPULATED_SNAPSHOT,
    opts: SEEDED,
    assets: {
      streamId: SESSION_STREAM_ID,
      reports: [
        {
          asset_id: "report-read",
          title: "Read latest",
          content_type: "report",
          producer: "example-source",
          read: true,
          read_at: T0,
          updated_at: "2026-05-31T16:00:00.000Z",
          body: { schema_version: 1, title: "Read latest", sections: [] },
        },
        {
          asset_id: "report-unread",
          title: "Unread review",
          content_type: "report",
          producer: "example-source",
          read: false,
          updated_at: T0,
          body: {
            schema_version: 1,
            title: "Unread review",
            sections: [
              {
                id: "review",
                title: "Review",
                status: "attention",
                blocks: [
                  { id: "one", type: "para", runs: ["Unread fixture body."] },
                ],
              },
            ],
          },
        },
      ],
    },
  },
  "session:report_closed_session": {
    snapshot: POPULATED_SNAPSHOT,
    opts: SEEDED,
    assets: {
      streamId: SESSION_STREAM_ID,
      reports: [
        {
          asset_id: "report-closed",
          title: "Closed session report",
          content_type: "report",
          producer: "example-source",
          read: true,
          updated_at: T0,
          body: {
            schema_version: 1,
            title: "Closed session report",
            sections: [
              {
                id: "archived",
                title: "Archived findings",
                status: "reference",
                blocks: [
                  {
                    id: "body",
                    type: "para",
                    runs: ["This report remains readable after closing."],
                  },
                ],
              },
            ],
          },
        },
      ],
      closed: true,
    },
  },
  "session:report_error": {
    snapshot: POPULATED_SNAPSHOT,
    opts: SEEDED,
    assets: {
      streamId: SESSION_STREAM_ID,
      reports: [],
      error: "Harness asset RPC error",
    },
  },
  "session:populated": { snapshot: POPULATED_SNAPSHOT, opts: SEEDED },
  "session:loading": { snapshot: {}, opts: LOADING },
  // session:question — the FAB/overlay AskUserQuestion flow (question_flow feature).
  "session:question": { snapshot: QUESTION_SNAPSHOT, opts: SEEDED },
  // session:rich_markdown — one long assistant bubble exercising the markdown renderer.
  "session:rich_markdown": { snapshot: RICH_MARKDOWN_SNAPSHOT, opts: SEEDED },
  // session:wide_table — wide markdown table + long code line for horizontal pan evidence.
  'session:wide_table': { snapshot: WIDE_TABLE_SNAPSHOT, opts: SEEDED },
  'session:status_card': { snapshot: STATUS_CARD_SNAPSHOT, opts: SEEDED },
};

FIXTURES["session:report_thread"] = FIXTURES["session:report_reader"];
FIXTURES["session:report_delete_confirm"] = FIXTURES["session:report_reader"];
FIXTURES["session:report_wide_table"] = {
  snapshot: POPULATED_SNAPSHOT,
  opts: SEEDED,
  assets: {
    streamId: SESSION_STREAM_ID,
    reports: [{
      asset_id: "report-wide-table",
      title: "Wide report matrix",
      content_type: "report",
      producer: "example-source",
      read: false,
      updated_at: T0,
      body: { schema_version: 1, title: "Wide report matrix", sections: [{
        id: "matrix-section", title: "Evidence matrix", status: "reference", blocks: [{
          id: "wide-matrix", type: "table",
          columns: ["Item", "Reviewer", "Validation", "Disposition", "Evidence"],
          rows: [
            [["Reports reader sample review"], ["hostc Codex"], ["30 state capture"], ["Ready for review"], ["session__report_wide_table.png"]],
            [["Horizontal scroll interaction"], ["Example checks"], ["Scroll offset asserted"], ["Verified"], ["visible right-side columns"]],
          ],
        }],
      }] },
    }],
  },
};
FIXTURES["session:report_loading"] = {
  snapshot: POPULATED_SNAPSHOT,
  opts: SEEDED,
  assets: { streamId: SESSION_STREAM_ID, reports: [], loading: true },
};
FIXTURES["chats:report_reader"] = FIXTURES["session:report_reader"];

export function getFixture(
  screen: string,
  variant: string,
): HarnessFixture | undefined {
  return FIXTURES[`${screen}:${variant}`];
}
