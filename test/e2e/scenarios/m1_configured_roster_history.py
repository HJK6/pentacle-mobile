"""Configured owned roster/history reader. Runtime requires separate admission."""
from __future__ import annotations

import asyncio
import json
import ipaddress
import logging
from pathlib import Path
import re
import time
from urllib.parse import urlsplit
import uuid

from ..harness.asserts import Verdict
from ..harness.telemetry_events import parse_telemetry_line
from ..tools import _mock_operator_auth as auth

name = "m1_configured_roster_history"
SCENARIO_META = {"target_compat": {"simulator"}, "requires": ["configured_owned_daemon"]}
CAPABILITIES = dict.fromkeys(("assistant_composite_v1", "work_lanes_v1",
                             "consent_enrollment_offer_v1", "consent_open_v1"), True)
KEYS = {"m1_host", "m1_parent_stream_id", "m1_child_stream_id", "m1_parent_generation",
        "m1_child_generation", "m1_child_name", "m1_expected_rows"}


class ConfiguredError(ValueError):
    """Only fixed, source-owned messages may cross the capture boundary."""


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate input field")
        result[key] = value
    return result


def inputs(config):
    if any(key.startswith("m1_") and key not in KEYS for key in config):
        raise ConfiguredError("unknown configured M1 input")
    for key in ("pentacle_token", "disable_pentacle_auth", "autoaccept_biometric", "actions"):
        if key in config:
            raise ConfiguredError("unsupported configured M1 credential/action input")
    if config.get("runtime_sentinel", "clean") != "clean":
        raise ConfiguredError("configured M1 requires clean runtime mode")
    run_id = config.get("scenario_run_id")
    if not isinstance(run_id, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", run_id):
        raise ConfiguredError("configured M1 requires an explicit run identity")
    values = {}
    for key in KEYS - {"m1_expected_rows", "m1_child_name"}:
        value = config.get(key)
        pattern = r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}"
        if key.endswith("stream_id"):
            pattern += ":" + pattern
        if not isinstance(value, str) or not re.fullmatch(pattern, value):
            raise ConfiguredError("invalid configured M1 " + key)
        values[key] = value
    if (values["m1_parent_stream_id"] == values["m1_child_stream_id"]
            or values["m1_parent_stream_id"].split(":", 1)[0] != values["m1_host"]):
        raise ConfiguredError("configured M1 parent/child/host identity mismatch")
    child_name = config.get("m1_child_name")
    if not isinstance(child_name, str) or not child_name.strip() or len(child_name) > 256 or any(ord(c) < 32 for c in child_name):
        raise ConfiguredError("invalid configured M1 child name")
    values["m1_child_name"] = child_name
    try:
        rows = json.loads(config.get("m1_expected_rows", ""), object_pairs_hook=_unique_object)
        valid = (isinstance(rows, list) and 1 <= len(rows) <= 25
                 and all(isinstance(row, dict) and set(row) == {"row_id", "text"}
                         and isinstance(row["row_id"], str)
                         and re.fullmatch(r"(?:brief|tell|report):[A-Za-z0-9._:-]{1,200}", row["row_id"])
                         and isinstance(row["text"], str) and row["text"].strip()
                         and len(row["text"]) <= 4096 and "\0" not in row["text"] for row in rows)
                 and len({row["row_id"] for row in rows}) == len(rows))
    except (TypeError, ValueError):
        valid = False
    if not valid:
        raise ConfiguredError("configured M1 requires nonempty unique synthetic row ID/text pairs")
    values["rows"] = rows
    endpoint = config.get("PENTACLE_DAEMON_WS_URL", "")
    try:
        parsed = urlsplit(endpoint)
        valid = (isinstance(endpoint, str) and len(endpoint) <= 2048
                 and not any(c.isspace() or ord(c) < 32 for c in endpoint)
                 and parsed.scheme in {"ws", "wss"} and parsed.hostname
                 and re.fullmatch(r"[A-Za-z0-9.:-]+", parsed.hostname)
                 and parsed.port is not None and 1 <= parsed.port <= 65535
                 and parsed.username is None and parsed.password is None
                 and not parsed.query and not parsed.fragment
                 and re.fullmatch(r"/[A-Za-z0-9/_-]*|", parsed.path)
                 and (parsed.scheme == "wss" or parsed.hostname in {"127.0.0.1", "::1"}))
    except (TypeError, ValueError):
        valid = False
    if valid:
        try:
            ipaddress.ip_address(parsed.hostname)
        except ValueError:
            valid = (len(parsed.hostname) <= 253 and all(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
                     for label in parsed.hostname.split(".")))
    if not valid:
        raise ConfiguredError("configured M1 requires explicit wss endpoint or numeric loopback ws endpoint")
    token_file = config.get("daemon_token_file")
    if not isinstance(token_file, str) or not token_file or not Path(token_file).is_absolute() or "\0" in token_file:
        raise ConfiguredError("configured M1 requires an absolute owned 0600 credential file")
    values["ws_url"] = endpoint
    return values


