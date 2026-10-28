"""Fail-first control for two-turn mock send support."""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import mock_v2_daemon as mock
from e2e.tests.test_mock_v2_daemon import _args


def test_mock_accepts_two_turn_send_echo_configuration():
    daemon = mock.MockDaemon(_args(0, ''))
    captured = []
    async def send(_ws, frame):
        captured.append(frame)
    daemon._send = send
    asyncio.run(daemon._on_send_echo_config(object(), {
        'request_id': 'configure', 'enabled': True,
        'expected_stream_id': 'mock-host:mock-session',
        'assistant_replies': ['first reply', 'second reply'],
    }))
    assert captured[-1]['status'] == 'ok'


def test_stub_observes_exact_answer_request_without_aliases():
    daemon = mock.MockDaemon(_args(0, ''))
    received = []
    async def send(_ws, frame):
        received.append(frame)
    daemon._send = send
    daemon.observer_clients.add(object())
    request = {'type': 'prompt.answer', 'request_id': 'r', 'question_id': 'q',
               'selections': ['choice'], 'text': 'verbatim'}
    asyncio.run(daemon._dispatch(object(), request))
    assert any(frame.get('event') == 'prompt.answer.received'
               and frame.get('question_id') == 'q'
               and frame.get('selections') == ['choice']
               and frame.get('text') == 'verbatim' for frame in received)


def test_two_sends_survive_replay_and_duplicates_are_not_inserted():
    daemon = mock.MockDaemon(_args(0, ''))
    frames = []
    async def send(_ws, frame):
        frames.append(frame)
    async def broadcast(frame):
        frames.append(frame)
    daemon._send = send
    daemon._broadcast_app = broadcast
    async def exercise():
        ws = object()
        await daemon._on_send_echo_config(ws, {'stream_id': 'mock-host:mock-session', 'assistant_replies': ['reply one', 'reply two']})
        for identifier, text in [('one', 'turn one'), ('one', 'turn one'), ('two', 'turn two')]:
            await daemon._dispatch(ws, {'type': 'send', 'request_id': identifier, 'host': 'mock-host',
                                        'session_name': 'mock-session', 'optimistic_id': identifier, 'text': text})
        await daemon._on_request_stream_events(ws, {'request_id': 'replay', 'host': 'mock-host', 'session_name': 'mock-session', 'limit': 100})
    asyncio.run(exercise())
    events = daemon.recent_by_stream['mock-host:mock-session']
    assert [(e['kind'], e['text']) for e in events] == [('USER', 'turn one'), ('ASSIST', 'reply one'), ('USER', 'turn two'), ('ASSIST', 'reply two')]
    replay = next(frame for frame in frames if frame.get('request_id') == 'replay')
    assert [(e['kind'], e['text']) for e in replay['events']] == [(e['kind'], e['text']) for e in events]


def test_real_mock_socket_two_turns_and_reconnect():
    import json
    import websockets
    from websockets.asyncio.server import serve

    async def exercise():
        daemon = mock.MockDaemon(_args(0, ''))
        server = await serve(daemon.handler, '127.0.0.1', 0)
        port = next(iter(server.sockets)).getsockname()[1]
        url = f'ws://127.0.0.1:{port}'
        async def hello(ws, client):
            assert json.loads(await ws.recv())['type'] == 'welcome'
            await ws.send(json.dumps({'type': 'hello', 'client': client, 'subscribe': {'mode': 'rpc', 'snapshot': False}}))
            assert json.loads(await ws.recv())['type'] == 'ready'
        try:
            async with websockets.connect(url) as observer:
                await hello(observer, 'harness')
                await observer.send(json.dumps({'type': 'debug_replay_send_echo_config', 'request_id': 'cfg',
                                                'stream_id': 'mock-host:mock-session',
                                                'assistant_replies': ['one reply', 'two reply']}))
                assert json.loads(await observer.recv())['status'] == 'ok'
                async with websockets.connect(url) as app:
                    await hello(app, 'pentacle-mobile')
                    await app.send(json.dumps({'type': 'send', 'request_id': 'r1', 'host': 'mock-host',
                                               'session_name': 'mock-session', 'optimistic_id': 'one', 'text': 'one'}))
                    for expected in ('chat.event', 'chat.event', 'send.result'):
                        assert json.loads(await app.recv())['type'] == expected
                    assert json.loads(await observer.recv())['event'] == 'send.received'
                    assert json.loads(await observer.recv())['event'] == 'send.echoed'
                    await observer.send(json.dumps({'type': 'debug_replay_close', 'request_id': 'close', 'client': 'pentacle-mobile'}))
                    assert json.loads(await observer.recv())['closed'] == 1
                async with websockets.connect(url) as app:
                    await hello(app, 'pentacle-mobile')
                    await app.send(json.dumps({'type': 'send', 'request_id': 'r2', 'host': 'mock-host',
                                               'session_name': 'mock-session', 'optimistic_id': 'two', 'text': 'two'}))
                    for expected in ('chat.event', 'chat.event', 'send.result'):
                        assert json.loads(await app.recv())['type'] == expected
                    await app.send(json.dumps({'type': 'request_stream_events', 'request_id': 'history',
                                               'host': 'mock-host', 'session_name': 'mock-session', 'limit': 20}))
                    history = json.loads(await app.recv())
                    assert [event['text'] for event in history['events']] == ['one', 'one reply', 'two', 'two reply']
        finally:
            server.close()
            await server.wait_closed()
    asyncio.run(exercise())


