import json
import pytest
from e2e.harness.telemetry_events import parse_telemetry_line


def test_parser_uses_supplied_line_and_preserves_payload():
    line = 'prefix [TELEMETRY] '+json.dumps(dict(message='synthetic:event', data={'count':3}))
    event = parse_telemetry_line(line+'\n')
    assert event.message == 'synthetic:event'
    assert event.subsystem == 'synthetic'
    assert event.data == {'count':3}
    assert event.raw == line
    assert event.received_at > 0


@pytest.mark.parametrize('line', ['no marker', '[TELEMETRY] broken', '[TELEMETRY] {"message":',
                                  '[TELEMETRY] {}', '[TELEMETRY] {"message":""}', '[TELEMETRY] null', '[TELEMETRY] []'])
def test_absent_or_truncated_event_never_fabricates_payload(line):
    assert parse_telemetry_line(line) is None
