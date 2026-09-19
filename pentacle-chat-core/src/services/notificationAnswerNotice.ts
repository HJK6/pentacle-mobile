// Canonical parser for the durable notification-answer notice.
//
// QA-F2 (spec_pentacle__mobile_question_answer_lane_stuck_sending_2026_09): this is
// the SINGLE client home for the notification-answer format. The daemon delivers the
// operator's answer to the asking agent's pane as a notice whose stored event text is:
//
//     [pentacle-notice:notification-answer-<id>]      <- outbound_notices.ensure_notice_marker
//     [notification.answer]                            <- notify.py _answer_back_text
//     notification_id=<id>
//     (answer=<csv> | text=<free> | custom_text=<txt>) [choice=<bool>] [note=<txt>]
//     by=operator
//
// A legacy JSON envelope ({"type":"notification.answer", ...}) is also still parsed
// (spec_pentacle__notification_answer_raw_json_bubble_2026_07). Every consumer — the
// event interpreter (display), the mobile reconciliation predicate, and the mobile
// screen formatter — goes through this one function so the format has exactly one home.

export interface NotificationAnswerNotice {
  notificationId: string;
  actionKind: string;
  /** Display-ready answer string (may be '' for a note-only answer). */
  answer: string;
  note: string;
  selections: string[];
  choice?: boolean;
  /** Free text / custom text as typed by the operator. */
  text: string;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return objectValue(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

// Wrapper tokens that can sit in front of the answer body: the pane notice marker,
// a peer `[from …]` envelope, and a `[tell:…]` id. Strip them (in any leading order)
// so the body starts at `[notification.answer]` or the JSON envelope.
const LEADING_WRAPPER_RE = /^\s*(\[pentacle-notice:[^\]]+\]|\[from [^\]]+\]|\[tell:[^\]]+\])\s*/;

function stripLeadingWrappers(text: string): string {
  let current = String(text || '').replace(/\r\n?/g, '\n');
  let previous: string;
  do {
    previous = current;
    current = current.replace(LEADING_WRAPPER_RE, '');
  } while (current !== previous);
  return current;
}

function noticeFromKeyValue(body: string): NotificationAnswerNotice | null {
  const lines = body.split('\n');
  if (lines.shift()?.trim() !== '[notification.answer]') return null;
  const fields = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!fields.has(key)) fields.set(key, line.slice(separator + 1).trim());
  }
  const notificationId = fields.get('notification_id') || '';
  if (!notificationId) return null;
  const selections = (fields.get('answer') || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const freeText = fields.get('text') || fields.get('custom_text') || '';
  const choiceRaw = fields.get('choice');
  const choice = choiceRaw === 'True' || choiceRaw === 'true'
    ? true
    : choiceRaw === 'False' || choiceRaw === 'false'
      ? false
      : undefined;
  const note = fields.get('note') || '';
  const answer = freeText
    || selections.join(', ')
    || (choice === true ? 'Yes' : choice === false ? 'No' : '');
  return {
    notificationId,
    actionKind: fields.get('action_kind') || 'answered',
    answer,
    note,
    selections,
    ...(choice === undefined ? {} : { choice }),
    text: freeText,
  };
}

function noticeFromJson(body: string): NotificationAnswerNotice | null {
  const payload = parseJsonObject(body);
  if (payload?.type !== 'notification.answer') return null;
  const answerObj = objectValue(payload.answer);
  if (!answerObj) return null;
  const freeText = stringValue(answerObj.text);
  const label = stringValue(answerObj.label);
  const selections = Array.isArray(answerObj.selections)
    ? answerObj.selections.map(stringValue).filter(Boolean)
    : [];
  const value = objectValue(answerObj.value);
  const valueAnswer = stringValue(value?.answer);
  const fallbackValue = stringValue(answerObj.value);
  const actionKind = stringValue(answerObj.action_kind) || 'answered';
  const labelAnswer = label && label.toLowerCase() !== actionKind.toLowerCase() ? label : '';
  // A bare yes/no carries its meaning only in `choice` (no free text/selections/value).
  const choice = typeof answerObj.choice === 'boolean' ? answerObj.choice : undefined;
  const choiceAnswer = choice === true ? 'Yes' : choice === false ? 'No' : '';
  const answer = freeText
    || labelAnswer
    || selections.join(', ')
    || valueAnswer
    || fallbackValue
    || choiceAnswer;
  const note = stringValue(answerObj.note);
  // Accept the id from either position: the daemon nests it inside `answer`, but the
  // envelope has also been observed with it at the top level.
  const notificationId = stringValue(answerObj.notification_id) || stringValue(payload.notification_id);
  return {
    notificationId,
    actionKind,
    answer,
    note,
    selections,
    ...(choice === undefined ? {} : { choice }),
    text: freeText,
  };
}

/**
 * Parse the full stored notice event text (marker/peer/tell wrappers + key=value
 * body, or a legacy JSON envelope) into a normalized answer. Returns null when the
 * text is not a notification-answer notice.
 */
export function parseNotificationAnswerNotice(text: string): NotificationAnswerNotice | null {
  const body = stripLeadingWrappers(text);
  return noticeFromKeyValue(body) ?? noticeFromJson(body);
}

/** True when any line of `text` carries a notification-answer notice (either form). */
export function textHasNotificationAnswerNotice(text: string): boolean {
  if (parseNotificationAnswerNotice(text)) return true;
  // A JSON envelope can also arrive concatenated on one of several lines.
  return String(text || '')
    .split('\n')
    .some((line) => parseJsonObject(line)?.type === 'notification.answer');
}
