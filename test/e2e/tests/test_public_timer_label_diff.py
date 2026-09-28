import json
import pytest
from e2e.harness.timer_label_diff import parse_daemon_log, parse_mobile_run_json, build_diff, render_markdown


def report(tmp_path, renders):
    daemon=tmp_path/'observer.jsonl'
    daemon.write_text(json.dumps(dict(kind='working.state', stream_id='synthetic:stream',
        timestamp_observer_monotonic=10, raw_payload={'elapsed_ms':1000}))+'\n')
    mobile=tmp_path/'run.json'
    mobile.write_text(json.dumps({'all_events':[dict(message='harness:dock_label_render',
        received_at=ts,data=dict(stream_id='synthetic:stream',elapsed_seconds=seconds,label='synthetic'))
        for ts,seconds in renders]}))
    return build_diff(scenario='synthetic',daemon_points=parse_daemon_log(daemon),
        render_points=parse_mobile_run_json(mobile),max_allowed_latency_ms=200)


def test_matched_timer_is_rendered_within_budget(tmp_path):
    value=report(tmp_path,[(10.1,1)])
    assert value.passed
    assert value.timeline[0].status=='rendered'
    assert value.max_latency_ms==100
    assert 'PASS' in render_markdown(value)


@pytest.mark.parametrize('renders,status,anomaly',[
    ([], 'missing_render', None),
    ([(10.5,1)],'late_render',None),
    ([(10.1,0)],'missing_render','stale_render'),
    ([(9.9,1)],'missing_render','unbacked_render'),
])
def test_missing_late_stale_and_unbacked_render_refuse_success(tmp_path,renders,status,anomaly):
    value=report(tmp_path,renders)
    assert not value.passed
    assert value.timeline[0].status==status
    if anomaly:
        assert value.render_anomalies[0].status==anomaly
    assert 'FAIL' in render_markdown(value)
