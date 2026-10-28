from __future__ import annotations

from . import _mock_chat_streamd as M
from ..harness.asserts import EventSpec, Verdict, await_event

SCENARIO_META = {"target_compat": {"simulator", "device"}, "requires": []}

name = "assistant_history_questions"
CHILD_STREAM_ID = "mock-host:child-worker"
CHILD_NAME = "History worker"
HISTORY_TEXT = "Render the visible roster and history."


def actions(config: dict) -> list[str]:
    if config.get('M1_BROAD') == '1':
        return ['autoaccept_biometric', 'open_existing_chat']
    return ["autoaccept_biometric", "open_existing_chat", "resolve_notification"]


def params(config: dict) -> dict[str, str]:
    broad = config.get('M1_BROAD') == '1'
    base = M.params_for_fixture(config, 'm1_broad_questions.json' if broad else 'assistant_history_questions.json')
    if broad:
        from urllib.parse import urlsplit
        url = str(config.get('M1_MOCK_WS_URL') or '')
        parsed = urlsplit(url)
        if (parsed.scheme != 'ws' or parsed.hostname != '127.0.0.1' or not parsed.port
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ('', '/')):
            raise ValueError('M1 broad requires an explicit loopback mock URL')
        base['ws_url'] = url
    base.update({
        "openStatus": "1",
        "agentHistory": CHILD_STREAM_ID,
        "agentHistoryGeneration": "child-generation",
        "action_kind": "ack",
        "marker": "History question",
        "text": "Scenario free-text assertion.",
    })
    return base


def preflight(config: dict, repo_root=None) -> str | None:
    del repo_root
    return M.preflight(config)


def run(config: dict, stream, cap=None) -> Verdict:
    if config.get('M1_BROAD') == '1':
        return run_broad(config, stream, cap)
    del config
    early = M.await_mock_session_open(stream, name=name)
    if early:
        return early
    roster = await_event(
        stream,
        EventSpec("harness:ui_trace", where={"kind": "nexus_agents_roster_rendered"}, timeout_s=25),
    )
    history = await_event(
        stream,
        EventSpec("harness:ui_trace", where={"kind": "nexus_agents_history_rendered", "child_stream_id": CHILD_STREAM_ID, "row_texts": [HISTORY_TEXT]}, timeout_s=25),
        not_before=roster.received_at if roster else None,
    )
    answer = await_event(
        stream,
        EventSpec("harness:ui_trace", where={"kind": "prompt_answer_dispatched", "question_id": "history-question"}, timeout_s=25),
    )
    failures: list[str] = []
    if not roster or CHILD_STREAM_ID not in roster.data.get("child_stream_ids", []):
        failures.append("Assistant roster did not render the direct child ID")
    if not roster or CHILD_NAME not in roster.data.get("child_names", []):
        failures.append("Assistant roster did not render the direct child name")
    if not history or HISTORY_TEXT not in history.data.get("row_texts", []):
        failures.append("history did not render the synthetic tell row")
    if not answer or answer.data.get("text_present") is not True:
        failures.append("durable free-text answer did not dispatch prompt.answer")
    if cap:
        cap.screenshot(name)
    return Verdict(
        name=name,
        verdict="FAIL" if failures else "PASS",
        error="; ".join(failures) if failures else None,
        extras={
            "child_stream_id": CHILD_STREAM_ID,
            "roster": dict(roster.data) if roster else None,
            "history": dict(history.data) if history else None,
            "prompt_answer": dict(answer.data) if answer else None,
        },
    ).finish()


