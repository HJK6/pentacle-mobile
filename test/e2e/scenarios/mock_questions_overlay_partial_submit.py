"""P4 Questions overlay: three open durable questions (Bart + two sessions on different hosts),
answer one, Submit 1 of 3, and assert exactly one prompt.answer plus the deck shrinking to two.

The overlay is opened with the app's own deep link (`pentacle://pentacle/questions`); P3's `?`
entry is not required. Every UI read and tap goes through the accessibility tree by testID
(see docs/QUESTIONS_OVERLAY.md), and the single prompt.answer is read from the existing
`harness:ui_trace` kind `prompt_answer_dispatched`.
"""
from __future__ import annotations

import json
import re
import subprocess
import time

SCENARIO_META = {"target_compat": {"simulator"}, "requires": []}

from . import _mock_chat_streamd as M
from ..harness.asserts import DEFAULT_DENY_LIST, EventSpec, Verdict, assert_no_events, await_event

name = "mock_questions_overlay_partial_submit"
DEEP_LINK = "pentacle://pentacle/questions"
# prompt marker -> (question_id, is_bart)
QUESTIONS = {
    "Q-MOCK": ("q-overlay-mock", False),
    "Q-SECOND": ("q-overlay-second", False),
    "Q-BART": ("q-overlay-bart", True),
}


def actions(_config: dict) -> list[str]:
    return ["autoaccept_biometric", "open_existing_chat"]


def params(config: dict) -> dict[str, str]:
    base = M.params_for_fixture(config, "questions_overlay_partial_submit.json")
    base["pre_open_wait_ms"] = "3000"
    return base


def preflight(config: dict, repo_root=None) -> str | None:
    return M.preflight(config, repo_root)


def _idb(udid: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["idb", "ui", *args, "--udid", udid], capture_output=True, text=True, timeout=20, check=False)


