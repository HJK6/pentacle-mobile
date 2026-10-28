"""Real helper/loader controls; only native command and telemetry counterparts vary."""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from e2e.scenarios import nexus_agents_history_questions as m1
from e2e.scenarios import _m1_native_ui as native
from e2e.tools.scripted_replay import load_script

FIXTURE = Path(__file__).resolve().parents[1] / 'fixtures/scripted_daemon/m1_broad_questions.json'


def test_configured_assistant_is_present_in_actual_loader():
    script = load_script(FIXTURE)
    assistants = [s for s in script.snapshot['sessions'] if s['stream_id'] == 'home:assistant']
    assert len(assistants) == 1
    assert assistants[0]['session_kind'] == 'assistant_composite'
    assert assistants[0]['bootstrap_state'] == 'ready'


def element(identifier=None, label=None, y=100):
    return {'AXUniqueId': identifier, 'AXLabel': label, 'enabled': True,
            'frame': {'x': 20, 'y': y, 'width': 160, 'height': 35}}


@pytest.fixture
def counterpart(monkeypatch):
    clock = [0.0]
    def tick():
        clock[0] += .25
        return clock[0]
    monkeypatch.setattr(native.time, 'monotonic', tick)
    monkeypatch.setattr(native.time, 'sleep', lambda _: None)
    state = {'page': 'session', 'commands': [], 'bad': None}
    root = {'role': 'AXApplication', 'pid': 123,
            'frame': {'x': 0, 'y': 0, 'width': 402, 'height': 874}}
    def elements():
        if state['page'] == 'home':
            rows = [element('assistant-header'), element(label='Sessions, 0 need you', y=150),
                    element(label='Synthetic assistant home ready.', y=200)]
        elif state['page'] == 'drawer':
            rows = [element(label='Close sessions'),
                    element('assistant-drawer-row-mock-host:mock-session',
                            'Open Assistant history fixture, Idle, Mock Host', y=200)]
        else:
            rows = [element(label='Back to chats'), element('composer-input', y=300),
                    element('composer-mic-button', 'Voice mode', y=400),
                    element('combined-session-header'), element('session-status-overlay-trigger', 'Open session status', y=500), element(label='Assistant history fixture', y=600)]
        for row in rows:
            if row.get('AXUniqueId') == 'session-status-overlay-trigger':
                row['AXValue'] = 'Assistant history fixture, codex, idle'
        return [root, *rows]
    def command(*args):
        state['commands'].append(args)
        if args[0] == 'describe-all':
            return json.dumps(elements())
        if args[0] == 'describe-point':
            x, y = map(int, args[1:3])
            return json.dumps(next((e for e in elements()[1:] if e['frame']['y'] <= y <= e['frame']['y']+35), {}))
        if args[0] == 'tap':
            y = int(args[2])
            if state['page'] == 'session': state['page'] = 'home'
            elif state['page'] == 'home': state['page'] = 'drawer'
            else: state['page'] = 'session'
            return ''
        raise AssertionError(args)
    ui = native.NativeUI({'SIMULATOR_UDID': 'synthetic', 'trace': lambda *_: None})
    monkeypatch.setattr(ui, '_command', command)
    monkeypatch.setattr(ui, 'check_foreground', lambda: None)
    trace = SimpleNamespace(mark=lambda: None, verify_session=lambda *args: True)
    control = SimpleNamespace(last_notification=None, trace=trace,
                              verify_baseline=lambda: {'mock-host:mock-session': {'title': 'Assistant history fixture', 'session_generation': 'parent-generation'}})
    state['elements'] = elements
    return ui, control, state


def test_real_reset_reopens_from_healthy_assistant_instead_of_legacy_wait(counterpart):
    ui, control, state = counterpart
    assert m1.reset_diagnostic_cell(ui, control, 'two_turn_reconnect') is True
    assert state['page'] == 'session'
    assert [c[0] for c in state['commands']].count('tap') == 3
    assert [c[0] for c in state['commands']].count('describe-point') == 3