def credential(token):
    try:
        decoded = auth.decode_envelope(token)
        if decoded["client_kind"] != "pentacle-mobile":
            raise ValueError()
        return decoded
    except Exception:
        raise ConfiguredError("configured M1 requires a canonical pentacle-mobile auth-v2 credential") from None


def actions(_config):
    return ["open_existing_chat"]


def params(config):
    value = inputs(config)
    return {"ws_url": value["ws_url"], "host": value["m1_host"],
            "stream_id": value["m1_parent_stream_id"], "openStatus": "1",
            "agentHistory": value["m1_child_stream_id"], "agentHistoryGeneration": value["m1_child_generation"]}


def inventory(value, sessions):
    if not isinstance(sessions, list):
        raise ConfiguredError("configured M1 inventory malformed")
    parents = [row for row in sessions if isinstance(row, dict) and row.get("stream_id") == value["m1_parent_stream_id"]]
    if len(parents) != 1:
        raise ConfiguredError("configured M1 owned parent missing or ambiguous")
    parent = parents[0]
    if (parent.get("host") != value["m1_host"] or parent.get("role") != "nexus"
            or parent.get("session_generation") != value["m1_parent_generation"]):
        raise ConfiguredError("configured M1 parent role/generation mismatch")
    agents = parent.get("agents")
    if not isinstance(agents, list) or len(agents) != 1 or not isinstance(agents[0], dict):
        raise ConfiguredError("configured M1 requires exactly the named owned direct child")
    child = agents[0]
    if any(child.get(field) != value[key] for field, key in (
            ("stream_id", "m1_child_stream_id"), ("session_generation", "m1_child_generation"), ("display_name", "m1_child_name"))):
        raise ConfiguredError("configured M1 direct-child identity/generation mismatch")


def history(value, frame):
    if frame.get("type") != "thread.read.ok" or frame.get("ok") is not True:
        raise ConfiguredError("configured M1 authenticated history refused")
    for key in ("parent_stream_id", "child_stream_id", "parent_generation", "child_generation"):
        if frame.get(key) != value["m1_" + key]:
            raise ConfiguredError("configured M1 history identity/generation mismatch")
    rows = frame.get("rows")
    if (not isinstance(rows, list) or any(not isinstance(row, dict) or row.get("truncated") is not False for row in rows)
            or [{"row_id": row.get("row_id"), "text": row.get("text")} for row in rows] != value["rows"]
            or frame.get("next_cursor") is not None):
        raise ConfiguredError("configured M1 history row ID/text mismatch or incomplete page")
    return {key: frame[key] for key in ("parent_stream_id", "child_stream_id", "parent_generation", "child_generation")}


async def observe(config, token, *, connect=None):
    """Read current pair/history; normal mobile hello also upserts support metadata."""
    value, decoded = inputs(config), credential(token)
    if connect is None:
        from websockets.asyncio.client import connect
    logger = logging.Logger("configured-m1-private-transport")
    logger.disabled = True
    try:
        async with asyncio.timeout(20):
            async with connect(value["ws_url"], open_timeout=5, close_timeout=3,
                               max_size=1048576, logger=logger, proxy=None, compression=None) as ws:
                welcome = json.loads(await ws.recv())
                operator = welcome["auth"]["operator"]
                if (welcome.get("type") != "welcome" or operator.get("protocol_version") != 2
                        or operator.get("scheme") != auth.AUTH_SCHEME
                        or not isinstance(operator.get("expires_at"), (int, float))
                        or not time.time() < operator["expires_at"] <= time.time() + 300):
                    raise ConfiguredError("configured M1 auth challenge invalid")
                auth.decode_b64url(operator.get("nonce"), expected_bytes=32)
                await ws.send(json.dumps({"type": "hello", "client": "pentacle-mobile", "capabilities": CAPABILITIES,
                    "auth_v2": {"scheme": auth.AUTH_SCHEME, "credential_id": decoded["credential_id"],
                                "proof": auth.make_proof(decoded["proof_key"], operator["nonce"], decoded["credential_id"], "pentacle-mobile")},
                    "subscribe": {"snapshot": True, "events_mode": "summary", "include_subagents": False}}))
                admitted = False
                for _ in range(64):
                    frame = json.loads(await ws.recv())
                    if not isinstance(frame, dict) or str(frame.get("type", "")).endswith(".error"):
                        raise ConfiguredError("configured M1 observer authorization/protocol refused")
                    if frame.get("type") in {"hello", "ready"}:
                        admitted = True
                    if frame.get("type") in {"snapshot", "session.inventory"}:
                        if not admitted:
                            raise ConfiguredError("configured M1 inventory preceded authenticated hello")
                        inventory(value, frame.get("sessions"))
                        break
                else:
                    raise ConfiguredError("configured M1 owned inventory missing")
                request_id = "thread-read-" + str(uuid.uuid4())
                await ws.send(json.dumps({"type": "thread.read", "request_id": request_id,
                                         "parent_stream_id": value["m1_parent_stream_id"],
                                         "child_stream_id": value["m1_child_stream_id"], "limit": 25}))
                for _ in range(64):
                    frame = json.loads(await ws.recv())
                    if not isinstance(frame, dict) or frame.get("type") in {"hello.error", "auth.error", "protocol.error"}:
                        raise ConfiguredError("configured M1 observer authorization/protocol refused")
                    if frame.get("request_id") == request_id:
                        return history(value, frame)
                raise ConfiguredError("configured M1 authenticated history missing")
    except ConfiguredError:
        raise
    except Exception:
        raise ConfiguredError("configured M1 observer transport/challenge/cleanup failed") from None