def _elements(udid: str) -> list[dict]:
    result = _idb(udid, "describe-all", "--json")
    try:
        decoded = json.loads(result.stdout)
        return decoded if isinstance(decoded, list) else decoded.get("elements", [])
    except ValueError:
        try:
            return [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
        except ValueError:
            return []


def _text_fallback(elements: list[dict], test_id: str) -> dict | None:
    # RN iOS does not expose a Text's testID as AXUniqueId; match the visible text instead.
    texts = [e for e in elements if e.get("type") == "StaticText"]
    label = lambda e: str(e.get("AXLabel") or "")
    counter = next((e for e in texts if re.fullmatch(r"QUESTION \d+ / \d+", label(e))), None)
    if test_id == "questions-counter":
        return counter
    if test_id == "questions-subtitle" and counter:
        cf = counter.get("frame") or {}
        return next((e for e in texts if e is not counter and abs((e.get("frame") or {}).get("y", -999) - (cf.get("y", 0) + cf.get("height", 0))) < 24
                     and (e.get("frame") or {}).get("y", 0) < 140), None)
    if test_id == "questions-prompt":
        return next((e for e in texts if any(marker in label(e) for marker in QUESTIONS)), None)
    if test_id == "questions-toast":
        return next((e for e in texts if label(e).startswith("Sent ")), None)
    if test_id == "questions-submit-label":
        submit = next((e for e in elements if e.get("AXUniqueId") == "questions-submit"), None)
        return submit
    return None


def _find(elements: list[dict], test_id: str) -> dict | None:
    for key in ("AXUniqueId", "AXIdentifier"):
        for element in elements:
            if element.get(key) == test_id:
                return element
    return _text_fallback(elements, test_id)


def _await_element(udid: str, test_id: str, timeout_s: float = 10.0) -> dict | None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        found = _find(_elements(udid), test_id)
        if found:
            return found
        time.sleep(0.3)
    return None


def _label(udid: str, test_id: str, timeout_s: float = 10.0) -> str | None:
    element = _await_element(udid, test_id, timeout_s)
    return str(element.get("AXLabel") or "") if element else None


def _tap(udid: str, test_id: str) -> str | None:
    element = _await_element(udid, test_id)
    frame = element.get("frame") if element else None
    if not isinstance(frame, dict):
        return f"{test_id} is not on screen"
    x = int(frame["x"] + frame["width"] / 2)
    y = int(frame["y"] + frame["height"] / 2)
    result = _idb(udid, "tap", str(x), str(y))
    return None if result.returncode == 0 else (result.stderr or f"tap {test_id} failed").strip()


def _open_overlay(udid: str) -> str | None:
    result = subprocess.run(["xcrun", "simctl", "openurl", udid, DEEP_LINK], capture_output=True, text=True, timeout=20, check=False)
    if result.returncode:
        return (result.stderr or "simctl openurl failed").strip()
    # iOS may ask to confirm opening a custom scheme; accept it when the sheet appears.
    deadline = time.monotonic() + 6
    while time.monotonic() < deadline:
        elements = _elements(udid)
        if _find(elements, "questions-counter"):
            return None
        for element in elements:
            if str(element.get("AXLabel") or "") == "Open" and element.get("type") == "Button":
                frame = element.get("frame") or {}
                _idb(udid, "tap", str(int(frame["x"] + frame["width"] / 2)), str(int(frame["y"] + frame["height"] / 2)))
        time.sleep(0.4)
    return None if _await_element(udid, "questions-counter", 6) else "questions overlay did not open from the deep link"


def run(config: dict, stream, cap=None) -> Verdict:
    early = M.await_mock_session_open(stream, name=name)
    if early:
        return early
    failures: list[str] = []
    udid = str(config.get("PENTACLE_TARGET_UDID") or config["SIMULATOR_UDID"])

    applied = [
        await_event(stream, EventSpec("notification:frame_applied", where={"producer": "agent_question.v1", "state": "open"}, timeout_s=25))
    ]
    last = applied[0]
    for _ in range(2):
        last = await_event(
            stream,
            EventSpec("notification:frame_applied", where={"producer": "agent_question.v1", "state": "open"}, timeout_s=25),
            not_before=last.received_at if last else None,
        )
        applied.append(last)
    if not all(applied):
        return Verdict(name=name, verdict="FAIL", error="the three durable questions did not all apply").finish()

    error = _open_overlay(udid)
    if error:
        return Verdict(name=name, verdict="FAIL", error=error).finish()
    if cap:
        cap.screenshot(f"{name}_open")

    # Page through the deck: counter text, subtitle, and See chat visibility per source.
    pages: list[dict] = []
    for index in range(3):
        counter = _label(udid, "questions-counter")
        subtitle = _label(udid, "questions-subtitle")
        prompt = _label(udid, "questions-prompt") or ""
        marker = next((key for key in QUESTIONS if key in prompt), None)
        see_chat = _find(_elements(udid), "questions-see-chat") is not None
        pages.append({"counter": counter, "subtitle": subtitle, "marker": marker, "see_chat": see_chat})
        if counter != f"QUESTION {index + 1} / 3":
            failures.append(f"page {index + 1} counter was {counter!r}")
        if marker is None:
            failures.append(f"page {index + 1} prompt did not name a known question: {prompt!r}")
        elif QUESTIONS[marker][1]:
            if subtitle != "Bart":
                failures.append(f"Bart page subtitle was {subtitle!r}")
            if see_chat:
                failures.append("See chat is visible on the Bart page")
        else:
            if not subtitle or " · " not in subtitle:
                failures.append(f"session page subtitle was {subtitle!r}")
            if not see_chat:
                failures.append("See chat is missing on a session page")
        if index < 2 and (tap_error := _tap(udid, "questions-next")):
            failures.append(tap_error)
    if sorted(page["marker"] or "" for page in pages) != sorted(QUESTIONS):
        failures.append(f"the deck did not list each question exactly once: {[p['marker'] for p in pages]}")

    # Answer page 1 only: go back to the first page, pick an option, Submit 1 of 3.
    for _ in range(2):
        if tap_error := _tap(udid, "questions-back"):
            failures.append(tap_error)
    first_marker = pages[0]["marker"]
    if tap_error := _tap(udid, "questions-option-1"):
        failures.append(tap_error)
    submit_label = _label(udid, "questions-submit-label")
    if submit_label != "Submit 1 of 3":
        failures.append(f"submit label was {submit_label!r}")
    sent_after = time.monotonic()
    if tap_error := _tap(udid, "questions-submit"):
        failures.append(tap_error)

    dispatched = await_event(
        stream,
        EventSpec("harness:ui_trace", where={"kind": "prompt_answer_dispatched"}, timeout_s=20),
        not_before=sent_after - 1,
    )
    expected_id = QUESTIONS[first_marker][0] if first_marker in QUESTIONS else None
    if not dispatched:
        failures.append("no prompt.answer was dispatched")
    elif dispatched.data.get("question_id") != expected_id:
        failures.append(f"prompt.answer question_id was {dispatched.data.get('question_id')!r}, expected {expected_id!r}")

    toast = _label(udid, "questions-toast", timeout_s=8)
    if toast != "Sent 1 answer · 2 left":
        failures.append(f"toast was {toast!r}")
    counter_after = _label(udid, "questions-counter")
    if counter_after != "QUESTION 1 / 2":
        failures.append(f"counter after submit was {counter_after!r}")
    if cap:
        cap.screenshot(f"{name}_after_submit")

    extra = await_event(
        stream,
        EventSpec("harness:ui_trace", where={"kind": "prompt_answer_dispatched"}, timeout_s=3),
        not_before=(dispatched.received_at + 0.001) if dispatched else None,
    )
    if extra:
        failures.append(f"more than one prompt.answer was dispatched ({extra.data.get('question_id')!r})")

    verdict = Verdict(
        name=name,
        verdict="FAIL" if failures else "PASS",
        error="; ".join(failures) if failures else None,
        extras={"pages": pages, "answered_marker": first_marker, "prompt_answer": dict(dispatched.data) if dispatched else None, "toast": toast},
    )
    verdict.fold_negative_watch(assert_no_events(stream, names=list(DEFAULT_DENY_LIST), window_s=3))
    return verdict.finish()
