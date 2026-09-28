"""Synthetic replay validation; no production daemon, provider or inbox."""
import asyncio
import importlib.machinery
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

TOOLS = Path(__file__).resolve().parents[1] / 'tools'
sys.path.insert(0, str(TOOLS))
import scripted_replay as replay
import multi_stream_scripted_replay as multi


def fixture(tmp_path):
    path = tmp_path / 'synthetic.json'
    payload = {'schema_version': 1, 'name': 'synthetic', 'stream': {'stream_id': 'example:session', 'host': 'example', 'provider': 'codex', 'session_name': 'session'}, 'frames': [{'id': 'one', 'type': 'chat.event', 'at_ms': 0, 'event': {'daemon_seq': 7, 'timestamp': '2026-01-01T00:00:00Z', 'kind': 'ASSIST', 'text': 'Synthetic reply'}}]}
    path.write_text(json.dumps(payload))
    return path, payload


def test_script_constructs_canonical_payload_and_rejects_invalid_timestamp(tmp_path):
    path, payload = fixture(tmp_path)
    script = replay.load_script(path)
    event = replay.event_payload_for_frame(script, script.frames[0])
    assert event['stream_id'] == 'example:session' and event['daemon_seq'] == 7
    assert event['raw']['source'] == 'scripted-daemon'
    payload['frames'][0]['event']['timestamp'] = 'invalid'
    path.write_text(json.dumps(payload))
    with pytest.raises(replay.ScriptValidationError, match='ISO-8601'):
        replay.load_script(path)


def test_duplicate_frame_id_and_unsupported_jsonl_fail_closed(tmp_path):
    path, payload = fixture(tmp_path)
    payload['frames'].append(payload['frames'][0]); path.write_text(json.dumps(payload))
    with pytest.raises(replay.ScriptValidationError, match='duplicate frame'):
        replay.load_script(path)
    with pytest.raises(replay.ScriptValidationError, match='not supported'):
        replay._normalize_claude_jsonl_records([], host='example', session_name='session')


def test_ack_batch_is_correlated_and_returned_in_send_order():
    class Socket:
        def __init__(self):
            self.responses = iter([{'type':'unrelated'}, {'request_id':'two','type':'debug_replay_event.ack','status':'ok'}, {'request_id':'one','type':'debug_replay_event.ack','status':'ok'}])
        async def recv(self):
            return json.dumps(next(self.responses))
    result = asyncio.run(multi.receive_frame_ack_batch(Socket(), [{'request_id':'one'}, {'request_id':'two'}]))
    assert [row[0]['request_id'] for row in result] == ['one', 'two']
    assert multi.replay_ack_batch_size(catch_up_late_frames=False) == 1
    assert multi.replay_ack_batch_size(catch_up_late_frames=True) == 640
    assert multi.replay_frame_interval_s(SimpleNamespace(name='synthetic', frames=[]), {'replay_frame_interval_ms': 25}) == .025


def test_replay_inbox_helper_parses_only_temp_input(tmp_path):
    path = Path(__file__).resolve().parents[3] / 'bin/pentacle-replay-events'
    loader = importlib.machinery.SourceFileLoader('public_replay_inbox', str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader); module = importlib.util.module_from_spec(spec); loader.exec_module(module)
    fixture_path = tmp_path / 'synthetic.jsonl'; fixture_path.write_text('{"kind":"USER","text":"Synthetic input"}\n')
    assert module._read_fixture(fixture_path)[0]['text'] == 'Synthetic input'
    assert module._resolve_inbox(str(tmp_path)) == tmp_path
    fixture_path.write_text('[1,2]\n')
    with pytest.raises(ValueError, match='expected JSON object'):
        module._read_fixture(fixture_path)
