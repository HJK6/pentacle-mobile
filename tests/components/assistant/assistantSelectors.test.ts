import { selectSmartChatList, smartChatAttention } from '../../../app/(tabs)/chats';
import { ASSISTANT_STREAM_ID } from '../../../src/services/assistantIdentity';
import { selectOthersNeedingYou } from '../../../src/components/assistant/assistantSelectors';
import { assistantQuestion, assistantSession, assistantState, NOW } from './fixtures';

jest.mock('expo-constants', () => require('../../helpers/stubs/expoConstants.cjs'));
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');

beforeEach(() => { jest.useFakeTimers({ now: new Date(NOW) }); });

test('needs-you exactly matches Chats attention order, excluding the assistant and retaining question-only rows', () => {
  const state = { ...assistantState(), sessions: [assistantSession(ASSISTANT_STREAM_ID),
    assistantSession('hostc:claude:idle'), assistantSession('hostc:claude:working', { working: true }),
    assistantSession('hostc:claude:needs-you'), assistantSession('hostc:claude:hidden', { visibility: 'hidden' })],
    notifications: [assistantQuestion(ASSISTANT_STREAM_ID), assistantQuestion('hostc:claude:needs-you'), assistantQuestion('hostc:claude:missing')] };
  const before = JSON.stringify(state);
  const expected = selectSmartChatList(state).filter((chat) => chat.streamId !== ASSISTANT_STREAM_ID && smartChatAttention(chat));
  expect(selectOthersNeedingYou(state)).toEqual(expected);
  expect(expected.map((chat) => chat.streamId)).toEqual(expect.arrayContaining(['hostc:claude:needs-you', 'hostc:claude:missing']));
  expect(expected).toHaveLength(2);
  expect(JSON.stringify(state)).toBe(before);
});

test('empty state and assistant-only questions have zero other sessions needing attention', () => {
  expect(selectOthersNeedingYou(assistantState())).toEqual([]);
  expect(selectOthersNeedingYou({ ...assistantState(), sessions: [assistantSession(ASSISTANT_STREAM_ID)], notifications: [assistantQuestion(ASSISTANT_STREAM_ID, 2)] })).toEqual([]);
});

test('drawer groups preserve Chats ordering, attention wins, and the assistant is never listed', () => {
  const { selectDrawerGroups } = require('../../../src/components/assistant/assistantSelectors');
  const state = { ...assistantState(), sessions: [assistantSession(ASSISTANT_STREAM_ID, { working: true }),
    assistantSession('hostc:claude:working', { working: true }), assistantSession('hostc:claude:idle'),
    assistantSession('hostc:claude:working-needs', { working: true }), assistantSession('hostc:claude:needs')],
    notifications: [assistantQuestion(ASSISTANT_STREAM_ID), assistantQuestion('hostc:claude:working-needs'), assistantQuestion('hostc:claude:needs')] };
  const chats = selectSmartChatList(state).filter((chat) => chat.streamId !== ASSISTANT_STREAM_ID);
  const groups = selectDrawerGroups(state);
  expect(groups.map((group: any) => [group.title, group.chats.length])).toEqual([['NEEDS YOU', 2], ['WORKING', 1], ['IDLE', 1]]);
  expect(groups[0].chats).toEqual(selectOthersNeedingYou(state));
  expect(groups[1].chats).toEqual(chats.filter((chat) => !smartChatAttention(chat) && chat.status === 'working'));
  expect(groups[2].chats).toEqual(chats.filter((chat) => !smartChatAttention(chat) && chat.status !== 'working'));
});
