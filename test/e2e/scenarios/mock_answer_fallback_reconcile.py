"""Hold each answer-reconciliation state until its native screen acknowledges it."""
from __future__ import annotations

import asyncio
import json
import time
from urllib.parse import urlsplit

from . import _mock_chat_streamd as M
from ..harness.asserts import EventSpec, Verdict, await_event

name = 'mock_answer_fallback_reconcile'
SCENARIO_META = {'target_compat': {'simulator'}, 'requires': []}
FIXTURE = 'answer_fallback_reconcile.json'
TEXT = 'Operator answered: Keep one answer.'
FALLBACK_ID = f'fallback:{M.STREAM_ID}'
DURABLE_ID = 'session-question-answer-durable:answer-reconcile-notification:answer-reconcile-question'


def actions(_config):
    return ['autoaccept_biometric', 'open_existing_chat']


def params(config):
    return {**M.params_for_fixture(config, FIXTURE), 'pre_open_wait_ms': '0', 'ws_url': fixture_url(config)}


def fixture_url(config):
    url = str(config.get('ws_url') or '')
    parsed = urlsplit(url)
    if parsed.scheme != 'ws' or parsed.hostname != '127.0.0.1' or not parsed.port or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('answer fixture requires an explicit loopback mock URL')
    return url


def fixture(config):
    return json.loads(M.fixture_path(config, FIXTURE).read_text())


def fixture_rpc(config, operation, payload):
    if operation not in {'debug_replay_snapshot_config', 'debug_replay_notification', 'debug_replay_event'}:
        raise ValueError('unsupported answer fixture operation')
    async def send():
        import websockets
        async with websockets.connect(fixture_url(config), open_timeout=10) as ws:
            assert json.loads(await asyncio.wait_for(ws.recv(), 10))['type'] == 'welcome'
            await ws.send(json.dumps({'type': 'hello', 'client': 'harness', 'subscribe': {'mode': 'rpc', 'snapshot': False}}))
            assert json.loads(await asyncio.wait_for(ws.recv(), 10))['type'] == 'ready'
            request_id = f'answer-stage-{time.monotonic_ns()}'
            await ws.send(json.dumps({'type': operation, 'request_id': request_id, **payload}))
            ack = json.loads(await asyncio.wait_for(ws.recv(), 10))
            if ack.get('type') != operation + '.ack' or ack.get('request_id') != request_id or ack.get('status') != 'ok':
                raise RuntimeError('answer fixture stage was not acknowledged')
    asyncio.run(send())


def seed_summary(config):
    fixture_rpc(config, 'debug_replay_snapshot_config', {'snapshot': fixture(config)['snapshot'], 'host': M.HOST})


def _hold(stream):
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        stream.next_event(timeout_s=min(.2, deadline - time.monotonic()))


def evaluate_trace(events, stages):
    required = ('summary_list', 'summary_mount', 'durable_list', 'durable_mount', 'echo')
    if any(stages.get(key) is None for key in required):
        return ['missing required rendered reconciliation stage']
    errors = []
    for prefix, row_id in (('summary', FALLBACK_ID), ('durable', DURABLE_ID)):
        listed, mounted = stages[prefix + '_list'], stages[prefix + '_mount']
        if listed.message != 'harness:ui_trace' or listed.data.get('kind') != 'transcript_list_update' or listed.data.get('stream_id') != M.STREAM_ID or listed.data.get('first_row_id') != row_id:
            errors.append('stage lacks the bound assembled native list')
        if mounted.message != 'harness:row_rendered' or any(mounted.data.get(key) != value for key, value in {
            'stream_id': M.STREAM_ID, 'row_id': row_id, 'component_name': 'TranscriptRow', 'lifecycle': 'mount', 'text_prefix': TEXT,
        }.items()):
            errors.append('stage lacks the bound rendered native answer')
    echo = stages['echo']
    if echo.message != 'chat:event_received' or echo.data.get('stream_id') != M.STREAM_ID or echo.data.get('seq') != 501:
        errors.append('terminal echo identity is missing')
    if max(stages['summary_list'].received_at, stages['summary_mount'].received_at) >= min(stages['durable_list'].received_at, stages['durable_mount'].received_at) or echo.received_at <= max(stages['durable_list'].received_at, stages['durable_mount'].received_at):
        errors.append('reconciliation stage barriers are out of order')
    for event in events:
        if event.received_at < stages['summary_list'].received_at:
            continue
        data = event.data
        if event.message == 'harness:ui_trace' and data.get('kind') == 'transcript_list_update':
            expected = DURABLE_ID if event.received_at >= stages['durable_list'].received_at else FALLBACK_ID
            if data.get('data_count') != 1 or data.get('pending_count') != 0 or data.get('queued_count') != 0 or [row.get('id') for row in data.get('row_order', [])] != [expected]:
                errors.append('assembled native list is not one stable answered row')
        if event.message == 'harness:row_rendered' and data.get('component_name') == 'TranscriptRow':
            if data.get('text_prefix') != TEXT:
                errors.append('native row lost the answer or exposed raw protocol text')
            if data.get('row_id') == DURABLE_ID and data.get('lifecycle') == 'unmount':
                errors.append('durable native answer was removed')
    return errors


def run(config, stream, cap=None):
    early = M.await_mock_session_open(stream, name=name)
    if early:
        return early
    stages = {}
    def observe(prefix, row_id):
        stages[prefix + '_list'] = await_event(stream, EventSpec('harness:ui_trace', {
            'kind': 'transcript_list_update', 'stream_id': M.STREAM_ID, 'first_row_id': row_id,
            'data_count': 1, 'pending_count': 0, 'queued_count': 0,
        }, 20))
        stages[prefix + '_mount'] = await_event(stream, EventSpec('harness:row_rendered', {
            'stream_id': M.STREAM_ID, 'row_id': row_id, 'component_name': 'TranscriptRow',
            'lifecycle': 'mount', 'text_prefix': TEXT,
        }, 20))
        return all(stages.get(prefix + suffix) for suffix in ('_list', '_mount'))
    def failed(message):
        return Verdict(name, 'FAIL', error=message).finish()
    if not observe('summary', FALLBACK_ID):
        return failed('summary-only native stage not rendered; no notification or echo released')
    if cap:
        cap.screenshot('answer-summary-only')
    fixture_rpc(config, 'debug_replay_notification', {'notification': fixture(config)['resolved_notification']})
    if not observe('durable', DURABLE_ID):
        return failed('resolved/no-echo native stage not rendered; echo withheld')
    _hold(stream)
    if cap:
        cap.screenshot('answer-resolved-no-echo')
    fixture_rpc(config, 'debug_replay_event', {'event': fixture(config)['echo'], 'expected_stream_id': M.STREAM_ID})
    stages['echo'] = await_event(stream, EventSpec('chat:event_received', {'stream_id': M.STREAM_ID, 'seq': 501}, 20), not_before=stages['durable_list'].received_at)
    _hold(stream)
    if cap:
        cap.screenshot('answer-echo-reconciled')
    errors = evaluate_trace(stream.all_events(), stages)
    return Verdict(name, 'FAIL' if errors else 'PASS', error='; '.join(errors) or None,
                   extras={'stages': {key: value.to_dict() if value else None for key, value in stages.items()}}).finish()
