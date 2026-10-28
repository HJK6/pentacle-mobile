"""M1 diagnostic evidence keeps observed submissions separate from delivery."""
import json
from e2e.scenarios import _m1_diagnostic_capture as capture


def test_submitted_hid_events_are_timestamped_and_not_delivery_claims(tmp_path):
    from idb.common.hid import text_to_events
    output = tmp_path / 'hid.jsonl'
    capture.write_events(output, 'text', text_to_events('a'))
    rows = [json.loads(line) for line in output.read_text().splitlines()]
    assert len(rows) == 2
    assert [row['event']['direction'] for row in rows] == ['DOWN', 'UP']
    assert all(row['provenance'] == 'client_submitted_not_delivered' and row['wall_ns'] > 0 for row in rows)
    assert all(row['event']['keycode'] == 4 for row in rows)


def test_diagnostic_missing_or_unsupported_event_is_fail_closed(tmp_path):
    import pytest
    with pytest.raises(ValueError):
        capture.write_events(tmp_path / 'hid.jsonl', 'text', [object()])


def test_idb_capture_records_only_successful_client_sends(tmp_path, monkeypatch):
    import asyncio
    import idb.cli.main as cli
    import idb.grpc.client as client
    from idb.common.hid import text_to_events
    from e2e.scenarios import _m1_idb_capture
    output = tmp_path / 'sent.jsonl'
    monkeypatch.setenv('M1_DIAGNOSTIC_HID_PATH', str(output))
    monkeypatch.setenv('M1_DIAGNOSTIC_COMMAND', 'text')
    monkeypatch.setattr(client, 'event_to_grpc', lambda event: event)
    async def drain(stream, generator, logger):
        async for message in generator:
            await stream.send_message(message)
        return 'done'
    monkeypatch.setattr(client, 'drain_to_stream', drain)
    class Stream:
        def __init__(self): self.count = 0
        async def send_message(self, message):
            self.count += 1
            if self.count == 2: raise RuntimeError('send failed')
    async def run():
        async def events():
            for event in text_to_events('a'):
                yield client.event_to_grpc(event)
        try:
            await client.drain_to_stream(Stream(), events(), None)
        except RuntimeError as exc:
            assert str(exc) == 'send failed'
    monkeypatch.setattr(cli, 'main', lambda: asyncio.run(run()))
    _m1_idb_capture.main()
    rows = [json.loads(line) for line in output.read_text().splitlines()]
    assert len(rows) == 1 and rows[0]['event']['direction'] == 'DOWN'
    assert rows[0]['provenance'] == 'client_submitted_not_delivered'
