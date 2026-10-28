from e2e.scenarios import nexus_agents_history_questions as m1


def test_failed_case_continues_after_verified_reset():
    calls = []
    def failing():
        calls.append('first')
        raise RuntimeError('failed')
    def passing(): calls.append('second')
    result = m1.run_diagnostic_cells([('first', failing), ('second', passing)], lambda label: calls.append('reset') or True)
    assert calls == ['first', 'reset', 'second']
    assert [item['status'] for item in result] == ['FAIL', 'PASS']


def test_failed_reset_marks_remaining_unmeasured():
    calls = []
    def failing(): raise RuntimeError('failed')
    result = m1.run_diagnostic_cells([('first', failing), ('second', lambda: calls.append('second'))], lambda label: False)
    assert not calls
    assert [item['status'] for item in result] == ['FAIL', 'UNMEASURED']


def test_broad_diagnostic_records_partial_results_and_continues(monkeypatch):
    from e2e.scenarios import _m1_mock_control, _m1_native_ui
    calls = []
    class UI:
        def __init__(self, config): pass
        def tap(self, identifier=None, label=None): pass
    class Control:
        def __init__(self, url): pass
        def close(self): calls.append('close')
    def question(ui, control, surface, mode):
        calls.append(f'{surface}:{mode}')
        if (surface, mode) == ('session', 'free'): raise RuntimeError('missing submit')
    monkeypatch.setattr(_m1_native_ui, 'NativeUI', UI)
    monkeypatch.setattr(_m1_mock_control, 'MockControl', Control)
    monkeypatch.setattr(m1.M, 'await_mock_session_open', lambda *args, **kwargs: None)
    monkeypatch.setattr(m1, 'drive_history_navigation', lambda *args: None)
    monkeypatch.setattr(m1, 'drive_question', question)
    monkeypatch.setattr(m1, 'reset_diagnostic_question', lambda *args: True)
    for method in ('drive_two_turns', 'drive_childless_control', 'drive_non_nexus_card_control', 'drive_non_nexus_control'):
        monkeypatch.setattr(m1, method, lambda *args: None)
    verdict = m1.run_broad({'M1_DIAGNOSTIC': '1', 'M1_MOCK_WS_URL': 'ws://127.0.0.1:18791'}, None)
    assert verdict.verdict == 'FAIL'
    assert 'session:combined' in calls and 'card:custom' in calls and calls[-1] == 'close'
    assert next(cell for cell in verdict.extras['cells'] if cell['cell'] == 'session_free')['status'] == 'FAIL'
