import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  collapsedDisclosurePresentation,
  interpretPentacleEvent,
  type PentacleEvent,
} from '../src/index.ts';

const STREAM_ID = 'hosta:v2-parent-fixture';

function event(text: string, overrides: Partial<PentacleEvent> = {}): PentacleEvent {
  return {
    daemon_seq: 4101,
    host: 'hosta',
    provider: 'codex',
    session_id: 'fixture-parent-generation',
    session_name: 'v2-parent-fixture',
    stream_id: STREAM_ID,
    timestamp: '2026-01-02T03:04:05.000Z',
    kind: 'USER',
    text,
    raw: {
      source: 'structured',
      transport: 'codex-rollout',
      jsonl_record_uuid: 'fixture-report-record',
    },
    ...overrides,
  };
}

function reportEnvelope(summary: string, options: {
  reportId?: string;
  qa?: boolean;
  trailer?: boolean;
  markerDigest?: string;
} = {}) {
  const reportId = options.reportId ?? 'fixture-report-0001';
  const digest = options.markerDigest ?? createHash('sha256').update(reportId).digest('hex');
  return [
    `[pentacle-notice:child-report-ready-v2-${digest}]`,
    '[child_report_ready]',
    `report_id=${reportId}`,
    'ledger_row_id=7001',
    'child_stream_id=hostb:v2-child-fixture',
    'msg_id=fixture-message-0001',
    'status=done',
    ...(options.qa ? [
      'qa_attestation_state=unverified',
      'qa_attestation_reasons=missing_attestation,source_unbound',
    ] : []),
    `summary=${summary}`,
    ...(options.trailer === false ? [] : [
      'effective_model=gpt-5.6-sol',
      'effective_effort=high',
    ]),
  ].join('\n');
}

test('complete synthetic legacy report is visible Subagent activity with summary-only disclosure', () => {
  const summary = 'Synthetic source-binding review completed with exact fixture evidence retained for the full presentation contract.';
  const result = interpretPentacleEvent(event(reportEnvelope(summary)), 'Host A');

  assert.equal(result.caseId, 'subagent-report');
  assert.equal(result.displayRule, 'bubble:agent');
  assert.equal(result.tone, 'agent');
  assert.equal(result.label, 'Subagent activity');
  assert.equal(result.hidden, false);
  assert.equal(result.text, summary);
  assert.equal(result.disclosure?.expandedText, summary);
  assert.equal(result.disclosure?.previewText, summary);
  assert.equal(result.disclosure?.previewTail, '');
  assert.equal(result.disclosure?.expandable, true);
  assert.doesNotMatch(result.disclosure?.expandedText ?? '', /report_id=|ledger_row_id=|child_stream_id=|msg_id=/);
});

test('legacy multiline report keeps summary bytes and strips only the final trailer pair', () => {
  const summary = [
    'First summary line',
    'effective_model=summary-content-not-a-trailer',
    '[pentacle-notice:quoted-inside-summary]',
    'summary=interior summary-looking content',
    'Final summary line',
  ].join('\n');
  const result = interpretPentacleEvent(event(reportEnvelope(summary, { qa: true })), 'Bart');

  assert.equal(result.caseId, 'subagent-report');
  assert.equal(result.text, summary);
  assert.equal(result.disclosure?.expandedText, summary);
  assert.equal(result.disclosure?.previewText, 'First summary line');
  assert.equal(result.disclosure?.previewTail, '');
  assert.equal(result.disclosure?.expandable, true);
});

test('single-line report may omit the optional model/effort trailer', () => {
  const result = interpretPentacleEvent(event(reportEnvelope('One unambiguous summary line.', { trailer: false })));
  assert.equal(result.caseId, 'subagent-report');
  assert.equal(result.text, 'One unambiguous summary line.');
  assert.equal(result.hidden, false);
});

