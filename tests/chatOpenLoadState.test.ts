import { selectChatOpenLoadState, shouldPromoteChatOpenTranscript, shouldSelectChatOpenTranscript } from '../src/services/chatOpenLoadState';
import { CHAT_OPEN_LOAD_FIXTURES } from './helpers/chatOpenContract';

test('InteractionManager gate keeps the heavy transcript selector out of the shell frame', () => {
  expect(shouldSelectChatOpenTranscript(true, true, false)).toBe(false);
  expect(shouldSelectChatOpenTranscript(true, true, true)).toBe(true);
  expect(shouldSelectChatOpenTranscript(false, true, true)).toBe(false);
});

test('implements each lane-owned observable shell/load fixture', () => {
  for (const fixture of CHAT_OPEN_LOAD_FIXTURES.filter((item) => item.expectedFuture.length === 0)) {
    expect(selectChatOpenLoadState(fixture.input)).toEqual(fixture.output);
  }
});

test('uses the full-screen loader only for genuine connected no-content loading', () => {
  expect(selectChatOpenLoadState({ preview: false, retainedRows: 0, connected: true, request: 'loading' }).spinner).toBe(true);
  expect(selectChatOpenLoadState({ preview: true, retainedRows: 0, connected: true, request: 'loading' }).spinner).toBe(false);
  expect(selectChatOpenLoadState({ preview: false, retainedRows: 2, connected: true, request: 'loading' }).spinner).toBe(false);
  expect(selectChatOpenLoadState({ preview: false, retainedRows: 0, connected: false, request: 'idle' }).status).toBe('offline');
  expect(selectChatOpenLoadState({ preview: false, retainedRows: 0, connected: true, request: 'error' }).status).toBe('error');
});

test('rows landing during the deferral promote the transcript instead of waiting for the flush', () => {
  // First assistant event of a fresh chat: baseline 0 rows, one row arrives.
  expect(shouldPromoteChatOpenTranscript(false, 0, 1)).toBe(true);
  // A chat opened over retained rows keeps the mount-frame deferral.
  expect(shouldPromoteChatOpenTranscript(false, 4, 4)).toBe(false);
  // Growth over a non-empty baseline still promotes.
  expect(shouldPromoteChatOpenTranscript(false, 4, 5)).toBe(true);
  // Already released: nothing to promote.
  expect(shouldPromoteChatOpenTranscript(true, 0, 1)).toBe(false);
});
