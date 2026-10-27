import copy

import pytest
import run_scenario
from e2e.scenarios import mock_answer_fallback_reconcile as scenario
from e2e.tests.test_agent_question_scenarios import _event, _patch_await, _Stream


def trace():
    def listed(at, row_id):
        return _event('harness:ui_trace', at, kind='transcript_list_update', stream_id=scenario.M.STREAM_ID,
                      first_row_id=row_id, data_count=1, pending_count=0, queued_count=0, row_order=[{'id': row_id}])
    def mounted(at, row_id):
        return _event('harness:row_rendered', at, stream_id=scenario.M.STREAM_ID, row_id=row_id,
                      component_name='TranscriptRow', lifecycle='mount', text_prefix=scenario.TEXT)
    stages = {
        'summary_list': listed(1, scenario.FALLBACK_ID), 'summary_mount': mounted(1.1, scenario.FALLBACK_ID),
        'durable_list': listed(2, scenario.DURABLE_ID), 'durable_mount': mounted(2.1, scenario.DURABLE_ID),
        'echo': _event('chat:event_received', 3, stream_id=scenario.M.STREAM_ID, seq=460967976),
    }
    return list(stages.values()), stages


def test_registered_complete_native_trace_passes():
    assert run_scenario.build_scenarios()[scenario.name].module is scenario
    assert scenario.evaluate_trace(*trace()) == []


@pytest.mark.parametrize('missing', ['summary_list', 'summary_mount', 'durable_list', 'durable_mount', 'echo'])
def test_every_rendered_stage_is_required(missing):
    events, stages = trace()
    stages[missing] = None
    assert scenario.evaluate_trace(events, stages)


@pytest.mark.parametrize('fault', ['duplicate', 'raw', 'pending', 'durable_loss', 'wrong_echo', 'wrong_mount', 'out_of_order'])
def test_native_oracle_rejects_incomplete_or_duplicate_answer_evidence(fault):
    events, stages = copy.deepcopy(trace())
    if fault == 'duplicate':
        stages['durable_list'].data['data_count'] = 2
    elif fault == 'raw':
        stages['durable_mount'].data['text_prefix'] = '[notification.answer]'
    elif fault == 'pending':
        stages['durable_list'].data['pending_count'] = 1
    elif fault == 'durable_loss':
        events.append(_event('harness:row_rendered', 3.1, component_name='TranscriptRow', row_id=scenario.DURABLE_ID, lifecycle='unmount', text_prefix=scenario.TEXT))
    elif fault == 'wrong_echo':
        stages['echo'].data['seq'] = 460967977
    elif fault == 'wrong_mount':
        stages['durable_mount'].data['row_id'] = 'unrelated'
    else:
        stages['echo'].received_at = .5
    assert scenario.evaluate_trace(events, stages)


def test_missing_middle_state_withholds_the_echo(monkeypatch):
    events, _ = trace()
    events = [event for event in events if event.data.get('first_row_id') != scenario.DURABLE_ID and event.data.get('row_id') != scenario.DURABLE_ID]
    _patch_await(monkeypatch, scenario)
    monkeypatch.setattr(scenario.M, 'await_mock_session_open', lambda *args, **kwargs: None)
    operations = []
    monkeypatch.setattr(scenario, 'fixture_rpc', lambda config, operation, payload: operations.append(operation))
    result = scenario.run({'ws_url': 'ws://127.0.0.1:18791'}, _Stream(events))
    assert result.verdict == 'FAIL'
    assert operations == ['debug_replay_notification']


def test_fixture_rpc_refuses_external_targets_and_unknown_operations():
    with pytest.raises(ValueError, match='loopback'):
        scenario.fixture_url({'ws_url': 'ws://example.test:18791'})
    with pytest.raises(ValueError, match='unsupported'):
        scenario.fixture_rpc({'ws_url': 'ws://127.0.0.1:18791'}, 'send', {})