def protocol_baseline():
    """Real loader -> projection -> snapshot/event handlers -> history/reconnect."""
    import asyncio
    from e2e.tools.scripted_replay import event_payload_for_frame
    from e2e.tests.test_mock_v2_daemon import mvd, _args
    daemon = mvd.MockDaemon(_args(0, ''))
    sent = []
    async def send(ws, frame): sent.append(frame)
    async def broadcast(frame): sent.append(frame)
    daemon._send, daemon._broadcast_app = send, broadcast
    script = load_script(FIXTURE)
    async def exercise():
        await daemon._on_snapshot_config(object(), {'snapshot': script.snapshot, 'request_id': 'config'})
        ack = next(f for f in sent if f.get('request_id') == 'config')
        assert ack['sessions'] == 5 and ack['events'] == 0
        for frame in script.frames:
            await daemon._on_debug_event(object(), {'request_id': frame.id,
                'event': event_payload_for_frame(script, frame)})
        await daemon._on_request_stream_events(object(), {'request_id': 'assistant-history',
                                                          'stream_id': 'home:assistant'})
        await daemon._on_hello(object(), {'client': 'harness', 'subscribe': {'snapshot': True}})
    asyncio.run(exercise())
    history = next(f for f in sent if f.get('request_id') == 'assistant-history')
    snapshot = next(f for f in sent if f.get('type') == 'snapshot')
    assert history['complete'] is True and len(history['events']) == 1
    assert [e['daemon_seq'] for e in daemon.recent_by_stream['mock-host:mock-session']] == [40]
    assert len(daemon.thread_history['mock-host:mock-session|mock-host:child-worker']['pages']) == 2
    return snapshot, history, {'pentacle-mobile': 1}, daemon


def test_real_projection_history_and_reconnect_preserve_distinct_assistant():
    from e2e.scenarios._m1_mock_control import validate_baseline
    snapshot, history, clients, daemon = protocol_baseline()
    inventory = validate_baseline(snapshot, history, clients)
    assert inventory['home:assistant']['provider'] == 'composite'
    assert len(inventory['mock-host:mock-session']['agents']) == 9
    # Reconnect does not clear outstanding inventory to manufacture zero.
    daemon.notifications['pending'] = {'notification_id': 'pending', 'state': 'open'}
    assert daemon._snapshot_frame('none', [])['notifications'] == [daemon.notifications['pending']]


@pytest.mark.parametrize('fault', ['missing', 'wrong', 'duplicate', 'generation', 'legacy_question',
                                  'attention', 'unknown_attention', 'history', 'history_stream',
                                  'history_duplicate', 'registration', 'assistant_kind'])
def test_authoritative_baseline_rejects_unknown_or_wrong_state(fault):
    import copy
    from e2e.scenarios._m1_mock_control import validate_baseline
    snapshot, history, clients, _ = protocol_baseline()
    snapshot, history = copy.deepcopy(snapshot), copy.deepcopy(history)
    if fault == 'missing': snapshot['sessions'].pop()
    elif fault == 'wrong': snapshot['sessions'][0]['stream_id'] = 'wrong:assistant'
    elif fault == 'duplicate': snapshot['sessions'][0] = snapshot['sessions'][1]
    elif fault == 'generation': snapshot['sessions'][0]['session_generation'] = 'old'
    elif fault == 'legacy_question': snapshot['sessions'][0]['question'] = {'state': 'open'}
    elif fault == 'attention': snapshot['notifications'] = [{'state': 'open'}]
    elif fault == 'unknown_attention': snapshot.pop('notifications')
    elif fault == 'history': history['complete'] = False
    elif fault == 'history_stream': history['events'][0]['stream_id'] = 'mock-host:mock-session'
    elif fault == 'history_duplicate': history['events'] *= 2
    elif fault == 'registration': clients = {'harness': 1}
    elif fault == 'assistant_kind':
        next(s for s in snapshot['sessions'] if s['stream_id'] == 'home:assistant')['session_kind'] = 'agent'
    with pytest.raises(RuntimeError): validate_baseline(snapshot, history, clients)


@pytest.mark.parametrize('fault', ['duplicate', 'disabled', 'offscreen', 'clipped', 'zero', 'wrong_hit', 'root'])
def test_real_navigation_primitive_refuses_invalid_target(counterpart, monkeypatch, fault):
    ui, _, state = counterpart
    target = element('target', 'Exact target')
    screen = {'role': 'AXApplication', 'frame': {'x': 0, 'y': 0, 'width': 402, 'height': 874}}
    rows = [screen, target]
    if fault == 'duplicate': rows.append(dict(target))
    elif fault == 'disabled': target['enabled'] = False
    elif fault == 'offscreen': target['frame']['y'] = 900
    elif fault == 'clipped': target['frame']['x'] = -1
    elif fault == 'zero': target['frame']['width'] = 0
    elif fault == 'root': rows = [target]
    monkeypatch.setattr(ui, 'elements', lambda: rows)
    def command(*args):
        state['commands'].append(args)
        return json.dumps(element('wrong' if fault == 'wrong_hit' else 'target', 'Exact target'))
    monkeypatch.setattr(ui, '_command', command)
    with pytest.raises(RuntimeError): ui.tap_navigation('target', 'Exact target')
    assert not any(c[0] == 'tap' for c in state['commands'])


