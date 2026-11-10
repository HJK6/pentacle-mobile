"""Offline negative controls for the source-derived overflow oracle and phase order."""
import pytest
import run


def test_matrix_final_phase_follows_c_and_b():
    steps = run.plan()['steps']
    assert steps.index('run_c_reconnect') < steps.index('run_b_final') < steps.index('overflow_phase_boundary')
    assert steps.index('overflow_phase_boundary') < steps.index('overflow_add_lanes') < steps.index('overflow_assert')
    assert 'run_b_index_unavailable' in steps and 'run_b_large_text' in steps
    assert 'run_b_precedence' not in steps and 'run_b_log' not in steps


def test_overflow_list_requires_all_seeded_lane_ids():
    ids = ['wl-' + format(i, '024x') for i in range(17)]
    assert run.validate_overflow_list(ids, ids) == ids
    with pytest.raises(run.AssertFail):
        run.validate_overflow_list(ids[:-1], ids)
    with pytest.raises(run.AssertFail):
        run.validate_overflow_list(ids + [ids[0]], ids)
