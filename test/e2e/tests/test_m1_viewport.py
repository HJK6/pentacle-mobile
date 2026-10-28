import pytest

"""Viewport proof rejects off-screen content even if AX exposes its node."""
from e2e.scenarios._m1_native_ui import NativeUI


def test_ninth_worker_requires_frame_inside_native_application():
    screen = {'role': 'AXApplication', 'frame': {'x': 0, 'y': 0, 'width': 402, 'height': 874}}
    target = {'AXLabel': 'Worker nine', 'frame': {'x': 15, 'y': 700, 'width': 160, 'height': 30}}
    assert NativeUI.visible([screen, target], label='Worker nine')
    assert not NativeUI.visible([screen, {**target, 'frame': {**target['frame'], 'y': 900}}], label='Worker nine')
    assert not NativeUI.visible([screen, target], label='Worker ten')
    import pytest
    with pytest.raises(RuntimeError): NativeUI.visible([target], label='Worker nine')


def test_ninth_row_hit_test_rejects_header_and_empty_results():
    import json
    from e2e.scenarios._m1_native_ui import NativeUI
    screen = {'role': 'AXApplication', 'frame': {'x': 0, 'y': 0, 'width': 402, 'height': 874}}
    header = {'AXUniqueId': 'status-overlay-close', 'AXLabel': 'Close session status', 'frame': {'x': 360, 'y': 50, 'width': 34, 'height': 34}}
    row = {'AXLabel': 'Worker 9', 'frame': {'x': 20, 'y': 100, 'width': 150, 'height': 30}}
    ui = object.__new__(NativeUI)
    ui.elements = lambda: [screen, header, row]
    hits = []
    def command(*args):
        hits.append(args)
        return json.dumps(row)
    ui._command = command
    assert ui.row_visible('Worker 9')
    assert len(hits) == 2 and all(call[0] == 'describe-point' for call in hits)
    ui._command = lambda *args: json.dumps(header)
    assert not ui.row_visible('Worker 9')
    ui._command = lambda *args: json.dumps(None)
    assert not ui.row_visible('Worker 9')
    ui._command = lambda *args: (_ for _ in ()).throw(RuntimeError('hit failed'))
    assert not ui.row_visible('Worker 9')


def test_modal_close_waits_for_two_hit_checks_before_tap(monkeypatch):
    import pytest
    from e2e.scenarios import _m1_native_ui as native
    monkeypatch.setattr(native.time, 'sleep', lambda _: None)
    ui = object.__new__(NativeUI)
    calls = []
    ui.wait_hit = lambda label: calls.append(('hit', label))
    ui.tap = lambda **kwargs: calls.append(('tap', kwargs['label']))
    ui.tap_stable('Close thread history')
    assert calls == [('hit', 'Close thread history'), ('hit', 'Close thread history'), ('tap', 'Close thread history')]
    calls.clear()
    def unavailable(label):
        calls.append(('hit', label))
        if len(calls) == 2: raise RuntimeError('not yet visible')
    ui.wait_hit = unavailable
    with pytest.raises(RuntimeError): ui.tap_stable('Close thread history')
    assert not any(call[0] == 'tap' for call in calls)


def test_present_rejects_ambiguous_label(monkeypatch):
    ui = NativeUI({'SIMULATOR_UDID': 'test', 'trace': lambda *args: None})
    root = {'role': 'AXApplication', 'frame': {'x': 0, 'y': 0, 'width': 100, 'height': 100}}
    row = {'AXLabel': 'M1 question', 'frame': {'x': 5, 'y': 5, 'width': 10, 'height': 10}}
    monkeypatch.setattr(ui, 'elements', lambda: [root, row, dict(row)])
    monkeypatch.setattr(ui, 'check_foreground', lambda: None)
    with pytest.raises(RuntimeError, match='ambiguous'):
        ui.present(label='M1 question')