@pytest.mark.parametrize('fault', ['stale', 'wrong', 'ineligible', 'missing_mount'])
def test_fresh_stream_trace_cannot_be_replaced_by_composer(counterpart, fault):
    events = [SimpleNamespace(message='harness:ui_trace', received_at=10, data={
        'kind': 'session_screen_mount', 'stream_id': 'mock-host:mock-session', 'route_focused': True}),
        SimpleNamespace(message='harness:ui_trace', received_at=10, data={
        'kind': 'session_send_eligibility', 'stream_id': 'mock-host:mock-session',
        'focused': True, 'session_present': True, 'eligible': True})]
    if fault == 'stale':
        for e in events: e.received_at = 0
    elif fault == 'wrong': events[0].data['stream_id'] = 'mock-host:childless'
    elif fault == 'ineligible': events[1].data['eligible'] = False
    elif fault == 'missing_mount': events.pop(0)
    stream = SimpleNamespace(all_events=lambda: events, next_event=lambda **_: None)
    trace = m1._NativeTrace(stream); trace.cutoff = 1
    with pytest.raises(RuntimeError): trace.verify_session('mock-host:mock-session')


@pytest.mark.parametrize('fault', ['retained_drawer', 'no_navigation', 'wrong_voice', 'missing_composer', 'overlay'])
def test_reset_returns_false_on_unverified_postcondition(counterpart, monkeypatch, fault):
    ui, control, state = counterpart
    original = state['elements']
    def elements():
        rows = original()
        if state['page'] == 'session' and sum(c[0] == 'tap' for c in state['commands']) >= 3:
            if fault == 'retained_drawer': rows.append(element(label='Close sessions'))
            elif fault == 'wrong_voice':
                for e in rows:
                    if e.get('AXUniqueId') == 'composer-mic-button': e['AXLabel'] = 'Stop and send'
            elif fault == 'missing_composer': rows = [e for e in rows if e.get('AXUniqueId') != 'composer-input']
            elif fault == 'overlay': rows.append(element('status-overlay-close'))
        return rows
    monkeypatch.setattr(ui, 'elements', elements)
    # _command describe-all is the external AX boundary in the successful counterpart.
    command = ui._command
    def altered(*args):
        if args[0] == 'describe-all': return json.dumps(elements())
        if fault == 'no_navigation' and args[0] == 'tap':
            state['commands'].append(args)
            return ''
        return command(*args)
    monkeypatch.setattr(ui, '_command', altered)
    assert m1.reset_diagnostic_cell(ui, control, 'two_turn_reconnect') is False


def test_target_entry_refuses_broad_and_never_requests_existing_chat():
    from e2e.scenarios import m1_reset_navigation as target
    config = {'M1_RESET_NAVIGATION': '1', 'M1_MOCK_WS_URL': 'ws://127.0.0.1:18791'}
    assert target.actions(config) == ['autoaccept_biometric', 'disable_pentacle_auth']
    assert 'openStatus' not in target.params(config)
    assert 'agentHistory' not in target.params(config)
    for override in ({'M1_BROAD': '1'}, {'M1_DIAGNOSTIC': '1'}, {'M1_RESET_NAVIGATION': '0'}):
        with pytest.raises(ValueError): target.params({**config, **override})


def test_separate_observer_uses_only_read_operations_and_closes(monkeypatch):
    import asyncio
    from e2e.scenarios import _m1_mock_control as control_module
    _, _, _, daemon = protocol_baseline()
    daemon.clients[object()] = {'client_kind': 'pentacle-mobile'}
    sockets = []
    class Socket:
        def __init__(self):
            self.queue = [{'type': 'welcome'}]; self.sent = []; self.closed = False
            sockets.append(self)
        def __enter__(self): return self
        def __exit__(self, *_): self.closed = True
        def recv(self, **_): return json.dumps(self.queue.pop(0))
        def send(self, text):
            frame = json.loads(text); self.sent.append(frame)
            async def send(ws, response): self.queue.append(response)
            daemon._send = send
            asyncio.run(daemon._dispatch(self, frame))
    monkeypatch.setattr(control_module, 'connect', lambda *args, **kwargs: Socket())
    control = object.__new__(control_module.MockControl); control.url = 'ws://127.0.0.1:18791'
    assert len(control.verify_baseline()) == 5
    assert sockets[0].closed
    assert [f['type'] for f in sockets[0].sent] == ['hello', 'daemon.stats', 'request_stream_events']
    assert sockets[0].sent[0]['client'] == 'harness'
    assert sockets[0].sent[0]['subscribe']['snapshot'] is True
    daemon.notifications['pending'] = {'state': 'open', 'notification_id': 'pending'}
    with pytest.raises(RuntimeError, match='attention'): control.verify_baseline()
    assert sockets[1].closed and daemon.notifications['pending']['state'] == 'open'


