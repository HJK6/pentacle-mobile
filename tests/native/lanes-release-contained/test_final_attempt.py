"""Offline controls for the final native setup repairs; no simulator is contacted."""
import datetime
import hashlib
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
import run


def test_companion_pin_checks_path_and_bytes_before_launch(tmp_path, monkeypatch):
    binary = tmp_path / 'idb_companion'
    binary.write_bytes(b'verified binary')
    monkeypatch.setattr(run, 'COMPANION_PATH', str(binary), raising=False)
    monkeypatch.setattr(run, 'COMPANION_SHA256', hashlib.sha256(binary.read_bytes()).hexdigest(), raising=False)
    assert run.verified_companion(str(binary)) == str(binary)
    binary.write_bytes(b'changed binary')
    with pytest.raises(run.SetupFail, match='companion'):
        run.verified_companion(str(binary))
    with pytest.raises(run.SetupFail, match='companion'):
        run.verified_companion(str(tmp_path / 'wrapper'))


def test_transient_alert_ax_failure_retries_before_exact_match(tmp_path, monkeypatch):
    events, taps = [], []
    button = {'AXLabel': 'Open', 'type': 'Button', 'frame': {'x': 1, 'y': 1, 'width': 44, 'height': 44}}
    screens = iter([subprocess.CompletedProcess([], 1, '', 'No translation object returned for simulator'),
                    subprocess.CompletedProcess([], 0, json.dumps([{'AXLabel': 'Open in “Pentacle”?', 'type': 'StaticText'}, button]), ''),
                    subprocess.CompletedProcess([], 0, '[]', '')])
    ui = run.Ui('SIM', 'idb', lambda *v: events.append(v), tmp_path, 'com.example.pentacle')
    ui._idb = lambda *a: next(screens)
    ui.dump = lambda *a: tmp_path / 'ax'
    ui.tap_element = lambda element, what, **kw: taps.append((element, what, kw))
    monkeypatch.setattr(run.time, 'sleep', lambda _: None)
    assert ui.clear_system_alerts() == ['Open in “Pentacle”?']
    assert len(taps) == 1 and taps[0][2] == {'system_dialog': True}
    assert any(event[0] == 'alert_ax_retry' for event in events)


def test_alert_ax_retries_are_bounded_and_other_failures_do_not_retry(tmp_path, monkeypatch):
    calls=[]
    ui=run.Ui('SIM','idb',lambda *v: None,tmp_path,'com.example.pentacle')
    monkeypatch.setattr(run.time,'sleep',lambda _: None)
    def broken(*args):
        calls.append(args)
        return subprocess.CompletedProcess(args,1,'','No translation object returned for simulator')
    ui._idb=broken
    with pytest.raises(run.SetupFail): ui.clear_system_alerts()
    assert len(calls) == 3
    calls.clear()
    def other(*args):
        calls.append(args)
        return subprocess.CompletedProcess(args,1,'','connection refused')
    ui._idb=other
    with pytest.raises(run.SetupFail): ui.clear_system_alerts()
    assert len(calls) == 1


def make_owned_cfu(fail=None):
    scenario = run.Run.__new__(run.Run)
    scenario.udid='SIM-OWNED'; scenario.result={}; commands=[]
    def simctl(*argv, **kwargs):
        commands.append(argv)
        op = argv[0]
        rc = 1 if op == fail else 0
        value = commands[0][-1] if op == 'spawn' and 'read' in argv else ''
        return subprocess.CompletedProcess(argv,rc,value,'')
    scenario.simctl=simctl
    return scenario, commands


def test_cfu_write_reboot_and_readback_on_same_device():
    scenario,commands=make_owned_cfu()
    scenario.configure_cfu()
    assert [x[0] for x in commands] == ['spawn','shutdown','boot','bootstatus','spawn']
    assert all(x[1] == 'SIM-OWNED' for x in commands)
    assert 'write' in commands[0] and '-date' in commands[0] and 'read' in commands[-1]
    assert scenario.result['cfu']['verified'] is True


def test_cfu_write_failure_is_recorded_and_nonfatal():
    scenario,commands=make_owned_cfu('spawn')
    scenario.configure_cfu()
    assert scenario.result['cfu']['verified'] is False
    assert scenario.result['cfu']['error']
    assert len(commands) == 1