@pytest.fixture
def transcript_ui():
    import json
    screen = {'role': 'AXApplication', 'frame': {'x': 0, 'y': 0, 'width': 402, 'height': 874}}
    row = {'role': 'AXStaticText', 'AXLabel': None, 'AXValue': 'Synthetic first turn',
           'AXUniqueId': 'synthetic-row', 'frame': {'x': 270, 'y': 629, 'width': 101, 'height': 20}}
    ui = object.__new__(NativeUI)
    ui.elements = lambda: [screen, row]
    ui.check_foreground = lambda: None
    commands = []
    def command(*args):
        commands.append(args)
        return json.dumps(row)
    ui._command = command
    return ui, screen, row, commands


@pytest.mark.parametrize('text', ['Synthetic first turn', 'Synthetic reply.'])
@pytest.mark.parametrize('label', [None, '', 'absent'])
def test_value_only_static_transcript_reaches_native_point_check(transcript_ui, text, label):
    ui, _, row, commands = transcript_ui
    row.update(AXLabel=label, AXValue=text)
    if label == 'absent':
        del row['AXLabel']
    assert ui.hit_visible(text)
    assert commands == [('describe-point', '320', '639', '--json')]
    assert ui._labeled_frame(text) == row['frame']
    assert ui.count(text) == 1
    # General control selection must not start treating values as labels.
    assert NativeUI.visible(ui.elements(), label=text) == []


def test_nonempty_label_is_authoritative_over_conflicting_value(transcript_ui):
    ui, _, row, commands = transcript_ui
    row['AXLabel'] = 'Actual label'
    assert ui.hit_visible('Actual label')
    assert not ui.hit_visible(row['AXValue'])
    assert len(commands) == 1
    assert ui._labeled_frame(row['AXValue']) is None
    assert ui.count('Actual label') == 1
    assert ui.count(row['AXValue']) == 0


@pytest.mark.parametrize('label', [42, False, ['Synthetic first turn']])
def test_invalid_label_does_not_enable_value_fallback(transcript_ui, label):
    ui, _, row, commands = transcript_ui
    row['AXLabel'] = label
    assert not ui.hit_visible(row['AXValue'])
    assert ui.count(row['AXValue']) == 0
    assert commands == []


@pytest.mark.parametrize('role', ['AXTextArea', 'AXTextField', 'AXButton', None])
def test_input_or_control_value_never_substitutes_for_transcript(transcript_ui, role):
    ui, _, row, commands = transcript_ui
    row['role'] = role
    assert not ui.hit_visible(row['AXValue'])
    assert ui._labeled_frame(row['AXValue']) is None
    assert ui.count(row['AXValue']) == 0
    assert commands == []


@pytest.mark.parametrize('value', [None, 42, {'text': 'Synthetic first turn'}])
def test_nonstring_static_values_fail_closed(transcript_ui, value):
    ui, _, row, commands = transcript_ui
    row['AXValue'] = value
    assert not ui.hit_visible('Synthetic first turn')
    assert ui.count('Synthetic first turn') == 0
    assert commands == []


@pytest.mark.parametrize('frame', [
    {'x': 270, 'y': 900, 'width': 101, 'height': 20},
    {'x': 270, 'y': 864, 'width': 101, 'height': 20},
    {'x': -1, 'y': 629, 'width': 101, 'height': 20},
])
def test_value_only_row_must_fit_completely_inside_application(transcript_ui, frame):
    ui, _, row, commands = transcript_ui
    row['frame'] = frame
    assert not ui.hit_visible(row['AXValue'])
    assert ui.count(row['AXValue']) == 1  # Off-screen text still counts as a duplicate.
    assert commands == []


def test_ambiguous_static_rows_rejected_and_offscreen_duplicate_counted(transcript_ui):
    ui, screen, row, commands = transcript_ui
    duplicate = {**row, 'AXUniqueId': 'second-row'}
    ui.elements = lambda: [screen, row, duplicate]
    assert not ui.hit_visible(row['AXValue'])
    assert commands == []
    assert ui.count(row['AXValue']) == 2
    duplicate['frame'] = {**row['frame'], 'y': 900}
    assert ui.hit_visible(row['AXValue'])
    assert ui.count(row['AXValue']) == 2