def test_reset_never_converts_failed_identity_guard_to_safe(counterpart):
    ui, control, _ = counterpart
    def invalid(): raise RuntimeError('unknown inventory')
    control.verify_baseline = invalid
    ran = []
    cells = [('two_turn_reconnect', lambda: (_ for _ in ()).throw(RuntimeError('cell failure'))),
             ('later', lambda: ran.append('unsafe'))]
    outcomes = m1.run_diagnostic_cells(cells, lambda label: m1.reset_diagnostic_cell(ui, control, label))
    assert not ran
    assert [o['status'] for o in outcomes] == ['FAIL', 'UNMEASURED']


def test_target_runner_uses_exact_device_set_and_recorder_binding(tmp_path, monkeypatch):
    import run_scenario as runner
    from e2e.scenarios import m1_reset_navigation as target
    from e2e.harness.asserts import Verdict
    from e2e.harness.telemetry_events import TelemetryEvent
    state = {'launched': False, 'closed': [], 'dispatch': None}
    device_set = '/synthetic/reset-device-set'
    udid, bundle = '12345678-1234-1234-1234-123456789abc', 'com.example.synthetic.harness'
    monkeypatch.setenv('PENTACLE_SCENARIO_DEVICE_SET_ROOT', device_set)
    monkeypatch.setenv('IDB_COMPANION', '127.0.0.1:12345')
    armed = TelemetryEvent('harness', 'harness:harness_armed', '',
        {'scenario': 'm1_reset_navigation', 'scenario_run_id': 'owned'}, 1, '')
    armed.native_pid = '91'
    class Logs:
        def __init__(self, _, raw_path, **kwargs): raw_path.write_text('counterpart\n'); self.lines = []
        def start(self): pass
        def all_events(self): return [armed]
        def next_event(self, **kwargs): return None
        def close(self): state['closed'].append('logs')
    class Video:
        def __init__(self, _, path, **kwargs): self.path, self.process, self.ready_at = path, object(), 123.5
        def start(self): self.path.write_bytes(b'counterpart'); return True
        def stop(self):
            state['closed'].append('video')
            return {'video_finalized': True, 'video_alive_after_teardown': False, 'video_forced_kill': False}
    calls = []
    def command(argv, **kwargs):
        calls.append(argv)
        assert argv[:4] == ['xcrun', 'simctl', '--set', device_set]
        args = argv[4:]
        if args[0] == 'spawn': output = f'91 0 UIKitApplication:{bundle}[counterpart]\n' if state['launched'] else ''
        elif args[0] == 'launch':
            assert args[1:3] == [udid, bundle]
            from urllib.parse import urlsplit, parse_qs
            query = parse_qs(urlsplit(args[-1]).query)
            assert query['scenario'] == ['m1_reset_navigation']
            assert query['actions'] == ['autoaccept_biometric,disable_pentacle_auth']
            assert 'openStatus' not in query
            state['launched'] = True; output = bundle + ': 91\n'
        elif args[0] == 'terminate': state['launched'] = False; output = ''
        elif args[0] == 'io': Path(argv[-1]).write_bytes(b'counterpart'); output = ''
        else: raise AssertionError(argv)
        return SimpleNamespace(returncode=0, stdout=output, stderr='')
    def dispatch(config, stream, cap):
        state['dispatch'] = (config['_video_started_at'], config['_native_launch_pid'])
        return Verdict('m1_reset_navigation', 'PASS').finish()
    monkeypatch.setattr(target, 'run', dispatch)
    monkeypatch.setattr(runner, 'LogStream', Logs)
    monkeypatch.setattr(runner, 'VideoRecorder', Video)
    monkeypatch.setattr(runner.subprocess, 'run', command)
    monkeypatch.setattr(runner.time, 'sleep', lambda _: None)
    config = {'PENTACLE_GATE_BOUND_SIMULATOR_UDID': udid, 'PENTACLE_GATE_BOUND_BUNDLE_ID': bundle,
        'PENTACLE_SCENARIO_DEVICE_SET_ROOT': device_set, 'scenario_run_id': 'owned',
        'M1_RESET_NAVIGATION': '1', 'M1_MOCK_WS_URL': 'ws://127.0.0.1:18791'}
    payload, proof = runner.execute_native('m1_reset_navigation', config, tmp_path, 'owned')
    assert payload['scenario'] == 'm1_reset_navigation' and payload['verdict'] == 'PASS'
    assert state['dispatch'] == (123.5, '91')
    assert set(state['closed']) == {'logs', 'video'} and not state['launched']
    assert proof['orphan_count'] == 0
    count = len(calls)
    with pytest.raises(ValueError): runner.execute_native('m1_reset_navigation', {**config, 'M1_BROAD': '1'}, tmp_path, 'held')
    assert len(calls) == count
    monkeypatch.delenv('IDB_COMPANION')
    with pytest.raises(ValueError, match='IDB_COMPANION'):
        runner.execute_native('m1_reset_navigation', config, tmp_path, 'wrong-set')
    assert len(calls) == count
