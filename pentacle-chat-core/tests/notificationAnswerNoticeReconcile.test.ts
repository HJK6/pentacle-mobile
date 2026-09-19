import assert from 'node:assert/strict';
import test from 'node:test';

import { parseNotificationAnswerNotice } from '../src/index.ts';

// spec_pentacle__mobile_question_answer_lane_stuck_sending_2026_09 — QA-F2/AC4.
// The single home for the notification-answer notice format. It is consumed by the
// mobile reconciliation predicate (findMatchingOptimisticId) to extract the
// notification_id from the live daemon notice so the queued optimistic answer row
// reconciles and the lane leaves "sending".
//
// NOTE (main integration): on origin/main the notice DISPLAY is governed by the
// "trusted notification answer origin" provenance feature (proven transport is
// hidden; genuine user copies stay visible — see
// tests/contracts/trusted_notification_answer_origin.test.ts), so this parser is
// intentionally NOT wired into the interpreter/screen display path here; it is the
// reconciler's parser. These are the exact live daemon bytes (pid 91146, runtime
// 88fa028a) from sessions.db session_event_tail for the two operator lanes.

const NOTICE_YES_NO = [
  '[pentacle-notice:notification-answer-9bf54cd1-36ec-4935-abdc-2e74a62d24fb]',
  '[notification.answer]',
  'notification_id=9bf54cd1-36ec-4935-abdc-2e74a62d24fb',
  'answer=continue_2000',
  'choice=False',
  'by=operator',
].join('\n');

const CUSTOM_TEXT = 'Please explain option one and use the updated example version.';
const NOTICE_CUSTOM_TEXT = [
  '[pentacle-notice:notification-answer-2e164027-63c6-4330-91ae-c6e9a02511e5]',
  '[notification.answer]',
  'notification_id=2e164027-63c6-4330-91ae-c6e9a02511e5',
  `custom_text=${CUSTOM_TEXT}`,
  'by=operator',
].join('\n');

// AC4: the exact stored live event text (marker + notify.py key=value body) parses.
test('parseNotificationAnswerNotice reads the live yes_no notice (marker + key=value)', () => {
  const notice = parseNotificationAnswerNotice(NOTICE_YES_NO);
  assert.equal(notice?.notificationId, '9bf54cd1-36ec-4935-abdc-2e74a62d24fb');
  assert.deepEqual(notice?.selections, ['continue_2000']);
  assert.equal(notice?.choice, false);
  assert.equal(notice?.answer, 'continue_2000');
});

test('parseNotificationAnswerNotice reads the live custom_text notice', () => {
  const notice = parseNotificationAnswerNotice(NOTICE_CUSTOM_TEXT);
  assert.equal(notice?.notificationId, '2e164027-63c6-4330-91ae-c6e9a02511e5');
  assert.equal(notice?.text, CUSTOM_TEXT);
  assert.equal(notice?.answer, CUSTOM_TEXT);
});

test('parseNotificationAnswerNotice still reads the legacy JSON envelope (no regression)', () => {
  const json = JSON.stringify({
    type: 'notification.answer',
    answer: { notification_id: 'q-json', action_kind: 'select', label: 'Beta', selections: ['beta'] },
  });
  const notice = parseNotificationAnswerNotice(`[from daemon:notifications]\n[tell:notification-answer-q-json]${json}`);
  assert.equal(notice?.notificationId, 'q-json');
  assert.equal(notice?.answer, 'Beta');
});

test('parseNotificationAnswerNotice returns null for ordinary text and quoted notices', () => {
  assert.equal(parseNotificationAnswerNotice('whats the current count'), null);
  assert.equal(parseNotificationAnswerNotice('Operator answered: continue_2000'), null);
  // A user message that QUOTES a notice body (leading non-wrapper line) is NOT a notice.
  assert.equal(parseNotificationAnswerNotice(`Operator quoted:\n${NOTICE_YES_NO}`), null);
});