def test_send_stub_rejects_wrong_target_and_conflicting_retry():
    daemon = mock.MockDaemon(_args(0, ''))
    frames = []
    async def capture(_ws, frame): frames.append(frame)
    daemon._send = capture
    daemon._broadcast_app = lambda frame: capture(None, frame)
    async def exercise():
        ws = object()
        await daemon._on_send_echo_config(ws, {'stream_id': 'mock-host:mock-session', 'assistant_replies': ['a', 'b']})
        base = {'type': 'send', 'request_id': 'x', 'host': 'mock-host', 'session_name': 'mock-session', 'optimistic_id': '1', 'text': 'first'}
        await daemon._dispatch(ws, {**base, 'session_name': 'other'})
        await daemon._dispatch(ws, base)
        await daemon._dispatch(ws, {**base, 'text': 'different'})
    asyncio.run(exercise())
    errors = [f.get('error') for f in frames if f.get('type') == 'send.error']
    assert errors == ['mock_send_unsupported', 'optimistic_id_conflict']
    assert len(daemon.recent_by_stream['mock-host:mock-session']) == 2


def test_real_mock_observer_receives_exact_choice_and_text():
    import json
    import websockets
    from websockets.asyncio.server import serve
    async def exercise():
        daemon = mock.MockDaemon(_args(0, ''))
        server = await serve(daemon.handler, '127.0.0.1', 0)
        url = f"ws://127.0.0.1:{next(iter(server.sockets)).getsockname()[1]}"
        async def hello(ws, client):
            await ws.recv()
            await ws.send(json.dumps({'type': 'hello', 'client': client, 'subscribe': {'mode': 'rpc', 'snapshot': False}}))
            assert json.loads(await ws.recv())['type'] == 'ready'
        try:
            async with websockets.connect(url) as observer, websockets.connect(url) as app:
                await hello(observer, 'harness'); await hello(app, 'pentacle-mobile')
                await observer.send(json.dumps({'type': 'debug_replay_snapshot_config', 'request_id': 'watch', 'snapshot': {}}))
                assert json.loads(await observer.recv())['status'] == 'ok'
                notification = {'notification_id': 'n', 'producer': 'agent_question.v1', 'state': 'open',
                    'actions': [{'kind': 'ack', 'action_id': 'a', 'value': {'answer': 'proceed'}}],
                    'question': {'question_id': 'q', 'state': 'open', 'response_mode': 'single_choice',
                                 'options': [{'value': 'proceed'}]}}
                await observer.send(json.dumps({'type': 'debug_replay_notification', 'request_id': 'inject', 'notification': notification}))
                assert json.loads(await observer.recv())['status'] == 'ok'
                assert json.loads(await app.recv())['type'] == 'session.inventory'
                assert json.loads(await app.recv())['type'] == 'notification'
                await app.send(json.dumps({'type': 'prompt.answer', 'request_id': 'answer', 'question_id': 'q',
                                           'selections': ['proceed'], 'text': 'note answer'}))
                observed = json.loads(await observer.recv())
                assert (observed['event'], observed['question_id'], observed['selections'], observed['text']) == ('prompt.answer.received', 'q', ['proceed'], 'note answer')
                assert json.loads(await app.recv())['type'] == 'prompt.answer.ok'
        finally:
            server.close()
            await server.wait_closed()
    asyncio.run(exercise())
