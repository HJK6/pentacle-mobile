"""Validate the actual replay fixture through the selected loader."""
from pathlib import Path
from e2e.tools.scripted_replay import load_script


def test_broad_fixture_has_explicit_targets_and_two_turns():
    script = load_script(Path(__file__).resolve().parents[1] / 'fixtures/scripted_daemon/m1_broad_questions.json')
    sessions = {row['stream_id']: row for row in script.snapshot['sessions']}
    parent = sessions['mock-host:mock-session']
    assert parent['role'] == 'nexus' and not parent.get('status_card')
    assert len(parent['agents']) == 9 and parent['agents'][8]['display_name'] == 'Worker 9'
    assert sessions['mock-host:control-session']['role'] != 'nexus'
    assert sessions['mock-host:childless']['role'] == 'nexus' and sessions['mock-host:childless']['agents'] == []
    pages = script.snapshot['thread_history']['mock-host:mock-session|mock-host:child-worker']['pages']
    assert [page['cursor'] for page in pages] == [None, 'older']
    assert script.send_echo['assistant_replies'] == ['First synthetic reply.', 'Second synthetic reply.']


def test_broad_launch_uses_only_explicit_loopback_mock():
    import pytest
    from e2e.scenarios import nexus_agents_history_questions as scenario
    config = {'M1_BROAD': '1', 'M1_MOCK_WS_URL': 'ws://127.0.0.1:18791'}
    assert scenario.params(config)['ws_url'] == config['M1_MOCK_WS_URL']
    assert 'resolve_notification' not in scenario.actions(config)
    for url in ('', 'wss://example.com:443', 'ws://127.0.0.1:1234/?token=secret', 'ws://localhost:1234'):
        with pytest.raises(ValueError): scenario.params({**config, 'M1_MOCK_WS_URL': url})
