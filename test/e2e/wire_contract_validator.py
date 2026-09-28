#!/usr/bin/env python3
"""Fail-closed validator for server-emitted mobile contract artifacts."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
from pathlib import Path
from typing import Any



class ContractMismatch(RuntimeError):
    pass


def _validate_allow_custom(payload: dict[str, Any], expected_custom: bool, source: str) -> None:
    if expected_custom and payload.get("allow_custom") is not True:
        raise ContractMismatch(f"{source} allow_custom contract mismatch")
    if not expected_custom and "allow_custom" in payload:
        raise ContractMismatch(f"{source} allow_custom must be absent")


def _read(path: Path, expected: type) -> Any:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        raise ContractMismatch(f"required artifact unavailable: {path.name}: {exc.__class__.__name__}") from exc
    if not isinstance(value, expected):
        raise ContractMismatch(f"required artifact has wrong shape: {path.name}")
    return value


def _parsed(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [row["parsed"] for row in rows if isinstance(row, dict) and isinstance(row.get("parsed"), dict)]


def _one(rows: list[dict[str, Any]], predicate: Any, label: str) -> dict[str, Any]:
    matches = [row for row in rows if predicate(row)]
    if len(matches) != 1:
        raise ContractMismatch(f"expected exactly one {label}, found {len(matches)}")
    return matches[0]


def _validate_mobile_live(
    responses: list[dict[str, Any]],
    emissions: list[dict[str, Any]],
    attempts: list[dict[str, Any]],
    sends: list[dict[str, Any]],
) -> dict[str, Any]:
    tool = _one(
        responses,
        lambda frame: frame.get("type") == "chat.event" and (frame.get("event") or {}).get("daemon_seq") == 10,
        "production-shaped tool summary",
    ).get("event") or {}
    if (
        tool.get("kind") != "TOOL_BATCH_SUMMARY"
        or tool.get("text") != "Ran 2 shell commands"
        or tool.get("raw") != {
            "source": "claude-jsonl",
            "subtype": "tool-batch-summary",
            "span_size": 2,
            "tool_breakdown": {"Bash": 2},
            "tool_use_ids": ["toolu_1", "toolu_2"],
        }
    ):
        raise ContractMismatch("mobile tool-summary payload contract mismatch")
    expected_sequences = [10, 11, *range(100, 120), *range(200, 210), 300]
    if [row.get("daemon_seq") for row in emissions] != expected_sequences:
        raise ContractMismatch("mobile latency emission matrix mismatch")
    attempt_texts = [row.get("text") for row in attempts]
    if attempt_texts != [
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
    ]:
        raise ContractMismatch("mobile send-attempt matrix mismatch")
    send_texts = [row.get("text") for row in sends]
    if send_texts != [
        "Definitive pre-land failure",
        "Landed once with result delivered",
        "Landed once while result was lost",
        "Drop after send without ack",
        "Duplicate delivery probe",
    ]:
        raise ContractMismatch("mobile landed side-effect matrix mismatch")
    return {"emission_count": len(emissions), "attempt_count": len(attempts), "side_effect_count": len(sends)}


def _validate_provenance(root: Path, expected_checkout: str, require_cleanup: bool) -> dict[str, Any]:
    if not isinstance(expected_checkout, str) or not re.fullmatch(r"[0-9a-f]{40}", expected_checkout):
        raise ContractMismatch("expected checkout must be an explicit Git commit SHA")
    provenance = _read(root / "provenance.json", dict)
    if provenance.get("checkout_commit") != expected_checkout:
        raise ContractMismatch("server checkout provenance mismatch")
    for key in (
        "loaded_chat_streamd_sha256",
        "loaded_spawn_profiles_sha256",
        "loaded_daemon_init_code_sha256",
        "loaded_handle_client_code_sha256",
        "loaded_validate_v2_code_sha256",
        "loaded_spawn_catalog_code_sha256",
    ):
        digest = provenance.get(key)
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ContractMismatch(f"invalid live production binding: {key}")
    if require_cleanup:
        cleanup = _read(root / "cleanup.json", dict)
        if cleanup.get("cleaned") is not True:
            raise ContractMismatch("server-owned runner cleanup proof is not green")
    return provenance


def validate_contract(
    artifact_dir: Path,
    fixture_path: Path,
    *,
    expected_checkout: str,
    require_cleanup: bool = True,
    responses_override: Path | None = None,
) -> dict[str, Any]:
    root = artifact_dir.resolve()
    fixture = _read(fixture_path, dict)
    if fixture.get("schema_version") != 1:
        raise ContractMismatch("semantic fixture schema_version mismatch")
    provenance = _validate_provenance(root, expected_checkout, require_cleanup)
    requests = _parsed(_read(root / "requests.json", list))
    responses_path = responses_override or root / "responses.json"
    responses = _parsed(_read(responses_path, list)) if responses_override is None else _read(responses_path, list)
    case = str(fixture.get("case") or "")
    result: dict[str, Any] = {
        "case": case,
        "server_checkout": provenance["checkout_commit"],
        "fixture_sha256": hashlib.sha256(fixture_path.read_bytes()).hexdigest(),
    }
    if case.startswith("question_"):
        expected_seed_count = 2 if case == "question_send_recovery" and fixture["fault"].get("requires_restart") is True else 1
        asks = [
            frame for frame in responses
            if frame.get("type") == "prompt.ask.ok" and frame.get("request_id") == f"seed-{case}"
        ]
        if len(asks) != expected_seed_count:
            raise ContractMismatch(
                f"expected {expected_seed_count} server-generated prompt.ask.ok frame(s), found {len(asks)}"
            )
        ask = asks[-1]
        envelope = (ask.get("question") or {}).get("envelope") or {}
        expected_options = fixture["question"]["options"]
        if envelope.get("options") != expected_options:
            raise ContractMismatch("server-generated option label/value/order mismatch")
        notifications = [
            frame for frame in responses
            if frame.get("type") == "notification" and (frame.get("notification") or {}).get("state") == "open"
        ]
        if len(notifications) != expected_seed_count:
            raise ContractMismatch(
                f"expected {expected_seed_count} open server notification(s), found {len(notifications)}"
            )
        notification = notifications[-1]
        notification_question = (notification.get("notification") or {}).get("question") or {}
        if notification_question.get("options") != expected_options:
            raise ContractMismatch("notification option label/value/order mismatch")
        expected_custom = fixture["question"].get("allow_custom") is True
        _validate_allow_custom(envelope, expected_custom, "server-generated")
        _validate_allow_custom(notification_question, expected_custom, "notification")
        resolution = _one(requests, lambda frame: frame.get("type") == "notification.resolve", "mobile notification.resolve")
        answer = fixture["answer"]
        if case == "question_custom":
            forbidden = {"action_id", "selection", "selections", "note"}
            if resolution.get("custom_text") != answer["custom_text"] or forbidden.intersection(resolution):
                raise ContractMismatch("custom answer request is not custom_text-only")
        else:
            if resolution.get("selections") != [answer["expected_selection"]] or "custom_text" in resolution:
                raise ContractMismatch("option answer request contract mismatch")
        if case == "question_send_recovery":
            fault = fixture["fault"]
            controls = _read(root / "mobile-live-control-acks.json", list)
            arm = _one(
                controls,
                lambda row: row.get("action") == "arm_next_question",
                "question fault control acknowledgement",
            )
            if arm.get("mode") != fault["mode"]:
                raise ContractMismatch("question fault mode differs from the named cut")
            recorders = _read(root / "recorders.json", dict)
            answers = recorders.get("question_answers") or []
            if len(answers) != fault["expected_side_effects"]:
                raise ContractMismatch("question provider side-effect count mismatch")
            _one(
                responses,
                lambda frame: frame.get("type") == fault["response_type"],
                "question recovery response",
            )
            restart_path = root / "mobile-live-restarts.json"
            if fault.get("requires_restart") is True:
                restart = _one(_read(restart_path, list), lambda row: row.get("restarted") is True, "daemon restart evidence")
                if restart.get("old_daemon_identity") == restart.get("new_daemon_identity"):
                    raise ContractMismatch("daemon restart reused the production daemon instance")
            elif restart_path.exists():
                raise ContractMismatch("unexpected daemon restart evidence")
            result.update({"fault_mode": arm.get("mode"), "side_effect_count": len(answers)})
            return result
        if case == "question_rollback":
            _one(responses, lambda frame: frame.get("type") == "notification.error", "server rejection")
        else:
            _one(responses, lambda frame: frame.get("type") == "notification.resolve.ok", "server answer acceptance")
        result["request_id"] = resolution.get("request_id")
        return result
    if case == "mobile_live_defects":
        result.update(_validate_mobile_live(
            responses,
            _read(root / "mobile-live-emissions.json", list),
            _read(root / "mobile-live-send-attempts.json", list),
            _read(root / "mobile-live-sends.json", list),
        ))
        return result
    if case in {"stale_feed_state_clobber", "null_corr_tail_freeze"}:
        controls = _read(root / "mobile-live-control-acks.json", list)
        _one(
            controls,
            lambda row: row.get("action") == "arm_stale_current_tail",
            "stale current-tail control acknowledgement",
        )
        expected = fixture["older_tail"] if case == "stale_feed_state_clobber" else fixture["current_tail"]
        response = _one(
            responses,
            lambda frame: frame.get("type") == "request_stream_events.ok"
            and [event.get("daemon_seq") for event in frame.get("events") or []]
            == [event.get("daemon_seq") for event in expected],
            "server-emitted current-tail response",
        )
        evidence = _one(
            _read(root / "stale-current-tail-responses.json", list),
            lambda row: row.get("stream_id") == response.get("stream_id")
            and row.get("daemon_seqs") == [event.get("daemon_seq") for event in expected],
            "current-tail response evidence",
        )
        result.update({"delayed_daemon_seqs": evidence["daemon_seqs"]})
        return result
    if case != "spawn_controls":
        raise ContractMismatch(f"unsupported semantic fixture case: {case}")
    expected = fixture["spawn"]
    catalogs = [frame for frame in responses if frame.get("type") == "spawn_catalog_get.ok"]
    if not catalogs:
        raise ContractMismatch("server-generated spawn catalog missing")
    catalog = catalogs[-1]
    provider_models = (catalog.get("models") or {}).get(expected["provider"]) or {}
    model = provider_models.get(expected["model"]) or {}
    if expected["effort"] not in (model.get("efforts") or []):
        raise ContractMismatch("selected model/effort is absent from the emitted catalog")
    spawn = _one(
        requests,
        lambda frame: frame.get("type") == "spawn" and frame.get("schema") == "SpawnRequestV2",
        "mobile SpawnRequestV2",
    )
    expected_fields = {
        "host": expected["host"],
        "provider": expected["provider"],
        "schema": "SpawnRequestV2",
        "model": expected["model"],
        "effort": expected["effort"],
        "spawn_profile": expected["spawn_profile"],
        "catalog_version": catalog["catalog_version"],
        "resolution_source": expected["resolution_source"],
    }
    if any(spawn.get(key) != value for key, value in expected_fields.items()):
        raise ContractMismatch("mobile SpawnRequestV2 tuple differs from catalog-backed selection")
    response = _one(
        responses,
        lambda frame: frame.get("type") == "spawn.ok" and frame.get("request_id") == spawn.get("request_id"),
        "server spawn.ok",
    )
    session = response.get("session") if isinstance(response.get("session"), dict) else {}
    expected_tuple = {key: expected[key] for key in ("provider", "model", "effort")}
    for key in ("requested_launch_tuple", "resolved_launch_tuple", "actual_launch_tuple"):
        if session.get(key) != expected_tuple:
            raise ContractMismatch(f"server {key} differs from selected tuple")
    result["catalog_version"] = catalog["catalog_version"]
    result["request_id"] = spawn.get("request_id")
    return result


def mutation_proof(
    artifact_dir: Path,
    fixture_path: Path,
    output: Path,
    mutation_kind: str = "auto",
    *,
    expected_checkout: str,
) -> dict[str, Any]:
    control = validate_contract(artifact_dir, fixture_path, expected_checkout=expected_checkout)
    responses = _parsed(_read(artifact_dir / "responses.json", list))
    mutated = copy.deepcopy(responses)
    case = str(control.get("case") or "")
    if case == "spawn_controls":
        catalog = next((frame for frame in reversed(mutated) if frame.get("type") == "spawn_catalog_get.ok"), None)
        if catalog is None:
            raise ContractMismatch("mutation proof requires a server-emitted spawn catalog")
        catalog["catalog_version"] = "test-only-incompatible"
        mutation = "spawn_catalog_get.ok.catalog_version"
    elif case.startswith("question_"):
        ask = next((frame for frame in mutated if frame.get("type") == "prompt.ask.ok"), None)
        envelope = ((ask or {}).get("question") or {}).get("envelope") or {}
        if mutation_kind == "allow_custom_presence":
            if "allow_custom" in envelope:
                raise ContractMismatch("allow_custom presence mutation requires an absent control key")
            envelope["allow_custom"] = False
            mutation = "prompt.ask.ok.question.envelope.allow_custom=explicit_false"
        else:
            options = envelope.get("options") or []
            if not options:
                raise ContractMismatch("mutation proof requires server-emitted question options")
            options[0]["label"] = "test-only-incompatible"
            mutation = "prompt.ask.ok.question.envelope.options[0].label"
    else:
        raise ContractMismatch("mutation proof requires a supported contract case")
    output.parent.mkdir(parents=True, exist_ok=True)
    mutated_path = output.with_suffix(".mutated-responses.json")
    mutated_path.write_text(json.dumps(mutated, indent=2) + "\n", encoding="utf-8")
    rejected = False
    rejection = ""
    try:
        validate_contract(artifact_dir, fixture_path, expected_checkout=expected_checkout, responses_override=mutated_path)
    except ContractMismatch as exc:
        rejected = True
        rejection = str(exc)
    proof = {
        "status": "passed" if rejected else "failed",
        "control": control,
        "mutation": mutation,
        "mutated_copy": str(mutated_path),
        "validator_rejected": rejected,
        "rejection": rejection,
    }
    output.write_text(json.dumps(proof, indent=2) + "\n", encoding="utf-8")
    if not rejected:
        raise ContractMismatch("mutated schema copy did not make the unchanged validator red")
    return proof


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--expected-checkout", required=True)
    parser.add_argument("--allow-live", action="store_true")
    parser.add_argument("--mutation-proof-out", type=Path)
    parser.add_argument("--mutation-kind", choices=("auto", "allow_custom_presence"), default="auto")
    args = parser.parse_args()
    if args.mutation_proof_out:
        result = mutation_proof(args.artifact_dir, args.fixture, args.mutation_proof_out, args.mutation_kind, expected_checkout=args.expected_checkout)
    else:
        result = validate_contract(args.artifact_dir, args.fixture, expected_checkout=args.expected_checkout, require_cleanup=not args.allow_live)
    print(f"PASS {result.get('case') or result.get('mutation')}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ContractMismatch as exc:
        print(f"FAIL {exc}")
        raise SystemExit(1)