test('complete legacy inactivity notice is visible with a distinct Daemon tag', () => {
  const text = [
    `[pentacle-notice:d2:${'a'.repeat(64)}]`,
    'Child session hostc:v2-idle-fixture reached an inactivity threshold at 2026-01-02T03:05:06.000000Z.',
  ].join('\n');
  const result = interpretPentacleEvent(event(text, { daemon_seq: 4102 }));

  assert.equal(result.caseId, 'daemon-notice');
  assert.equal(result.displayRule, 'bubble:agent');
  assert.equal(result.label, 'Daemon');
  assert.equal(result.hidden, false);
  assert.equal(result.text, 'Child session hostc:v2-idle-fixture reached an inactivity threshold at 2026-01-02T03:05:06.000000Z.');
  assert.equal(result.disclosure?.previewTail, '');
  assert.equal(result.disclosure?.expandable, true);
});

test('legacy recognition fails open for malformed, partial, prose-wrapped, and ambiguous envelopes', () => {
  const valid = reportEnvelope('Summary line');
  const multilineWithoutTrailer = reportEnvelope('First line\nSecond line', { trailer: false });
  const invalid = [
    valid.replace(/child-report-ready-v2-[0-9a-f]{64}/, `child-report-ready-v2-${'0'.repeat(64)}`),
    valid.replace('ledger_row_id=7001\n', ''),
    valid.replace('ledger_row_id=7001\nchild_stream_id=', 'child_stream_id=hostb:v2-wrong-fixture\nledger_row_id=7001\nchild_stream_id='),
    `Quoted notice:\n${valid}`,
    `${valid}\nextra prose`,
    multilineWithoutTrailer,
    '[child_report_ready]\nreport_id=not-a-complete-envelope',
  ];

  for (const [index, text] of invalid.entries()) {
    const result = interpretPentacleEvent(event(text, { daemon_seq: 500 + index }));
    const markerPrefixed = text.startsWith('[pentacle-notice:');
    assert.equal(result.caseId, markerPrefixed ? 'transient-noise' : 'user-message', `case ${index}`);
    assert.equal(result.displayRule, markerPrefixed ? 'hidden:noise' : 'bubble:user', `display ${index}`);
    assert.equal(result.hidden, markerPrefixed, `visibility ${index}`);
  }
});

test('explicit USER send bindings override even a byte-exact valid legacy envelope', () => {
  const text = reportEnvelope('Copied complete envelope');
  const controls: Array<Partial<PentacleEvent>> = [
    { client_origin: true },
    { optimistic_id: 'optimistic-1' },
    { request_id: 'request-1' },
    { receipt_id: 'receipt-1' },
    { raw: { source: 'structured', client_origin: true } },
    { raw: { source: 'structured', optimistic_id: 'optimistic-raw' } },
    { raw: { source: 'structured', request_id: 'request-raw' } },
    { raw: { source: 'structured', receipt_id: 'receipt-raw' } },
  ];

  for (const [index, override] of controls.entries()) {
    const result = interpretPentacleEvent(event(text, { daemon_seq: 600 + index, ...override }));
    assert.equal(result.caseId, 'user-message', `case ${index}`);
    assert.equal(result.displayRule, 'bubble:user', `display ${index}`);
    assert.equal(result.hidden, false, `visibility ${index}`);
  }
});

test('bare status text and receiptless exact copies remain visible user content', () => {
  for (const text of [
    'Please update your title and status card now.',
    '[pentacle-notice:d2:not-a-full-notice] Please update your title and status card now.',
    reportEnvelope('Copied exact valid report envelope'),
  ]) {
    const result = interpretPentacleEvent(event(text, {
      client_origin: text.startsWith('[pentacle-notice:child-report') ? true : undefined,
    }));
    const markerPrefixed = text.startsWith('[pentacle-notice:d2:not');
    assert.equal(result.displayRule, markerPrefixed ? 'hidden:noise' : 'bubble:user');
    assert.equal(result.hidden, markerPrefixed);
  }
});

test('collapsed previews defer truncation to native one-line layout and never add More text', () => {
  const long = `Execute ${'the existing release verification '.repeat(8)}with exact evidence.`;
  const disclosure = collapsedDisclosurePresentation(long);
  assert.equal(disclosure.previewText, long);
  assert.equal(disclosure.previewTail, '');
  assert.equal(disclosure.expandable, true);

  const multiline = collapsedDisclosurePresentation('First line\nSecond line\nThird line');
  assert.equal(multiline.previewText, 'First line');
  assert.equal(multiline.previewTail, '');
  assert.equal(multiline.expandable, true);
});
