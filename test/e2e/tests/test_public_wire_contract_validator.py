from __future__ import annotations

import pytest

from e2e.wire_contract_validator import ContractMismatch, _validate_allow_custom, _validate_mobile_live


def test_allow_custom_requires_absence_or_exact_true() -> None:
    _validate_allow_custom({}, False, "test")
    _validate_allow_custom({"allow_custom": True}, True, "test")
    with pytest.raises(ContractMismatch, match="must be absent"):
        _validate_allow_custom({"allow_custom": False}, False, "test")
    with pytest.raises(ContractMismatch, match="contract mismatch"):
        _validate_allow_custom({}, True, "test")


def test_mobile_live_matrix_requires_exact_payload_deliveries_and_side_effects() -> None:
    responses = [{
        "type": "chat.event",
        "event": {
            "daemon_seq": 10,
            "kind": "TOOL_BATCH_SUMMARY",
            "text": "Ran 2 shell commands",
            "raw": {
                "source": "claude-jsonl",
                "subtype": "tool-batch-summary",
                "span_size": 2,
                "tool_breakdown": {"Bash": 2},
                "tool_use_ids": ["toolu_1", "toolu_2"],
            },
        },
    }]
    emissions = [{"daemon_seq": seq} for seq in [10, 11, *range(100, 120), *range(200, 210), 300]]
    attempts = [{"text": text} for text in [
        "Definitive pre-land failure",
        "Definitive pre-land failure",
        "Landed once with result delivered",
        "Landed once while result was lost",
        "Half-open send cut",
        "Drop after send without ack",
        "Disconnect during send",
        "Background foreground pending send",
        "Daemon restart pending send",
        "Duplicate delivery probe",
    ]]
    sends = [attempts[index] for index in (1, 2, 3, 5, 9)]

    assert _validate_mobile_live(responses, emissions, attempts, sends)["side_effect_count"] == 5
    with pytest.raises(ContractMismatch, match="side-effect matrix"):
        _validate_mobile_live(responses, emissions, attempts, sends[:-1])


import json
import subprocess
import sys
from e2e.wire_contract_validator import validate_contract, mutation_proof

CHECKOUT = 'a'*40
PROVENANCE_HASHES = (
    'loaded_chat_streamd_sha256', 'loaded_spawn_profiles_sha256',
    'loaded_daemon_init_code_sha256', 'loaded_handle_client_code_sha256',
    'loaded_validate_v2_code_sha256', 'loaded_spawn_catalog_code_sha256',
)


def synthetic_artifacts(root, case='question_options'):
    def put(name, value):
        path = root/name
        path.write_text(json.dumps(value))
        return path
    put('provenance.json', dict(checkout_commit=CHECKOUT, **{key:'b'*64 for key in PROVENANCE_HASHES}))
    put('cleanup.json', {'cleaned':True})
    options = [{'label':'Synthetic choice', 'value':'choice'}]
    if case == 'question_options':
        fixture = {'schema_version':1, 'case':case, 'question':{'options':options},
                   'answer':{'expected_selection':{'label':'Synthetic choice', 'value':'choice'}}}
        requests = [{'type':'notification.resolve', 'request_id':'synthetic-answer',
                     'selections':[fixture['answer']['expected_selection']]}]
        responses = [
            {'type':'prompt.ask.ok', 'request_id':'seed-'+case, 'question':{'envelope':{'options':options}}},
            {'type':'notification', 'notification':{'state':'open', 'question':{'options':options}}},
            {'type':'notification.resolve.ok'},
        ]
    else:
        selected = dict(host='synthetichost', provider='codex', model='synthetic-model',
                        effort='medium', spawn_profile='synthetic-profile', resolution_source='catalog')
        fixture = {'schema_version':1, 'case':'spawn_controls', 'spawn':selected}
        requests = [dict(type='spawn', schema='SpawnRequestV2', catalog_version='synthetic-v1',
                         request_id='synthetic-spawn', **selected)]
        launch = {key:selected[key] for key in ('provider','model','effort')}
        responses = [
            {'type':'spawn_catalog_get.ok', 'catalog_version':'synthetic-v1',
             'models':{'codex':{'synthetic-model':{'efforts':['medium']}}}},
            {'type':'spawn.ok', 'request_id':'synthetic-spawn',
             'session':{key:launch for key in ('requested_launch_tuple','resolved_launch_tuple','actual_launch_tuple')}},
        ]
    put('requests.json', [{'parsed':row} for row in requests])
    put('responses.json', [{'parsed':row} for row in responses])
    return put('fixture.json', fixture)


