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
    with pytest.raises(RuntimeError, match='ambiguous'):
        ui.present(label='M1 question')