def test_bad_companion_pin_stops_before_simulator_create(tmp_path, monkeypatch):
    binary=tmp_path/'companion'; binary.write_bytes(b'wrong')
    monkeypatch.setattr(run,'COMPANION_PATH',str(binary),raising=False)
    monkeypatch.setattr(run,'COMPANION_SHA256','0'*64,raising=False)
    scenario=run.Run.__new__(run.Run)
    scenario.args=SimpleNamespace(idb_companion=str(binary),device_type='device',runtime='runtime')
    scenario.run_id='fixture'
    calls=[]
    def create(*args, **kwargs):
        calls.append(args)
        raise AssertionError('simulator created before companion pin was checked')
    scenario.simctl=create
    with pytest.raises(run.SetupFail, match='companion'):
        scenario.activate_simulator()
    assert not calls


def test_cfu_readback_mismatch_is_recorded_without_raising():
    scenario,commands=make_owned_cfu()
    original=scenario.simctl
    def mismatch(*args, **kwargs):
        result=original(*args, **kwargs)
        if 'read' in args: result.stdout='2000-01-01 00:00:00 +0000\n'
        return result
    scenario.simctl=mismatch
    scenario.configure_cfu()
    assert scenario.result['cfu']['verified'] is False
    assert scenario.result['cfu']['error'] == 'readback failed or differed'



def test_cfu_write_failure_continues_real_activation(tmp_path, monkeypatch):
    scenario=run.Run.__new__(run.Run)
    scenario.run_id='fixture'; scenario.run_dir=tmp_path; scenario.evidence=tmp_path; scenario.shots=tmp_path
    scenario.result={'proof_app': {'hashes': {}}}; scenario.processes={}; scenario.bundle='com.example.pentacle'
    scenario.args=SimpleNamespace(idb_companion='pinned', device_type='device', runtime='runtime', app=tmp_path,
                                  idb='idb', bundle_id='com.example.pentacle')
    calls=[]
    def simctl(*args, **kwargs):
        calls.append(args)
        if args[0]=='create': return subprocess.CompletedProcess(args,0,'A'*8+'-'+ 'B'*4+'-'+ 'C'*4+'-'+ 'D'*4+'-'+ 'E'*12,'')
        if args[0]=='spawn' and 'write' in args: return subprocess.CompletedProcess(args,1,'','write failed')
        return subprocess.CompletedProcess(args,0,str(tmp_path) if args[0]=='get_app_container' else '', '')
    scenario.simctl=simctl
    monkeypatch.setattr(run,'verified_companion',lambda value:value,raising=False)
    monkeypatch.setattr(run.sd,'start_owned',lambda *args, **kwargs:{'label':'ui-companion'})
    scenario.activate_simulator()
    assert scenario.result['cfu']['verified'] is False
    assert 'ui-companion' in scenario.processes
    assert any(args[0]=='install' for args in calls)


def test_cfu_shutdown_timeout_attempts_to_restore_boot():
    scenario,commands=make_owned_cfu()
    original=scenario.simctl
    def timeout(*args, **kwargs):
        if args[0]=='shutdown':
            commands.append(args)
            raise subprocess.TimeoutExpired(args, 120)
        return original(*args, **kwargs)
    scenario.simctl=timeout
    scenario.configure_cfu()
    assert [x[0] for x in commands] == ['spawn','shutdown','boot','bootstatus']
    assert scenario.result['cfu']['verified'] is False
    assert scenario.result['cfu']['error'] == 'shutdown or reboot failed'


def test_cfu_boot_timeout_still_checks_boot_readiness():
    scenario,commands=make_owned_cfu()
    original=scenario.simctl
    def timeout(*args, **kwargs):
        if args[0]=='boot':
            commands.append(args)
            raise subprocess.TimeoutExpired(args, 120)
        return original(*args, **kwargs)
    scenario.simctl=timeout
    scenario.configure_cfu()
    assert [x[0] for x in commands] == ['spawn','shutdown','boot','bootstatus']
    assert scenario.result['cfu']['verified'] is False
    assert scenario.result['cfu']['error'] == 'shutdown or reboot failed'
