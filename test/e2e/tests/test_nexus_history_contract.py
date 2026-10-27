"""Replay the product's roster/history signals through the native oracle."""
import json
from pathlib import Path

import pytest

import run_scenario
from e2e.scenarios import nexus_agents_history_questions as scenario
from e2e.tests.test_agent_question_scenarios import _event, _patch_await, _Stream


def test_native_runner_registers_the_history_scenario():
    assert run_scenario.build_scenarios()['nexus_agents_history_questions'].module is scenario


def test_history_fixture_has_a_nexus_parent():
    fixture = Path(__file__).resolve().parents[1] / 'fixtures/scripted_daemon/nexus_agents_history_questions.json'
    payload = json.loads(fixture.read_text())
    parent = payload['snapshot']['sessions'][0]
    assert parent['role'] == 'nexus'
    assert parent['agents'][0]['stream_id'] == scenario.CHILD_STREAM_ID


@pytest.mark.parametrize('missing', [None, 'child_stream_ids', 'child_names', 'row_texts', 'text_present'])
def test_product_history_signals_keep_every_native_predicate(monkeypatch, missing):
    _patch_await(monkeypatch, scenario)
    monkeypatch.setattr(scenario.M, 'await_mock_session_open', lambda *args, **kwargs: None)
    roster = dict(kind='nexus_agents_roster_rendered', child_stream_ids=[scenario.CHILD_STREAM_ID], child_names=[scenario.CHILD_NAME])
    history = dict(kind='nexus_agents_history_rendered', child_stream_id=scenario.CHILD_STREAM_ID, row_texts=[scenario.HISTORY_TEXT])
    answer = dict(kind='prompt_answer_dispatched', question_id='history-question', text_present=True)
    for data in (roster, history, answer):
        data.pop(missing, None)
    stream = _Stream([_event('harness:ui_trace', i, **data) for i, data in enumerate((roster, history, answer), 1)])
    verdict = scenario.run({}, stream)
    assert verdict.verdict == ('PASS' if missing is None else 'FAIL')


def test_answer_can_precede_roster_and_initial_history_can_be_empty(monkeypatch):
    _patch_await(monkeypatch, scenario)
    monkeypatch.setattr(scenario.M, 'await_mock_session_open', lambda *args, **kwargs: None)
    stream = _Stream([
        _event('harness:ui_trace', 1, kind='prompt_answer_dispatched', question_id='history-question', text_present=True),
        _event('harness:ui_trace', 2, kind='nexus_agents_roster_rendered', child_stream_ids=[scenario.CHILD_STREAM_ID], child_names=[scenario.CHILD_NAME]),
        _event('harness:ui_trace', 3, kind='nexus_agents_history_rendered', child_stream_id=scenario.CHILD_STREAM_ID, row_texts=[]),
        _event('harness:ui_trace', 4, kind='nexus_agents_history_rendered', child_stream_id=scenario.CHILD_STREAM_ID, row_texts=[scenario.HISTORY_TEXT]),
    ])
    assert scenario.run({}, stream).verdict == 'PASS'
