import { initialPentacleStreamState, type PentacleSessionSummary } from 'pentacle-chat-core';
import { MACHINES } from '../../../constants/Colors';
import { BART_STREAM_ID } from '../../../src/components/status/statusSelectors';
import { assistantAccent } from '../../../src/components/bart/assistantIdentity';
import { selectAssistantIdentity } from '../../../src/services/assistantIdentity';
function bartSession(streamId: string, overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  return { stream_id: streamId, host: 'hostc', provider: 'claude', session_name: 'assistant',
    last_event_at: '2026-05-16T12:00:00Z', last_text: '', last_kind: 'ASSIST', draft: '',
    pending: false, working: false, online: true, ...overrides };
}

jest.mock('expo-constants', () => require('../../helpers/stubs/expoConstants.cjs'));
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');

test('display-name customization wins over title and the lamp takes the canonical session host accent', () => {
  const identity = selectAssistantIdentity({ ...initialPentacleStreamState,
    sessions: [bartSession(BART_STREAM_ID, { display_name: ' Lews ', title: 'Older title', host: 'hostc' })] });
  expect(identity).toEqual({ streamId: BART_STREAM_ID, name: 'Lews', hostId: 'hostc', sigilKind: 'djinni' });
  expect(assistantAccent(identity)).toBe(MACHINES.hostc.accent);
});

test('missing or blank names default to Assistant and keep the identity lamp', () => {
  const empty = selectAssistantIdentity(initialPentacleStreamState);
  expect(empty.name).toBe('Assistant');
  expect(empty.sigilKind).toBe('djinni');
  expect(selectAssistantIdentity({ ...initialPentacleStreamState,
    sessions: [bartSession(BART_STREAM_ID, { display_name: ' ', title: ' ' })] }).name).toBe('Assistant');
});

test('title fallback and live rename update one identity, while unrelated changes preserve its reference', () => {
  const state = { ...initialPentacleStreamState, sessions: [bartSession(BART_STREAM_ID, { title: 'Example guide' })] };
  const first = selectAssistantIdentity(state);
  expect(first.name).toBe('Example guide');
  expect(selectAssistantIdentity({ ...state, connected: true } as typeof state)).toBe(first);
  expect(selectAssistantIdentity({ ...state, sessions: [{ ...state.sessions[0], display_name: 'Lews' }] }).name).toBe('Lews');
});