def filtered_line(line, config):
    """Keep only owned, projected evidence; no raw native transcript or AX dump."""
    try:
        envelope = json.loads(line)
        pid = envelope.get("processID")
        if type(pid) is not int or pid <= 0:
            return None
        event = parse_telemetry_line(envelope.get("eventMessage", ""))
        if not event:
            return None
        data, value = event.data, inputs(config)
        if event.message == "harness:harness_armed":
            if data.get("scenario_run_id") != config["scenario_run_id"] or data.get("scenario") != name:
                return None
            keep = {key: data[key] for key in ("scenario", "scenario_run_id")}
        elif event.message == "harness:runtime_error":
            if data.get("scenario_run_id") != config["scenario_run_id"]:
                return None
            keep = {"scenario_run_id": config["scenario_run_id"]}
        elif event.message == "harness:ui_trace":
            kind = data.get("kind")
            if kind == "store_state_transition":
                keep = {key: data.get(key) if isinstance(data.get(key), bool) else None for key in ("connected", "connecting", "has_hydrated")}
            elif kind == "nexus_agents_roster_rendered":
                matched = (data.get("child_stream_ids") == [value["m1_child_stream_id"]]
                           and data.get("child_names") == [value["m1_child_name"]])
                keep = {"identity_matches": matched}
                if matched:
                    keep.update({key: data[key] for key in ("child_stream_ids", "child_names")})
            elif kind == "nexus_agents_history_rendered":
                matched = (data.get("parent_stream_id") == value["m1_parent_stream_id"]
                           and data.get("child_stream_id") == value["m1_child_stream_id"]
                           and data.get("row_ids") == [row["row_id"] for row in value["rows"]]
                           and data.get("row_texts") == [row["text"] for row in value["rows"]])
                keep = {"identity_matches": matched}
                if matched:
                    keep.update({key: data[key] for key in ("parent_stream_id", "child_stream_id", "row_ids", "row_texts")})
            else:
                return None
            keep["kind"] = kind
            if "scenario_run_id" in data:
                keep["scenario_run_id"] = data["scenario_run_id"] if data["scenario_run_id"] == config["scenario_run_id"] else "foreign"
        else:
            return None
        return json.dumps({"processID": envelope.get("processID"), "eventMessage": "[TELEMETRY] " + json.dumps({
            "message": event.message, "data": keep})}) + "\n"
    except (TypeError, ValueError, AttributeError):
        return None


class Scenario:
    def __init__(self, token, before):
        self.token, self.before = token, before

    actions = staticmethod(actions)
    params = staticmethod(params)

    def run(self, config, stream, cap=None):
        deadline = time.monotonic() + 25
        value = inputs(config)
        while time.monotonic() < deadline:
            events = [event for event in stream.all_events()
                      if event.native_pid == config["_native_launch_pid"] and event.received_at >= config["_native_armed_at"]
                      and event.data.get("scenario_run_id", config["scenario_run_id"]) == config["scenario_run_id"]]
            if any(event.message == "harness:runtime_error" for event in events):
                raise ConfiguredError("configured M1 native runtime error")
            transitions = [event for event in events if event.data.get("kind") == "store_state_transition"]
            current = transitions[-1].data if transitions else {}
            hydrated = current.get("connected") is True and current.get("connecting") is False and current.get("has_hydrated") is True
            roster = [event for event in events if event.data.get("kind") == "nexus_agents_roster_rendered"]
            histories = [event for event in events if event.data.get("kind") == "nexus_agents_history_rendered"]
            if hydrated and roster and histories and roster[-1].data.get("identity_matches") is True and histories[-1].data.get("identity_matches") is True:
                after = asyncio.run(observe(config, self.token))
                if after != self.before:
                    raise ConfiguredError("configured M1 pair/generation changed during UI journey")
                if cap:
                    cap.screenshot(name)
                return Verdict(name, "PASS", extras={"owned_pair_before": self.before, "owned_pair_after": after,
                    "roster": dict(roster[-1].data), "history": dict(histories[-1].data),
                    "rendered_rows": value["rows"], "child_name": value["m1_child_name"],
                    "ui_pid": config["_native_launch_pid"], "post_arming": True,
                    "hello_capability_metadata_upsert": True}).finish()
            time.sleep(.1)
        return Verdict(name, "FAIL", error="configured M1 hydration or rendered roster/history identity/content mismatch",
                       extras={"owned_pair_before": self.before}).finish()
