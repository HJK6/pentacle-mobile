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


def test_old_session_only_reset_blankets_non_session_failures():
    # Documents the window-05 defect: a reset that only covers session_ cells
    # returns False for the first non-session failure, so every later cell is
    # UNMEASURED even though the failure was isolated to one cell.
    ran = []
    cells = [
        ('session_choice', lambda: ran.append('session_choice')),
        ('two_turn_reconnect', lambda: (_ for _ in ()).throw(RuntimeError('clipped'))),
        ('card_choice', lambda: ran.append('card_choice')),
    ]
    old_reset = lambda label: label.startswith('session_') and True
    result = m1.run_diagnostic_cells(cells, old_reset)
    assert [item['status'] for item in result] == ['PASS', 'FAIL', 'UNMEASURED']
    assert 'card_choice' not in ran


def test_cell_reset_isolates_non_session_failure_per_cell():
    # The fix: a reset that also returns a verified baseline for non-session
    # cells keeps `safe` True, so one failure no longer blankets the rest.
    ran = []
    cells = [
        ('session_choice', lambda: ran.append('session_choice')),
        ('two_turn_reconnect', lambda: (_ for _ in ()).throw(RuntimeError('clipped'))),
        ('card_choice', lambda: ran.append('card_choice')),
    ]
    result = m1.run_diagnostic_cells(cells, lambda label: True)
    assert [item['status'] for item in result] == ['PASS', 'FAIL', 'PASS']
    assert ran == ['session_choice', 'card_choice']


def test_reset_diagnostic_cell_routes_session_cards_and_in_session(monkeypatch):
    seen = []
    monkeypatch.setattr(m1, 'reset_diagnostic_question', lambda ui, control: seen.append('question') or True)
    monkeypatch.setattr(m1, 'reset_to_session_baseline', lambda ui, control: seen.append('session') or True)
    monkeypatch.setattr(m1, 'reset_to_cards_baseline', lambda ui, control: seen.append('cards') or True)
    assert m1.reset_diagnostic_cell(object(), object(), 'session_free') is True
    assert m1.reset_diagnostic_cell(object(), object(), 'two_turn_reconnect') is True
    assert m1.reset_diagnostic_cell(object(), object(), 'enter_cards') is True
    assert m1.reset_diagnostic_cell(object(), object(), 'card_custom') is True
    # session_ -> in-place question reset; card_/enter_cards -> chat-list
    # baseline; other in-session cells -> session composer baseline.
    assert seen == ['question', 'session', 'cards', 'cards']


def test_reset_diagnostic_cell_fails_closed_on_reset_exception(monkeypatch):
    def boom(ui, control): raise RuntimeError('cannot reach baseline')
    monkeypatch.setattr(m1, 'reset_to_session_baseline', boom)
    assert m1.reset_diagnostic_cell(object(), object(), 'two_turn_reconnect') is False


def test_broad_diagnostic_continues_after_non_session_failure(monkeypatch):
    from e2e.scenarios import _m1_mock_control, _m1_native_ui
    ran = []
    class UI:
        def __init__(self, config): pass
        def tap(self, identifier=None, label=None): pass
    class Control:
        def __init__(self, url): pass
        def close(self): ran.append('close')
    monkeypatch.setattr(_m1_native_ui, 'NativeUI', UI)
    monkeypatch.setattr(_m1_mock_control, 'MockControl', Control)
    monkeypatch.setattr(m1.M, 'await_mock_session_open', lambda *a, **k: None)
    monkeypatch.setattr(m1, 'drive_history_navigation', lambda *a: None)
    monkeypatch.setattr(m1, 'drive_question', lambda ui, control, surface, mode: ran.append(f'{surface}:{mode}'))
    monkeypatch.setattr(m1, 'drive_childless_control', lambda *a: ran.append('childless'))
    monkeypatch.setattr(m1, 'drive_non_nexus_card_control', lambda *a: ran.append('non_nexus_card'))
    monkeypatch.setattr(m1, 'drive_non_nexus_control', lambda *a: ran.append('non_nexus_voice'))
    monkeypatch.setattr(m1, 'drive_two_turns', lambda *a: (_ for _ in ()).throw(RuntimeError('M1 visible row did not pass hit testing: M1 first turn')))
    # Reset verifies the baseline for every cell so a non-session failure isolates.
    monkeypatch.setattr(m1, 'reset_diagnostic_cell', lambda ui, control, label: True)
    verdict = m1.run_broad({'M1_DIAGNOSTIC': '1', 'M1_MOCK_WS_URL': 'ws://127.0.0.1:18791'}, None)
    cells = {c['cell']: c['status'] for c in verdict.extras['cells']}
    assert verdict.verdict == 'FAIL'
    assert cells['two_turn_reconnect'] == 'FAIL'
    # Cells after the non-session failure are still measured, not blanket-UNMEASURED.
    assert cells['childless'] == 'PASS'
    assert cells['card_custom'] == 'PASS'
    assert 'UNMEASURED' not in cells.values()
    assert ran[-1] == 'close'