@pytest.mark.parametrize('case', ['question_options','spawn_controls'])
def test_explicit_checkout_accepts_fresh_artifacts_and_mutation_rejects(tmp_path, case):
    fixture = synthetic_artifacts(tmp_path, case)
    assert validate_contract(tmp_path, fixture, expected_checkout=CHECKOUT)['server_checkout'] == CHECKOUT
    proof = mutation_proof(tmp_path, fixture, tmp_path/'proof.json', expected_checkout=CHECKOUT)
    assert proof['validator_rejected'] is True
    assert proof['control']['server_checkout'] == CHECKOUT
    assert proof['status'] == 'passed'
    if case == 'question_options':
        assert mutation_proof(tmp_path, fixture, tmp_path/'presence.json',
                              'allow_custom_presence', expected_checkout=CHECKOUT)['validator_rejected'] is True


@pytest.mark.parametrize('expected', ['', 'a'*39, 'g'*40, 'A'*40, None])
def test_checkout_must_be_explicit_full_git_sha(tmp_path, expected):
    fixture = synthetic_artifacts(tmp_path)
    with pytest.raises(ContractMismatch, match='explicit Git'):
        validate_contract(tmp_path, fixture, expected_checkout=expected)


def test_checkout_and_exact_cleanup_are_required(tmp_path):
    fixture = synthetic_artifacts(tmp_path)
    with pytest.raises(TypeError):
        validate_contract(tmp_path, fixture)
    with pytest.raises(ContractMismatch, match='provenance mismatch'):
        validate_contract(tmp_path, fixture, expected_checkout='c'*40)
    (tmp_path/'cleanup.json').write_text(json.dumps({'cleaned':1}))
    with pytest.raises(ContractMismatch, match='cleanup proof'):
        validate_contract(tmp_path, fixture, expected_checkout=CHECKOUT)
    assert validate_contract(tmp_path, fixture, expected_checkout=CHECKOUT, require_cleanup=False)['case'] == 'question_options'


@pytest.mark.parametrize('key', PROVENANCE_HASHES)
def test_every_provenance_binding_is_required(tmp_path, key):
    fixture = synthetic_artifacts(tmp_path)
    provenance = json.loads((tmp_path/'provenance.json').read_text())
    del provenance[key]
    (tmp_path/'provenance.json').write_text(json.dumps(provenance))
    with pytest.raises(ContractMismatch, match=key):
        validate_contract(tmp_path, fixture, expected_checkout=CHECKOUT)


def test_cli_requires_checkout_without_accessing_artifacts(tmp_path):
    import e2e.wire_contract_validator as validator
    result = subprocess.run([sys.executable, validator.__file__, '--artifact-dir', str(tmp_path),
                             '--fixture', str(tmp_path/'fixture.json')], capture_output=True, text=True)
    assert result.returncode == 2
    assert '--expected-checkout' in result.stderr


@pytest.mark.parametrize('key', PROVENANCE_HASHES)
@pytest.mark.parametrize('invalid', ['z'*64, 'B'*64, 10**63])
def test_provenance_digest_requires_lowercase_hex_string(tmp_path, key, invalid):
    fixture = synthetic_artifacts(tmp_path)
    provenance = json.loads((tmp_path/'provenance.json').read_text())
    provenance[key] = invalid
    (tmp_path/'provenance.json').write_text(json.dumps(provenance))
    with pytest.raises(ContractMismatch, match=key):
        validate_contract(tmp_path, fixture, expected_checkout=CHECKOUT)


def test_provenance_accepts_full_lowercase_hex_alphabet(tmp_path):
    fixture = synthetic_artifacts(tmp_path)
    provenance = json.loads((tmp_path/'provenance.json').read_text())
    for key in PROVENANCE_HASHES:
        provenance[key] = '0123456789abcdef'*4
    (tmp_path/'provenance.json').write_text(json.dumps(provenance))
    assert validate_contract(tmp_path, fixture, expected_checkout=CHECKOUT)['case'] == 'question_options'