def drive_question(ui, control, surface: str, mode: str) -> None:
    if surface not in {'session', 'card'} or mode not in {'choice', 'free', 'combined'}:
        raise ValueError('unsupported M1 question case')
    question_id = f'm1-{surface}-{mode}'
    body = f'M1 {surface} {mode} question'
    is_free = mode == 'free'
    options = ([{'id': 'acknowledge', 'label': 'Acknowledge'}] if is_free else
               [{'label': 'Proceed', 'value': 'proceed', 'description': 'M1 option detail.'}])
    notification = {
        'notification_id': f'notification-{question_id}', 'producer': 'agent_question.v1',
        'state': 'open', 'severity': 'info', 'title': body, 'body': body,
        'actions': [{'kind': 'ack', 'action_id': f'action-{question_id}', 'label': 'Proceed', 'value': {'answer': 'proceed'}}],
        'question': {'schema_version': 1, 'state': 'open', 'question_id': question_id,
                     'title': body, 'body': body, 'dedup_key': question_id,
                     'producer_stream_id': M.STREAM_ID, 'producer_provider': 'codex',
                     'response_mode': 'free_text' if is_free else 'single_choice',
                     'options': options, 'ttl_seconds': 3600},
    }
    control.rpc('debug_replay_notification', notification=notification)
    if surface == 'session':
        ui.tap('question-fab')
        prefix, submit = 'question', 'question-submit'
    else:
        if not ui.present('smart-question-prompt'):
            ui.tap('chat-row-toggle-mock-host-mock-session')
        prefix, submit = 'smart-question', 'smart-question-submit'
    ui.wait(identifier=f'{prefix}-prompt', label=body)
    if is_free:
        ui.type_text('question-freetext-0' if surface == 'session' else 'smart-question-free-text', 'free answer')
    else:
        ui.tap(f'{prefix}-option-1')
        if mode == 'combined':
            ui.type_text('question-note-0' if surface == 'session' else 'smart-question-note', 'note answer')
    ui.tap(submit)
    expected_text = 'free answer' if is_free else ('note answer' if mode == 'combined' else None)
    if not control.answer(question_id, None if is_free else ['proceed'], expected_text):
        raise RuntimeError('M1 question dispatch mismatch: ' + question_id)
    if not ui.wait_absent(label=body):
        raise RuntimeError('M1 answered question did not settle: ' + question_id)


def drive_history_navigation(ui, trace) -> None:
    ui.wait_hit(HISTORY_TEXT)
    trace.mark()
    ui.tap('agent-thread-load-more')
    if trace.history_rows() != ['brief:older', 'tell:current']:
        raise RuntimeError('M1 older history missing, reordered or duplicated')
    ui.wait_hit('Older direct-child brief.')
    ui.wait_hit(HISTORY_TEXT)
    ui.tap('agent-thread-back-status')
    ui.wait(label='Close session status')
    ui.tap('nexus-status-history-mock-host-child-worker')
    ui.tap_stable('Close thread history')
    ui.wait(label='Close session status')
    for _ in range(8):
        ui.swipe_up()
        try:
            ui.wait_row('Worker 9', timeout=1)
            ui.wait_row('Inspect worker 9 history.', timeout=1)
            return
        except RuntimeError:
            continue
    raise RuntimeError('M1 ninth worker did not become visible')


def drive_two_turns(ui, control, trace) -> None:
    ui.type_text('composer-input', 'M1 first turn')
    ui.tap('composer-send-button')
    ui.wait_hit('M1 first turn')
    ui.wait_hit('First synthetic reply.')
    trace.mark()
    closed = control.rpc('debug_replay_close', client='pentacle-mobile', close_reason='M1 reconnect')
    if closed.get('closed') != 1 or not trace.wait_reconnect():
        raise RuntimeError('M1 mock reconnect not observed')
    ui.wait_hit('M1 first turn')
    ui.wait_hit('First synthetic reply.')
    ui.type_text('composer-input', 'M1 second turn')
    ui.tap('composer-send-button')
    ui.wait_hit('M1 second turn')
    ui.wait_hit('Second synthetic reply.')
    for text in ('M1 first turn', 'First synthetic reply.', 'M1 second turn', 'Second synthetic reply.'):
        if ui.count(text) != 1:
            raise RuntimeError('M1 turn missing or duplicated: ' + text)


