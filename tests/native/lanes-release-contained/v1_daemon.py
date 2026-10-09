"""Run A identity and v1-wire oracle for `lanes-release-contained`.

Run A is a REAL chat-stream-v2 daemon at the last public main commit before the
increment-1 merge. It negotiates `work_lanes_v1`, pushes `work_lanes.inventory`
and answers `work_lanes.show`, but carries none of the increment-1 fields. This
module states those facts as executable checks; it starts nothing itself
(scratch_daemon.py owns processes) and imports no daemon code.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from scratch_daemon import PIN_INC1, PIN_V1, PIN_V1_TREE, INC1_TREE

# Increment-1 lane keys (spec § Current State). None may appear on the v1 wire.
INC1_LANE_KEYS = frozenset({
    "members", "members_total", "items_total", "items_open", "items_completed", "items_dropped",
    "items_unresolved", "ac_checked", "ac_total", "ac_members", "open_estimate_h", "open_estimated",
    "estimate_complete", "no_spec_reason", "freshness_at",
})
# Deferred keys that must not appear on either wire (ruling inc1-wire-boundary).
# (`lead.status_card.eta_at` is an existing v1 lead field, not a lane ETA.)
DEFERRED_KEYS = frozenset({"completion_pending", "lead_reported_done", "stale", "eta", "remaining",
                           "waiting_on_you"})
SHOW_KEYS_V1 = frozenset({"lane", "projection", "events", "updates"})


def source_facts(checkout: Path) -> dict[str, Any]:
    """Static source facts of the pinned v1 checkout (checked again at admission)."""
    service = checkout / "services/chat-stream-v2"
    server = (service / "server.py").read_text(encoding="utf-8")
    main = (service / "main.py").read_text(encoding="utf-8")
    facts = {
        "show_verb": '"work_lanes.show": self._on_work_lanes_show' in server,
        "work_lanes_v1_negotiation": "_client_wants_work_lanes" in server,
        "inventory_emitter": "WorkLanesInventory(" in main,
        "no_member_progress_module": not (service / "work_lane_progress.py").exists(),
        "no_work_index_store": not (service / "store_work_index.py").exists(),
    }
    missing = [name for name, ok in facts.items() if not ok]
    if missing:
        raise ValueError("v1 checkout does not match the v1 lanes daemon: " + ", ".join(missing))
    return facts


def _keys(value: Any) -> set[str]:
    found: set[str] = set()
    if isinstance(value, dict):
        for key, item in value.items():
            found.add(str(key))
            found |= _keys(item)
    elif isinstance(value, list):
        for item in value:
            found |= _keys(item)
    return found


def check_v1_inventory(frame: dict[str, Any] | None, expected_lane_ids: list[str]) -> list[str]:
    """Violations of the v1 inventory contract (empty list = pass)."""
    if not isinstance(frame, dict) or frame.get("type") != "work_lanes.inventory":
        return ["no work_lanes.inventory frame"]
    problems = []
    lanes = frame.get("lanes") if isinstance(frame.get("lanes"), list) else []
    ids = [lane.get("lane_id") for lane in lanes if isinstance(lane, dict)]
    if sorted(ids) != sorted(expected_lane_ids):
        problems.append(f"lane ids {ids} != seeded {expected_lane_ids}")
    for lane in lanes:
        leaked = sorted(set(lane) & INC1_LANE_KEYS)
        if leaked:
            problems.append(f"{lane.get('lane_id')}: increment-1 keys on the v1 wire {leaked}")
    if "work_index" in frame:
        problems.append("work_index present on the v1 wire")
    deferred = sorted(_keys(frame) & DEFERRED_KEYS)
    if deferred:
        problems.append(f"deferred keys present {deferred}")
    return problems


def check_v1_show(reply: dict[str, Any] | None, lane_id: str) -> list[str]:
    if not isinstance(reply, dict) or reply.get("type") != "work_lanes.show.ok":
        return [f"no work_lanes.show.ok for {lane_id} (got {reply.get('type') if isinstance(reply, dict) else None})"]
    problems = []
    missing = sorted(SHOW_KEYS_V1 - set(reply))
    if missing:
        problems.append(f"show reply lacks {missing}")
    if "members" in reply or "work_index" in reply:
        problems.append("show reply carries increment-1 members/work_index on the v1 daemon")
    lane = reply.get("lane") if isinstance(reply.get("lane"), dict) else {}
    if lane.get("lane_id") != lane_id:
        problems.append("show reply names another lane")
    return problems


def check_inc1_inventory(frame: dict[str, Any] | None, expected_lane_ids: list[str],
                         big_lane_id: str) -> list[str]:
    """Increment-1 inventory after the upgrade: all lanes, inline 8 + members_total, work_index."""
    if not isinstance(frame, dict) or frame.get("type") != "work_lanes.inventory":
        return ["no work_lanes.inventory frame"]
    problems = []
    lanes = {lane.get("lane_id"): lane for lane in frame.get("lanes", []) if isinstance(lane, dict)}
    if sorted(lanes) != sorted(expected_lane_ids):
        problems.append(f"lane ids {sorted(lanes)} != seeded {sorted(expected_lane_ids)}")
    big = lanes.get(big_lane_id) or {}
    if big.get("members_total") != 32 or len(big.get("members") or []) != 8:
        problems.append("big lane is not inline 8 of members_total 32")
    if not isinstance(frame.get("work_index"), dict):
        problems.append("work_index absent on the increment-1 wire")
    deferred = sorted(_keys(frame) & DEFERRED_KEYS)
    if deferred:
        problems.append(f"deferred keys present {deferred}")
    return problems


def check_inc1_show(reply: dict[str, Any] | None, lane_id: str, members: list[str]) -> list[str]:
    if not isinstance(reply, dict) or reply.get("type") != "work_lanes.show.ok":
        return ["no work_lanes.show.ok"]
    got = [member.get("spec_id") for member in reply.get("members") or []]
    problems = [] if got == members else [f"show members {len(got)} not in seeded membership order"]
    if (reply.get("lane") or {}).get("lane_id") != lane_id:
        problems.append("show reply names another lane")
    return problems


PINS = {"v1": {"commit": PIN_V1, "tree": PIN_V1_TREE}, "inc1": {"commit": PIN_INC1, "tree": INC1_TREE}}
