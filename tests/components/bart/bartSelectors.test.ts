import { selectSmartChatList, smartChatAttention } from '../../../app/(tabs)/chats';
import { BART_STREAM_ID } from '../../../src/components/status/statusSelectors';
import { selectOthersNeedingYou } from '../../../src/components/bart/bartSelectors';
import { bartQuestion, bartSession, bartState, NOW } from './fixtures';

jest.mock('expo-constants', () => require('../../helpers/stubs/expoConstants.cjs'));
jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');

beforeEach(() => { jest.useFakeTimers({ now: new Date(NOW) }); });

test('needs-you exactly matches Chats attention order, excluding Bart and retaining question-only rows', () => {
  const state = { ...bartState(), sessions: [bartSession(BART_STREAM_ID),
    bartSession('hostc:claude:idle'), bartSession('hostc:claude:working', { working: true }),
    bartSession('hostc:claude:needs-you'), bartSession('hostc:claude:hidden', { visibility: 'hidden' })],
    notifications: [bartQuestion(BART_STREAM_ID), bartQuestion('hostc:claude:needs-you'), bartQuestion('hostc:claude:missing')] };
  const before = JSON.stringify(state);
  const expected = selectSmartChatList(state).filter((chat) => chat.streamId !== BART_STREAM_ID && smartChatAttention(chat));
  expect(selectOthersNeedingYou(state)).toEqual(expected);
  expect(expected.map((chat) => chat.streamId)).toEqual(expect.arrayContaining(['hostc:claude:needs-you', 'hostc:claude:missing']));
  expect(expected).toHaveLength(2);
  expect(JSON.stringify(state)).toBe(before);
});

test('empty state and Bart-only questions have zero other sessions needing attention', () => {
  expect(selectOthersNeedingYou(bartState())).toEqual([]);
  expect(selectOthersNeedingYou({ ...bartState(), sessions: [bartSession(BART_STREAM_ID)], notifications: [bartQuestion(BART_STREAM_ID, 2)] })).toEqual([]);
});

test('drawer groups preserve Chats ordering, attention wins, and Bart is never listed', () => {
  const { selectDrawerGroups } = require('../../../src/components/bart/bartSelectors');
  const state = { ...bartState(), sessions: [bartSession(BART_STREAM_ID, { working: true }),
    bartSession('hostc:claude:working', { working: true }), bartSession('hostc:claude:idle'),
    bartSession('hostc:claude:working-needs', { working: true }), bartSession('hostc:claude:needs')],
    notifications: [bartQuestion(BART_STREAM_ID), bartQuestion('hostc:claude:working-needs'), bartQuestion('hostc:claude:needs')] };
  const chats = selectSmartChatList(state).filter((chat) => chat.streamId !== BART_STREAM_ID);
  const groups = selectDrawerGroups(state);
  expect(groups.map((group: any) => [group.title, group.chats.length])).toEqual([['NEEDS YOU', 2], ['WORKING', 1], ['IDLE', 1]]);
  expect(groups[0].chats).toEqual(selectOthersNeedingYou(state));
  expect(groups[1].chats).toEqual(chats.filter((chat) => !smartChatAttention(chat) && chat.status === 'working'));
  expect(groups[2].chats).toEqual(chats.filter((chat) => !smartChatAttention(chat) && chat.status !== 'working'));
});
