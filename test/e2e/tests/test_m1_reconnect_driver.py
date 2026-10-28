"""Two turns must render across an actual mock-initiated reconnect."""
import pytest
from e2e.scenarios import nexus_agents_history_questions as m1


class UI:
    def __init__(self, duplicate=False): self.calls, self.duplicate = [], duplicate
    def type_text(self, ident, value): self.calls.append(('type', ident, value))
    def tap(self, identifier=None, label=None): self.calls.append(('tap', identifier, label))
    def wait(self, identifier=None, label=None, timeout=20): self.calls.append(('wait', identifier, label))
    def wait_hit(self, label, timeout=20): self.calls.append(('hit', label))
    def count(self, label): return 2 if self.duplicate and label == 'Second synthetic reply.' else 1


class Control:
    def __init__(self, closed=1): self.closed = closed
    def rpc(self, kind, **payload): return {'closed': self.closed}


class Trace:
    def __init__(self, connected=True): self.connected = connected
    def mark(self): pass
    def wait_reconnect(self): return self.connected


def test_two_turn_driver_requires_reconnect_and_unique_visible_history():
    ui = UI()
    m1.drive_two_turns(ui, Control(), Trace())
    assert ('type', 'composer-input', 'M1 first turn') in ui.calls
    assert ('type', 'composer-input', 'M1 second turn') in ui.calls
    assert ('hit', 'Second synthetic reply.') in ui.calls
    with pytest.raises(RuntimeError): m1.drive_two_turns(UI(), Control(0), Trace())
    with pytest.raises(RuntimeError): m1.drive_two_turns(UI(), Control(), Trace(False))
    with pytest.raises(RuntimeError): m1.drive_two_turns(UI(True), Control(), Trace())
