import { initialPentacleStreamState, type PentacleSessionSummary } from 'pentacle-chat-core';
import { MACHINES } from '../../../constants/Colors';
import { BART_STREAM_ID } from '../../../src/components/status/statusSelectors';
import { selectLocalAssistantIdentity } from '../../../src/components/bart/assistantIdentity';
function bartSession(streamId: string, overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  return { stream_id: streamId, host: 'hostc', provider: 'claude', session_name: 'assistant',
    last_event_at: '2026-05-16T12:00:00Z', last_text: '', last_kind: 'ASSIST', draft: '',
    pending: false, working: false, online: true, ...overrides };
}

jest.mock('expo-constants', () => require('../../helpers/stubs/expoConstants.cjs'));
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');

test('display-name customization wins over title and tracks the canonical session host', () => {
  const identity = selectLocalAssistantIdentity({ ...initialPentacleStreamState,
    sessions: [bartSession(BART_STREAM_ID, { display_name: ' Lews ', title: 'Older title', host: 'hostc' })] });
  expect(identity).toEqual({ assistantName: 'Lews', icon: { host: 'hostc', kind: 'djinni', color: MACHINES.hostc.accent } });
});

test('missing or blank names default to Assistant and keep the identity lamp', () => {
  const empty = selectLocalAssistantIdentity(initialPentacleStreamState);
  expect(empty.assistantName).toBe('Assistant');
  expect(empty.icon.kind).toBe('djinni');
  expect(selectLocalAssistantIdentity({ ...initialPentacleStreamState,
    sessions: [bartSession(BART_STREAM_ID, { display_name: ' ', title: ' ' })] }).assistantName).toBe('Assistant');
});

test('title fallback and live rename update one identity, while unrelated changes preserve its reference', () => {
  const state = { ...initialPentacleStreamState, sessions: [bartSession(BART_STREAM_ID, { title: 'Example guide' })] };
  const first = selectLocalAssistantIdentity(state);
  expect(first.assistantName).toBe('Example guide');
  expect(selectLocalAssistantIdentity({ ...state, connected: true })).toBe(first);
  expect(selectLocalAssistantIdentity({ ...state, sessions: [{ ...state.sessions[0], display_name: 'Lews' }] }).assistantName).toBe('Lews');
});
