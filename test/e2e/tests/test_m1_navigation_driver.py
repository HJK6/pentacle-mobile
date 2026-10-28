"""Native driver must exercise both navigation exits and reject wrong page evidence."""
import pytest
from e2e.scenarios import nexus_agents_history_questions as m1


class UI:
    def __init__(self, broken=None): self.calls, self.broken = [], broken
    def tap(self, identifier=None, label=None): self.calls.append(('tap', identifier, label))
    def wait(self, identifier=None, label=None, timeout=20):
        self.calls.append(('wait', identifier, label))
        if self.broken is not None and (identifier == self.broken or label == self.broken): raise RuntimeError('missing')
    def wait_hit(self, label, timeout=20):
        self.calls.append(('hit', label))
        if self.broken == label: raise RuntimeError('missing')
    def wait_row(self, label, timeout=1):
        self.calls.append(('row', label))
        if self.broken == label: raise RuntimeError('missing')
    def swipe_up(self): self.calls.append(('swipe',))


class Trace:
    def __init__(self, rows): self.rows = rows
    def mark(self): pass
    def history_rows(self): return self.rows


def test_navigation_exercises_paging_and_both_exits():
    ui = UI()
    m1.drive_history_navigation(ui, Trace(['brief:older', 'tell:current']))
    assert ('tap', 'agent-thread-load-more', None) in ui.calls
    assert ('hit', 'Older direct-child brief.') in ui.calls
    assert ('hit', m1.HISTORY_TEXT) in ui.calls
    assert ('tap', 'agent-thread-back-status', None) in ui.calls
    assert ('tap', None, 'Close thread history') in ui.calls
    assert ('row', 'Worker 9') in ui.calls
    assert ('row', 'Inspect worker 9 history.') in ui.calls
    assert ('swipe',) in ui.calls


@pytest.mark.parametrize('rows', [[], ['tell:current'], ['brief:older', 'tell:current', 'tell:current']])
def test_paging_rejects_missing_or_duplicated_rows(rows):
    with pytest.raises(RuntimeError): m1.drive_history_navigation(UI(), Trace(rows))


def test_ninth_missing_fails():
    with pytest.raises(RuntimeError): m1.drive_history_navigation(UI('Worker 9'), Trace(['brief:older', 'tell:current']))
