"""Synthetic UI/control doubles exercise the answer driver and its exact wire oracle."""
import pytest
from e2e.scenarios import nexus_agents_history_questions as m1


class UI:
    def __init__(self): self.calls = []
    def wait(self, identifier=None, label=None, timeout=20): self.calls.append(('wait', identifier, label))
    def tap(self, identifier=None, label=None): self.calls.append(('tap', identifier, label))
    def type_text(self, identifier, text): self.calls.append(('text', identifier, text))
    def present(self, identifier, timeout=1): return False
    def wait_absent(self, identifier=None, label=None, timeout=15): return True


class Control:
    def __init__(self, matches=True): self.matches, self.calls = matches, []
    def rpc(self, kind, **payload): self.calls.append((kind, payload))
    def answer(self, question_id, selections, text): self.calls.append(('answer', question_id, selections, text)); return self.matches


@pytest.mark.parametrize('surface', ['session', 'card'])
@pytest.mark.parametrize('mode, selections, text', [('choice', ['proceed'], None), ('free', None, 'free answer'), ('combined', ['proceed'], 'note answer')])
def test_answer_surface_requires_exact_stub_frame(surface, mode, selections, text):
    ui, control = UI(), Control()
    m1.drive_question(ui, control, surface, mode)
    assert control.calls[-1] == ('answer', f'm1-{surface}-{mode}', selections, text)
    prefix = 'question' if surface == 'session' else 'smart-question'
    assert ('tap', 'question-fab' if surface == 'session' else 'chat-row-toggle-mock-host-mock-session', None) in ui.calls
    assert ('tap', 'question-submit' if surface == 'session' else 'smart-question-submit', None) in ui.calls
    if mode != 'free':
        assert ('tap', f'{prefix}-option-1', None) in ui.calls
    if mode == 'combined':
        assert ('text', 'question-note-0' if surface == 'session' else 'smart-question-note', 'note answer') in ui.calls
    if mode == 'free':
        assert ('text', 'question-freetext-0' if surface == 'session' else 'smart-question-free-text', 'free answer') in ui.calls
    with pytest.raises(RuntimeError):
        m1.drive_question(UI(), Control(matches=False), surface, mode)


def test_free_text_question_matches_real_loader_contract(tmp_path):
    import json
    from pathlib import Path
    from e2e.tools.scripted_replay import ScriptValidationError, load_script
    control = Control()
    m1.drive_question(UI(), control, 'session', 'free')
    notification = control.calls[0][1]['notification']
    source = Path(__file__).resolve().parents[1] / 'fixtures/scripted_daemon/m1_broad_questions.json'
    payload = json.loads(source.read_text())
    payload['notifications'] = [{'id': 'free', 'at_ms': 1, 'notification': notification}]
    fixture = tmp_path / 'question.json'
    fixture.write_text(json.dumps(payload))
    assert load_script(fixture).notifications
    payload['notifications'][0]['notification']['question']['options'] = []
    fixture.write_text(json.dumps(payload))
    with pytest.raises(ScriptValidationError, match='non-empty array'):
        load_script(fixture)
