"""Target-only ordinary session reset proof; original M1 population stays held."""
from . import _mock_chat_streamd as M
from . import nexus_agents_history_questions as journey
from ._m1_mock_control import MockControl
from ._m1_native_ui import NativeUI, SystemUIInterception
from ..harness.asserts import EventSpec, Verdict, await_event

name = 'm1_reset_navigation'
SCENARIO_META = {'target_compat': {'simulator'}, 'requires': []}


def actions(config):
    _target_only(config)
    return ['autoaccept_biometric', 'disable_pentacle_auth']


def _target_only(config):
    if config.get('M1_RESET_NAVIGATION') != '1' or any(config.get(k) not in (None, '', '0')
            for k in ('M1_BROAD', 'M1_DIAGNOSTIC')):
        raise ValueError('target-only reset requires explicit admission; broad M1 remains held')


def params(config):
    _target_only(config)
    # Reuse the existing exact numeric-loopback validation, but no broad actions,
    # status/history route parameters or existing-chat navigation.
    validated = journey.params({**config, 'M1_BROAD': '1'})
    base = M.params_for_fixture(config, 'm1_broad_questions.json')
    return {**base, 'ws_url': validated['ws_url'],
            'active_stream_ids': 'home:assistant,mock-host:mock-session'}


def preflight(config, repo_root=None):
    _target_only(config)
    return M.preflight(config, repo_root)


def run(config, stream, cap=None):
    control = None
    extras = {'scope': 'target-only synthetic session reset', 'original_m1_matrix': 'HOLD',
              'native_certification': 'UNMEASURED', 'card_route': 'UNMEASURED'}
    try:
        _target_only(config)
        if not await_event(stream, EventSpec('chat:ws_open', timeout_s=25),
                           not_before=config['_native_armed_at']):
            raise RuntimeError('target reset mobile ws_open missing')
        if not await_event(stream, EventSpec('chat:event_received', where={
                'stream_id': 'home:assistant', 'seq': 39}, timeout_s=25),
                not_before=config['_native_armed_at']):
            raise RuntimeError('target reset mobile assistant event receipt missing')
        ui = NativeUI(config)
        control = MockControl(config['M1_MOCK_WS_URL'])
        trace = journey._NativeTrace(stream)
        trace.cutoff = config['_native_armed_at']
        control.trace = trace
        control.verify_baseline()
        trace.verify_session('home:assistant')
        ui.wait(identifier='assistant-header')
        ui.wait(label='Synthetic assistant home ready.')
        journey.open_session_from_assistant(ui, control, trace)
        if not journey.reset_to_session_baseline(ui, control):
            raise RuntimeError('target-only guarded session reset failed')
        extras['observer'] = control.observation
        if cap:
            cap.screenshot(name + '_verified')
        return Verdict(name, 'PASS', extras=extras).finish()
    except SystemUIInterception as exc:
        extras.update(reason_code='system_ui_interception', frontmost_bundle_id=exc.foreground,
                      video_timestamp_s=exc.video_timestamp_s)
        return Verdict(name, 'SETUP_FAIL', error=str(exc), extras=extras).finish()
    except Exception as exc:
        return Verdict(name, 'FAIL', error=str(exc), extras=extras).finish()
    finally:
        if control:
            control.close()