def drive_non_nexus_control(ui) -> None:
    ui.tap(label='Back to chats')
    ui.tap('chat-row-mock-host-control-session')
    ui.tap('session-status-overlay-trigger')
    if not ui.absent('status-overlay-close') or not ui.absent('nexus-status-agents'):
        raise RuntimeError('M1 non-Nexus no-card control displayed a status overlay')
    ui.tap('composer-mic-button')
    ui.wait('composer-mic-button', label='Stop and send')
    ui.wait('voice-recording-strip-discard')
    ui.tap('voice-recording-strip-discard')
    if not ui.wait_absent('voice-recording-strip-discard'):
        raise RuntimeError('M1 synthetic recording was not discarded')
    ui.wait('composer-mic-button', label='Voice mode')
    ui.tap(label='Back to chats')
    ui.tap('chat-row-mock-host-mock-session')


def drive_childless_control(ui) -> None:
    ui.tap(label='Back to chats')
    ui.tap('chat-row-mock-host-childless')
    ui.tap('session-status-overlay-trigger')
    ui.wait(label='Close session status')
    ui.wait('nexus-status-childless')
    if not ui.absent('nexus-status-agents'):
        raise RuntimeError('M1 childless Nexus unexpectedly displayed a roster')
    ui.tap(label='Close session status')
    ui.tap(label='Back to chats')
    ui.tap('chat-row-mock-host-mock-session')


class _NativeTrace:
    def __init__(self, stream):
        self.stream = stream
        self.cutoff = 0.0

    def mark(self):
        import time
        self.cutoff = time.monotonic()

    def history_rows(self):
        event = await_event(self.stream, EventSpec('harness:ui_trace', where={
            'kind': 'nexus_agents_history_rendered', 'child_stream_id': CHILD_STREAM_ID,
            'row_ids': ['brief:older', 'tell:current'],
        }, timeout_s=25), not_before=self.cutoff)
        return event.data.get('row_ids') if event else []

    def wait_reconnect(self):
        return bool(await_event(self.stream, EventSpec('chat:ws_reconnect_succeeded', timeout_s=45),
                                not_before=self.cutoff))


def run_broad(config: dict, stream, cap=None) -> Verdict:
    from ._m1_native_ui import NativeUI
    from ._m1_mock_control import MockControl
    early = M.await_mock_session_open(stream, name=name)
    if early:
        return early
    control = None
    try:
        ui = NativeUI(config)
        control = MockControl(str(config.get('M1_MOCK_WS_URL') or ''))
        trace = _NativeTrace(stream)
        drive_history_navigation(ui, trace)
        ui.tap(label='Close session status')
        for mode in ('choice', 'free', 'combined'):
            drive_question(ui, control, 'session', mode)
        drive_two_turns(ui, control, trace)
        drive_childless_control(ui)
        drive_non_nexus_card_control(ui)
        drive_non_nexus_control(ui)
        ui.tap(label='Back to chats')
        for mode in ('choice', 'free', 'combined'):
            drive_question(ui, control, 'card', mode)
        if cap:
            cap.screenshot('m1_broad_questions')
        return Verdict(name=name, verdict='PASS', extras={'scope': 'synthetic broad M1'}).finish()
    except Exception as exc:
        return Verdict(name=name, verdict='FAIL', error=str(exc), extras={'scope': 'synthetic broad M1'}).finish()
    finally:
        if control:
            control.close()


def drive_non_nexus_card_control(ui) -> None:
    ui.tap(label='Back to chats')
    ui.tap('chat-row-mock-host-card-control')
    ui.tap('session-status-overlay-trigger')
    ui.wait(label='Close session status')
    if not ui.absent(label='SUB-AGENTS') or not ui.absent(label='Forbidden child'):
        raise RuntimeError('M1 non-Nexus status showed child roster')
    ui.tap(label='Close session status')
    ui.tap(label='Back to chats')
    ui.tap('chat-row-mock-host-mock-session')