@pytest.mark.parametrize('hit', [None, {}, {'AXLabel': 'Wrong text'},
    {'role': 'AXStaticText', 'AXValue': 'Synthetic first turn', 'AXUniqueId': 'wrong-row'},
    {'role': 'AXTextArea', 'AXValue': 'Synthetic first turn', 'AXUniqueId': 'synthetic-row'},
    {'role': 'AXStaticText', 'AXLabel': 'Conflicting label', 'AXValue': 'Synthetic first turn',
     'AXUniqueId': 'synthetic-row'},
])
def test_value_only_candidate_still_requires_matching_native_point(transcript_ui, hit):
    import json
    ui, _, row, _ = transcript_ui
    calls = []
    def command(*args):
        calls.append(args)
        return json.dumps(hit)
    ui._command = command
    assert not ui.hit_visible(row['AXValue'])
    assert len(calls) == 1


def test_value_only_roster_preserves_header_and_second_point_guard(transcript_ui):
    import json
    ui, screen, row, commands = transcript_ui
    assert not ui.row_visible(row['AXValue'])  # Header must exist.
    header = {'AXIdentifier': 'status-overlay-close',
              'frame': {'x': 360, 'y': 50, 'width': 34, 'height': 34}}
    ui.elements = lambda: [screen, header, row]
    assert ui.row_visible(row['AXValue'])
    assert len(commands) == 2
    def command(*args):
        return json.dumps(row if args[2] == '639' else header)
    ui._command = command
    assert not ui.row_visible(row['AXValue'])
    row['frame'] = {**row['frame'], 'y': 55}
    assert not ui.row_visible(row['AXValue'])  # Points beneath header are refused.


def test_foreground_interception_propagates_before_value_lookup(transcript_ui):
    from e2e.scenarios._m1_native_ui import SystemUIInterception
    ui, _, row, commands = transcript_ui
    def intercepted():
        raise SystemUIInterception('com.example.system', 1)
    ui.check_foreground = intercepted
    with pytest.raises(SystemUIInterception):
        ui.wait_hit(row['AXValue'], timeout=1, corrective=True)
    with pytest.raises(SystemUIInterception):
        ui.count(row['AXValue'])
    assert commands == []


def test_value_only_corrective_drag_requires_actual_movement(transcript_ui):
    ui, _, row, commands = transcript_ui
    row['frame'] = {**row['frame'], 'y': 900}
    with pytest.raises(RuntimeError, match='corrective drag did not move'):
        ui.wait_hit(row['AXValue'], timeout=1, corrective=True)
    assert len(commands) == 1 and commands[0][0] == 'swipe'


def test_value_only_corrective_drag_regates_moved_row(transcript_ui):
    import json
    ui, _, row, commands = transcript_ui
    row['frame'] = {**row['frame'], 'y': -10}
    def command(*args):
        commands.append(args)
        if args[0] == 'swipe':
            row['frame'] = {**row['frame'], 'y': 629}
            return ''
        return json.dumps(row)
    ui._command = command
    ui.wait_hit(row['AXValue'], timeout=1, corrective=True)
    assert [c[0] for c in commands] == ['swipe', 'describe-point']
    assert int(commands[0][2]) < int(commands[0][4])  # Top-clipped row: drag down.


def test_value_only_corrective_drag_budget_is_not_extended(transcript_ui, monkeypatch):
    from e2e.scenarios import _m1_native_ui as native
    ui, _, row, commands = transcript_ui
    row['frame'] = {**row['frame'], 'y': 900}
    clock = iter(range(20))
    monkeypatch.setattr(native.time, 'monotonic', lambda: next(clock))
    monkeypatch.setattr(native.time, 'sleep', lambda _: None)
    def command(*args):
        commands.append(args)
        row['frame'] = {**row['frame'], 'y': row['frame']['y'] + 2}
        return ''
    ui._command = command
    with pytest.raises(RuntimeError, match='did not pass hit testing'):
        ui.wait_hit(row['AXValue'], timeout=8, corrective=True)
    assert len(commands) == native.CORRECTIVE_DRAG_BUDGET
    assert all(c[0] == 'swipe' for c in commands)
