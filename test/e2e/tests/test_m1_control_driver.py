"""No-card and non-Nexus controls must keep the chat voice surface usable."""
import pytest
from types import SimpleNamespace
from e2e.scenarios._m1_mock_control import SESSION_CONTRACT

def context():
    return (SimpleNamespace(verify_baseline=lambda: {k: {"title": v[2], "session_generation": v[0]} for k, v in SESSION_CONTRACT.items()}), SimpleNamespace(mark=lambda: None, verify_session=lambda *_: True))
from e2e.scenarios import nexus_agents_history_questions as m1


class UI:
    def __init__(self, absent=True): self.calls, self.is_absent = [], absent
    def tap_navigation(self, identifier=None, label=None, destination=None):
        self.tap(identifier, label)
        if identifier and identifier.startswith('assistant-drawer-row-'):
            self.title = SESSION_CONTRACT[identifier.removeprefix('assistant-drawer-row-')][2]
    def wait_drawer(self, *args, **kwargs): return True
    def check_foreground(self): pass
    def tap(self, identifier=None, label=None): self.calls.append(('tap', identifier, label))
    def wait(self, identifier=None, label=None, timeout=20):
        self.calls.append(('wait', identifier, label))
        title = getattr(self, 'title', 'Assistant history fixture')
        return {'AXValue': title + ', codex, idle'}
    def wait_absent(self, identifier=None, label=None, timeout=15):
        self.calls.append(('wait_absent', identifier, label)); return self.is_absent
    def absent(self, identifier=None, label=None, duration=2):
        self.calls.append(('absent', identifier, label)); return self.is_absent


def test_non_nexus_control_checks_absence_and_real_voice_surface():
    ui = UI(); m1.drive_non_nexus_control(ui)
    assert ('tap', 'session-status-overlay-trigger', None) in ui.calls
    assert ('absent', 'status-overlay-close', None) in ui.calls
    assert ('tap', 'composer-mic-button', None) in ui.calls
    assert ('wait', 'composer-mic-button', 'Stop and send') in ui.calls
    assert ('wait', 'voice-recording-strip-discard', None) in ui.calls
    assert ('tap', 'voice-recording-strip-discard', None) in ui.calls
    assert ('wait_absent', 'voice-recording-strip-discard', None) in ui.calls
    assert ('wait', 'composer-mic-button', 'Voice mode') in ui.calls
    with pytest.raises(RuntimeError): m1.drive_non_nexus_control(UI(absent=False))


def test_childless_no_card_nexus_still_opens_status():
    ui = UI(); m1.drive_childless_control(ui, *context())
    assert any(c[:2] == ('tap', 'assistant-drawer-row-mock-host:childless') for c in ui.calls)
    assert ('tap', 'session-status-overlay-trigger', None) in ui.calls
    assert ('wait', None, 'Close session status') in ui.calls
    assert ('wait', None, 'No direct child agents are active.') in ui.calls
    assert ('absent', None, 'SUB-AGENTS') in ui.calls
    with pytest.raises(RuntimeError): m1.drive_childless_control(UI(absent=False), *context())


def test_non_nexus_with_card_opens_status_without_child_roster():
    ui = UI(); m1.drive_non_nexus_card_control(ui, *context())
    assert any(c[:2] == ('tap', 'assistant-drawer-row-mock-host:card-control') for c in ui.calls)
    assert ('wait', None, 'Close session status') in ui.calls
    assert ('absent', None, 'SUB-AGENTS') in ui.calls
    assert ('absent', None, 'Forbidden child') in ui.calls
    with pytest.raises(RuntimeError): m1.drive_non_nexus_card_control(UI(absent=False), *context())
