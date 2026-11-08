import type { HarnessFixture } from './screenshotFixtures';
import type { PentacleSessionSummary, PentacleNotification } from 'pentacle-chat-core';
import { ASSISTANT_STREAM_ID } from '../services/assistantIdentity';
import { lanesFlowFixture } from './lanesFlowFixture';

/** Synthetic input for real Assistant transcript captures, including a lane-sourced question. */
export function questionsEmbeddedFixture(): HarnessFixture {
  const now = new Date().toISOString();
  const source = 'hosta:sample-lead';
  const session = (id: string, title: string): PentacleSessionSummary => ({
    stream_id: id, host: 'hosta', provider: id === ASSISTANT_STREAM_ID ? 'composite' : 'codex',
    session_name: id === ASSISTANT_STREAM_ID ? 'assistant' : 'sample-lead', title,
    online: true, working: false, draft: '', pending: false, last_event_at: now, last_kind: 'ASSIST_TEXT', last_text: 'Ready for review.',
  });
  const question = (n: number): PentacleNotification => ({
    notification_id: `embedded-sample-${n}`, created_at: now, updated_at: now,
    producer: 'agent_question.v1', answer_to_stream_id: source, severity: 'info',
    title: 'Review window', body: n === 1 ? 'Which review window should I use?' : 'Should I include the test summary?',
    dedup_key: `embedded-sample-${n}`, state: 'open', actions: [{ kind: 'ack', action_id: 'answer' }],
    question: { question_id: `q-embedded-${n}`, producer_stream_id: source, state: 'open', response_mode: 'single_choice',
      options: [{ label: 'Use the next window', value: 'next' }, { label: 'Wait for the morning', value: 'morning' }] },
  } as PentacleNotification);
  const inventory = lanesFlowFixture().inventory;
  // One lead owns this question. The lookup should choose its lane's icon, without a machine sigil.
  const lane = { ...inventory.lanes[3], lead: { ...inventory.lanes[3].lead!, stream_id: source } };
  return {
    snapshot: {
      sessions: [session(ASSISTANT_STREAM_ID, 'Assistant'), session(source, 'Design review')],
      hosts: { hosta: { host: 'hosta', online: true, checked_at: now, session_count: 2 } },
      notifications: [question(1), question(2)],
      events: [{ daemon_seq: 1, stream_id: ASSISTANT_STREAM_ID, host: 'hosta', provider: 'composite',
        session_id: ASSISTANT_STREAM_ID, session_name: 'assistant', timestamp: now, kind: 'ASSIST_TEXT',
        text: 'The review is ready. Choose a window below and I will carry on.', publish_kind: 'prose' }],
      work_lanes: { type: 'work_lanes.inventory', lanes: [lane], counts: { open: 1, active: 1, paused: 0, blocked: 0 }, truncated: false, generated_at: now },
    },
    opts: { hasHydrated: true, connected: true, connecting: false },
  };
}
