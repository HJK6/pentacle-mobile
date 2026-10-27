"""Viewport proof rejects off-screen content even if AX exposes its node."""
from e2e.scenarios import nexus_agents_history_questions as scenario


def test_ninth_worker_requires_frame_inside_native_application():
    screen = {'role': 'AXApplication', 'frame': {'x': 0, 'y': 0, 'width': 402, 'height': 874}}
    target = {'AXLabel': 'Worker nine', 'frame': {'x': 15, 'y': 700, 'width': 160, 'height': 30}}
    assert scenario.visible_ax_text([screen, target], 'Worker nine')
    assert not scenario.visible_ax_text([screen, {**target, 'frame': {**target['frame'], 'y': 900}}], 'Worker nine')
    assert not scenario.visible_ax_text([screen, target], 'Worker ten')
    assert not scenario.visible_ax_text([target], 'Worker nine')
