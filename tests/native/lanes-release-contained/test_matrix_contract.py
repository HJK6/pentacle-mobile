"""Offline negative controls for the source-derived overflow oracle and phase order."""
import pytest
import run


def element(label, ident='lanes-map-overflow'):
    # Synthetic AX shape; no claim this is a captured device tree.
    return {'AXUniqueId': ident, 'AXLabel': label, 'type': 'Button'}


def test_source_derived_overflow_oracle_fails_closed():
    good = element('Show all 17 lanes')
    assert run.overflow_control([good], 17) is good
    for tree in ([], [element('Show all 16 lanes')], [good, dict(good)]):
        with pytest.raises(run.SetupFail):
            run.overflow_control(tree, 17)


def test_matrix_final_phase_follows_c_and_b_and_excludes_native_precedence():
    steps = run.plan()['steps']
    assert steps.index('run_c_reconnect') < steps.index('run_b_final') < steps.index('overflow_phase_boundary')
    assert steps.index('overflow_phase_boundary') < steps.index('overflow_add_lanes') < steps.index('overflow_assert')
    assert 'run_b_precedence' not in steps
    assert 'run_b_log' not in steps and 'run_b_index_unavailable' not in steps


def test_overflow_list_requires_all_seeded_lane_ids():
    ids = ['wl-' + format(i, '024x') for i in range(17)]
    assert run.validate_overflow_list(ids, ids) == ids
    with pytest.raises(run.AssertFail):
        run.validate_overflow_list(ids[:-1], ids)
    with pytest.raises(run.AssertFail):
        run.validate_overflow_list(ids + [ids[0]], ids)


def test_two_ring_order_detects_wrong_attention_order():
    import math
    center = {'x': 100, 'y': 100, 'width': 0, 'height': 0}
    elements = []
    for index in range(9):
        count, slot, rx, ry = (6, index, 100, 140) if index < 6 else (3, index-6, 182, 240)
        angle = math.radians(-90 + 360 * slot / count)
        elements.append({'AXUniqueId': f'lanes-map-lane-{index}', 'frame': {'x': 100 + rx*math.cos(angle)-5, 'y': 100 + ry*math.sin(angle)-5, 'width': 10, 'height': 10}})
    assert run.two_ring_order(elements, center) == [str(i) for i in range(9)]
    assert run.two_ring_order(elements[::-1], center) == [str(i) for i in range(9)]


def test_v1_five_lane_map_uses_shipped_circular_geometry():
    import math
    hub = {'AXIdentifier': 'lanes-map-assistant', 'frame': {'x': 167, 'y': 204, 'width': 68, 'height': 68}}
    ids = [f'wl-{i:024x}' for i in range(5)]
    nodes = []
    for i, lane in enumerate(ids):
        angle = math.radians(-90 + i * 360 / 5)
        size = 50 + i * 3
        nodes.append({'AXIdentifier': 'lanes-map-lane-' + lane,
                      'frame': {'x': 201 + 132 * math.cos(angle) - size/2,
                                'y': 238 + 132 * math.sin(angle) - size/2,
                                'width': size, 'height': size}})
    class FakeUi:
        def ids(self, prefix): return [e for e in reversed(nodes) if e['AXIdentifier'].startswith(prefix)]
        def find(self, identifier): return hub
    scenario = run.Run.__new__(run.Run)
    scenario.ui = FakeUi()
    assert scenario.visible_order('lanes-map-lane-') == ids
