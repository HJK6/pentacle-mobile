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
