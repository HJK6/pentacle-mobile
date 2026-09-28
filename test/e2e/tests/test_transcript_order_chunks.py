from types import SimpleNamespace
import json
from pathlib import Path
import pytest
from e2e.harness.transcript_order import transcript_orders
from e2e.harness.telemetry_events import parse_telemetry_line


def test_synthetic_truncation_does_not_fabricate_order():
    truncated = '[TELEMETRY] ' + json.dumps(dict(subsystem='synthetic', message='harness:ui_trace', data=dict(kind='transcript_order_chunk', stream_id='sample:stream', order_id='sample-order', offset=0, row_count=2, row_ids=['sample-row'])))[:-8]
    assert parse_telemetry_line(truncated) is None
    assert transcript_orders([], 'sample:stream') == []


def event(offset, row, *, target='owned', generation='g', total=2):
    return SimpleNamespace(message='harness:ui_trace', received_at=10 + offset,
        data=dict(kind='transcript_order_chunk', stream_id=target, order_id=generation,
                  row_count=total, offset=offset, row_ids=[row]))


def test_complete_exact_order():
    result = transcript_orders([event(0, 'ask'), event(1, 'answer')], 'owned')
    assert [r['id'] for r in result[0].data['row_order']] == ['ask', 'answer']
    assert result[0].data['order_id'] == 'g'


@pytest.mark.parametrize('events', [
    [event(0, 'ask')],
    [event(0, 'ask'), event(1, 'answer', target='foreign')],
    [event(0, 'ask'), event(1, 'answer', generation='other')],
    [event(0, 'ask'), event(1, 'answer', total=3)],
    [event(0, 'ask'), event(1, 'ask')],
    [event(0, 'ask'), event(1, 'answer'), event(1, 'different')],
])
def test_incomplete_or_ambiguous_order_is_not_evidence(events):
    assert transcript_orders(events, 'owned') == []


def test_reopen_cannot_complete_using_pre_relaunch_chunks():
    assert transcript_orders([event(0, 'ask'), event(1, 'answer')], 'owned', after=10.5) == []
