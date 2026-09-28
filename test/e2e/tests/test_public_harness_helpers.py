"""Pure supplied-record and metadata contracts; no observer connection."""
import pytest
from harness import event_continuity as continuity
from harness.scenario_meta import validate_scenario_meta


def trace_event(seq, stream='example:session', timestamp=1):
    return {'name':'chat:event_received','timestamp':timestamp,'data':{'source':'chat.event','seq':seq,'stream_id':stream,'kind':'ASSIST_TEXT'}}


def test_sequence_extraction_preserves_global_gaps_and_stream_separation():
    trace = [trace_event(4), trace_event(4, timestamp=2), trace_event(9), trace_event(5, 'other:session')]
    assert list(continuity.applied_seq_first_ts(trace, 'example:session')) == [4, 9]
    assert continuity.foreign_chat_event_count(trace, 'example:session') == 1
    ok, error, info = continuity.assert_event_continuity(trace, 'example:session', [{'daemon_seq':4,'kind':'ASSIST_TEXT'},{'daemon_seq':9,'kind':'ASSIST_TEXT'}], scenario_run_id='synthetic', expected_complete=False)
    assert not ok and error


def test_render_projection_rejects_stale_wrong_run_and_exposes_duplicate():
    def projection(order, run='synthetic', timestamp=3):
        return {'name':continuity.TRANSCRIPT_ORDER_DUMP,'timestamp':timestamp,'data':{'stream_id':'example:session','scenario_run_id':run,'transcript_seq_order':order}}
    trace = [projection([4,9], 'other'), projection([4,9], timestamp=1), projection([4,9,9])]
    complete, order, duplicates, timestamp = continuity.logical_render_projection(trace, 'example:session', 'synthetic', 9, 2)
    assert complete and order == [4,9,9] and duplicates == [9] and timestamp == 3


def test_metadata_normalizes_only_declared_targets_and_requirements():
    meta = validate_scenario_meta({'target_compat':['simulator','device'],'requires':['real_keyboard']}, scenario_name='synthetic')
    assert meta.to_dict() == {'target_compat':['device','simulator'],'requires':['real_keyboard']}
    with pytest.raises(ValueError, match='unknown target'):
        validate_scenario_meta({'target_compat':['invalid']}, scenario_name='synthetic')
    with pytest.raises(ValueError, match='unknown requirement'):
        validate_scenario_meta({'target_compat':['device'],'requires':['invalid']}, scenario_name='synthetic')
