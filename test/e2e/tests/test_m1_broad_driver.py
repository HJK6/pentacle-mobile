"""The broad scenario executes every stage and fails if any stage fails."""
import pytest
from e2e.scenarios import nexus_agents_history_questions as scenario
from e2e.scenarios import _m1_native_ui, _m1_mock_control
from e2e.tests.test_agent_question_scenarios import _Stream


@pytest.mark.parametrize('failure', [None, 'history', 'session:choice', 'session:free', 'session:combined',
                                     'turns', 'childless', 'non-nexus-card', 'non-nexus', 'card:choice', 'card:free', 'card:combined'])
def test_broad_scenario_requires_each_stage(monkeypatch, failure):
    seen = []
    class UI:
        def __init__(self, _config): pass
        def tap(self, identifier=None, label=None): pass
    class Control:
        def __init__(self, _url): pass
        def close(self): seen.append('closed')
    def stage(name):
        seen.append(name)
        if failure == name: raise RuntimeError('missing ' + name)
    monkeypatch.setattr(_m1_native_ui, 'NativeUI', UI)
    monkeypatch.setattr(_m1_mock_control, 'MockControl', Control)
    monkeypatch.setattr(scenario.M, 'await_mock_session_open', lambda *args, **kwargs: None)
    monkeypatch.setattr(scenario, 'drive_history_navigation', lambda *a: stage('history'))
    monkeypatch.setattr(scenario, 'drive_question', lambda ui, c, surface, mode: stage(f'{surface}:{mode}'))
    monkeypatch.setattr(scenario, 'drive_two_turns', lambda *a: stage('turns'))
    monkeypatch.setattr(scenario, 'drive_childless_control', lambda *a: stage('childless'))
    monkeypatch.setattr(scenario, 'drive_non_nexus_card_control', lambda *a: stage('non-nexus-card'))
    monkeypatch.setattr(scenario, 'drive_non_nexus_control', lambda *a: stage('non-nexus'))
    result = scenario.run({'M1_BROAD': '1', 'M1_MOCK_WS_URL': 'ws://127.0.0.1:18791'}, _Stream([]))
    assert result.verdict == ('PASS' if failure is None else 'FAIL')
    assert seen[-1] == 'closed'
    if failure is None:
        assert seen == ['history', 'session:choice', 'session:free', 'session:combined', 'turns', 'childless', 'non-nexus-card', 'non-nexus', 'card:choice', 'card:free', 'card:combined', 'closed']
