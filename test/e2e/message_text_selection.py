#!/usr/bin/env python3
"""Focused offline UIKit selection journey; borrows an admitted booted allocation.

This never allocates, boots, resets or reaps a simulator/companion. The storage
owner supplies its existing direct-input context and releases it after this exits.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import http.server
import threading
import plistlib
import stat
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]

SWIFT_VISION = r"""
import Foundation
import Vision
import CoreGraphics
import ImageIO
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let source = CGImageSourceCreateWithURL(url as CFURL, nil)!
let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
let width = image.width, height = image.height
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
try VNImageRequestHandler(cgImage: image).perform([request])
var words: [[String: Any]] = []
for observation in request.results ?? [] {
  guard let candidate = observation.topCandidates(1).first else { continue }
  let text = candidate.string
  let matches = try NSRegularExpression(pattern: "\\S+").matches(in: text, range: NSRange(text.startIndex..., in: text))
  for match in matches {
    guard let range = Range(match.range, in: text), let box = try candidate.boundingBox(for: range)?.boundingBox else { continue }
    words.append(["text": String(text[range]), "box": [box.minX * Double(width), (1 - box.maxY) * Double(height), box.width * Double(width), box.height * Double(height)]])
  }
}
var rgba = [UInt8](repeating: 0, count: width * height * 4)
let context = CGContext(data: &rgba, width: width, height: height, bitsPerComponent: 8,
  bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
context.draw(image, in: CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
// The native UIKit default-blue handle bars/circles are distinct from green message chrome.
var mask = [Bool](repeating: false, count: width * height)
for i in 0..<(width * height) {
  let r = Int(rgba[i*4]), g = Int(rgba[i*4+1]), b = Int(rgba[i*4+2])
  mask[i] = b > 120 && b * 10 > r * 15 && b * 10 > g * 11
}
var components: [[Int]] = []
for seed in mask.indices where mask[seed] {
  var queue = [seed], index = 0
  mask[seed] = false
  var minX = width, minY = height, maxX = 0, maxY = 0
  while index < queue.count {
    let value = queue[index]; index += 1
    let x = value % width, y = value / width
    minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
    for (nx, ny) in [(x-1,y),(x+1,y),(x,y-1),(x,y+1)] where nx >= 0 && ny >= 0 && nx < width && ny < height {
      let next = ny * width + nx
      if mask[next] { mask[next] = false; queue.append(next) }
    }
  }
  if queue.count >= 5 { components.append([minX, minY, maxX-minX+1, maxY-minY+1]) }
}
let result: [String: Any] = ["width": width, "height": height, "words": words, "blue_components": components]
print(String(data: try JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
"""


class JourneyError(Exception):
    def __init__(self, category, predicate):
        self.category, self.predicate = category, predicate
        super().__init__(predicate)


def require(condition, category, predicate):
    if not condition:
        raise JourneyError(category, predicate)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class Journey:
    def __init__(self, args):
        self.args = args
        self.output = Path(args.output).resolve()
        self.output.mkdir(parents=True, exist_ok=False)
        self.commands, self.checks, self.children = [], [], []
        self.context = None
        self.env = dict(os.environ)
        self.owned_pid = None
        self.cleanup = {"expected": 0, "closed": 0, "errors": [], "borrowed_companion_stopped": False}

    def command(self, args, *, input=None, timeout=25, category="HARNESS_ERROR"):
        started = time.time()
        result = subprocess.run(args, input=input, text=True, capture_output=True, env=self.env, timeout=timeout)
        self.commands.append({"argv": args, "start": started, "exit": result.returncode,
                              "stdout": result.stdout, "stderr": result.stderr})
        require(result.returncode == 0, category, f"command:{args[0]}:{result.returncode}:{result.stderr[:300]}")
        return result.stdout

    def sim(self, *args, **kwargs):
        return self.command(["xcrun", "simctl", "--set", self.args.device_set, *args], **kwargs)

    def idb(self, *args):
        # Every client receives the exact borrowed socket; there is no discovery path.
        require(self.context is not None and self.env.get("IDB_COMPANION") == self.context["socket"], "HARNESS_ERROR", "companion_binding_lost")
        return self.command(["idb", *args, "--udid", self.args.udid])

    def ax(self, name):
        raw = self.idb("ui", "describe-all", "--json")
        (self.output / f"{name}.ax.json").write_text(raw)
        tree = json.loads(raw)
        def flatten(value):
            if isinstance(value, list):
                return [row for child in value for row in flatten(child)]
            if isinstance(value, dict):
                return [value] + flatten(value.get("children", []))
            return []
        rows = flatten(tree)
        require(len(rows) > 2 and any(self.label(row) for row in rows), "HARNESS_ERROR", "degenerate_AX_tree")
        return rows

    @staticmethod
    def label(row):
        return " ".join(str(row.get(key) or "") for key in ("AXLabel", "AXValue", "label", "value", "AXUniqueId", "identifier"))

    @staticmethod
    def frame(row):
        value = row.get("frame") or {}
        return tuple(float(value.get(key, 0)) for key in ("x", "y", "width", "height"))

    def preflight(self):
        # Fail BEFORE invoking even simctl/idb when the companion is omitted.
        companion = self.env.get("IDB_COMPANION", "")
        require(bool(companion) and Path(companion).is_absolute(), "HARNESS_ERROR", "IDB_COMPANION_required_before_native_commands")
        path = self.env.get("PENTACLE_REPORT_VIEWER_INPUT_CONTEXT", "")
        require(bool(path) and Path(path).is_absolute(), "HARNESS_ERROR", "allocation_direct_input_context_required")
        info = Path(path).lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o022, "HARNESS_ERROR", "unsafe_input_context")
        context = json.loads(Path(path).read_text())
        require(context.get("schema") == 1 and context.get("adapter") == "private-idb", "HARNESS_ERROR", "direct_input_context_schema")
        require(str(Path(self.args.device_set).resolve()) == self.args.device_set == context.get("device_set_root")
                and self.args.udid == context.get("udid") and companion == context.get("socket"), "HARNESS_ERROR", "allocation_identity_mismatch")
        require(stat.S_ISSOCK(Path(companion).stat().st_mode), "HARNESS_ERROR", "companion_socket_not_live")
        pid, owner = context.get("companion_pid"), context.get("owner_pid")
        require(isinstance(pid, int) and pid > 1 and isinstance(owner, int) and owner > 1
                and self.env.get("SIM_QUEUE_OWNER_VERIFIED_PID") == str(owner), "HARNESS_ERROR", "allocation_owner_identity_required")
        os.kill(owner, 0)
        argv = self.command(["ps", "-p", str(pid), "-o", "command="]).strip()
        for key, value in (("--udid", self.args.udid), ("--device-set-path", self.args.device_set), ("--grpc-domain-sock", companion)):
            require(re.search(r"(?:^|\s)" + re.escape(key) + r"\s+" + re.escape(value) + r"(?:\s|$)", argv), "HARNESS_ERROR", f"companion_argv_mismatch:{key}")
        parent = self.command(["ps", "-p", str(pid), "-o", "ppid="]).strip()
        require(parent == str(owner), "HARNESS_ERROR", "companion_not_owned_by_allocation_process")
        birth = self.command(["node", "-e", "process.stdout.write(String(require('./scripts/gate-app-ready.cjs').processBirth(Number(process.argv[1]))))", str(pid)]).strip()
        require(birth == context.get("companion_birth"), "HARNESS_ERROR", "companion_birth_mismatch")
        self.context = context
        self.env["IDB_COMPANION"] = companion
        devices = json.loads(self.sim("list", "devices", "--json"))["devices"]
        selected = [d for group in devices.values() for d in group if d.get("udid") == self.args.udid]
        require(len(selected) == 1 and selected[0].get("state") == "Booted", "HARNESS_ERROR", "allocated_device_not_booted")
        described = json.loads(self.idb("describe", "--json"))
        require(described.get("udid") == self.args.udid and described.get("state") == "Booted"
                and described.get("target_type") == "simulator", "HARNESS_ERROR", "idb_target_identity_mismatch")
        self.ax("preflight")
        self.checks.append({"preflight": "PASS", "context_sha256": digest(path), "companion_pid": pid, "device_set": self.args.device_set, "udid": self.args.udid})

    def screenshot(self, name):
        target = self.output / f"{name}.png"
        self.sim("io", self.args.udid, "screenshot", str(target))
        require(target.stat().st_size > 100, "HARNESS_ERROR", "empty_screenshot")
        return target

    def tap(self, x, y, duration=None):
        args = ["ui", "tap"]
        if duration is not None:
            args += ["--duration", str(duration)]
        self.idb(*args, str(round(x, 2)), str(round(y, 2)))

    def swipe(self, x1, y1, x2, y2):
        self.idb("ui", "swipe", "--duration", "1", *[str(round(n, 2)) for n in (x1, y1, x2, y2)])

    def find(self, rows, text):
        return [row for row in rows if text in self.label(row) and self.frame(row)[2] > 0]

    def copy_menu(self, name):
        rows = self.ax(name + "-menu")
        matches = [row for row in rows if (row.get("AXLabel") or row.get("label")) == "Copy"]
        require(bool(matches), "PRODUCT_FAIL", "native_Copy_menu_missing")
        x, y, w, h = self.frame(matches[0])
        self.tap(x + w / 2, y + h / 2)
        return self.sim("pbpaste", self.args.udid)

    def start_child(self, argv, name):
        handle = (self.output / f"{name}.log").open("w")
        process = subprocess.Popen(argv, stdout=handle, stderr=handle, env=self.env, start_new_session=True)
        self.children.append((process, handle, name))
        self.cleanup["expected"] += 1
        return process

    def vision(self, screenshot, rows):
        raw = self.command(["swift", "-", str(screenshot)], input=SWIFT_VISION, timeout=90)
        value = json.loads(raw)
        screens = [self.frame(row) for row in rows if self.frame(row)[0:2] == (0, 0)]
        require(bool(screens), "HARNESS_ERROR", "AX_screen_frame_required_for_scale")
        screen = max(screens, key=lambda box: box[2] * box[3])
        sx, sy = value["width"] / screen[2], value["height"] / screen[3]
        require(sx > 0 and abs(sx - sy) < 0.03, "HARNESS_ERROR", "screenshot_AX_scale_mismatch")
        for word in value["words"]:
            word["box"] = [coordinate / sx for coordinate in word["box"]]
        value["blue_components"] = [[coordinate / sx for coordinate in box] for box in value["blue_components"]]
        value["screen_points"] = screen[2:4]
        (screenshot.with_suffix(".vision.json")).write_text(json.dumps(value, indent=2))
        return value

    def capture(self, name):
        rows = self.ax(name)
        shot = self.screenshot(name)
        return rows, self.vision(shot, rows)

    def seek(self, text, role=None):
        # One bounded pass in each direction; no reset/boot or hidden state injection.
        for direction in (1, -1):
            for attempt in range(7):
                rows = self.ax(f"seek-{len(self.commands)}")
                matches = self.find(rows, text)
                if role is not None:
                    identified = [row for row in matches if str(row.get("AXUniqueId") or row.get("identifier") or "").startswith("message-text-")]
                    if identified:
                        matches = [row for row in identified if ("user-body" in str(row.get("AXUniqueId") or row.get("identifier"))) == (role == "USER")]
                    elif self.args.baseline:
                        users = [row for row in matches if str(row.get("AXUniqueId") or "").startswith("message-bubble-")]
                        if role == "USER":
                            matches = users
                        else:
                            def inside_user(row):
                                x,y,w,h = self.frame(row)
                                return any(ux-1 <= x and uy-1 <= y and x+w <= ux+uw+1 and y+h <= uy+uh+1
                                           for ux,uy,uw,uh in map(self.frame,users))
                            matches = [row for row in matches if not inside_user(row)]
                    else:
                        matches = []
                matches = [row for row in matches if self.frame(row)[1] > 60 and self.frame(row)[3] > 0]
                if matches:
                    return matches[0]
                frames = [self.frame(row) for row in rows if self.frame(row)[0:2] == (0, 0)]
                require(bool(frames), "HARNESS_ERROR", "no_screen_for_scroll")
                _, _, width, height = max(frames, key=lambda f: f[2] * f[3])
                self.swipe(width / 2, height * (0.3 if direction == 1 else 0.7), width / 2, height * (0.7 if direction == 1 else 0.3))
        raise JourneyError("PRODUCT_FAIL", f"fixture_surface_not_visible:{role}:{text}")

    def word_box(self, vision, word, frame):
        x, y, w, h = frame
        matches = [item["box"] for item in vision["words"] if item["text"].strip(".,:;") == word
                   and x - 2 <= item["box"][0] <= x + w + 2
                   and y - 2 <= item["box"][1] <= y + h + 2]
        require(len(matches) == 1, "HARNESS_ERROR", f"OCR_word_not_unique_in_surface:{word}")
        return matches[0]

    def range_events(self):
        path = self.output / "native-log.log"
        events = []
        if not path.exists():
            return events
        for line in path.read_text(errors="replace").splitlines():
            try:
                record = json.loads(line)
            except ValueError:
                continue
            message = record.get("eventMessage", "")
            if "[TELEMETRY] " not in message or str(record.get("processID")) != str(self.owned_pid):
                continue
            try:
                payload = json.loads(message.split("[TELEMETRY] ", 1)[1])
            except ValueError:
                continue
            require(payload.get("message") != "chat:ws_open", "HARNESS_ERROR", "offline_fixture_opened_connection")
            if payload.get("message") == "chat:message_selection_font_error":
                raise JourneyError("PRODUCT_FAIL", "native_font_alias_unresolved")
            if payload.get("message") == "chat:message_selection_changed":
                events.append(payload["data"])
        return events

    def require_range(self, start, end, identity, after_index):
        for _ in range(15):
            events = self.range_events()
            matching = [event for event in events[after_index:] if event.get("start") == start and event.get("end") == end
                        and event.get("length") == end-start and f"{event.get('row_id')}:{event.get('block_id')}" == identity]
            if matching:
                return matching[-1]
            time.sleep(0.1)
        raise JourneyError("PRODUCT_FAIL", f"native_UTF16_range_missing:{start}:{end}")

    def two_handles(self, vision, silver, amber=None):
        x, y, w, h = silver
        right = (amber[0] + amber[2]) if amber else x+w
        bottom = (amber[1] + amber[3]) if amber else y+h
        nearby = [box for box in vision["blue_components"] if box[2] >= 1 and box[3] >= 3
                  and x-20 <= box[0] <= right+20 and y-25 <= box[1] <= bottom+25]
        left = [box for box in nearby if abs(box[0] - x) < 15]
        trailing = [box for box in nearby if abs(box[0] - right) < 15]
        require(bool(left) and bool(trailing) and left[0] != trailing[-1], "PRODUCT_FAIL", "two_native_selection_handles_not_visible")
        handle = trailing[-1]
        return handle[0] + handle[2]/2, handle[1] + handle[3] - 2

    def selection_case(self, role, text, start, expanded):
        name = f"{role.lower()}-{start}-{len(text)}"
        surface = self.seek(text, role)
        frame = self.frame(surface)
        identity = str(surface.get("AXUniqueId") or surface.get("identifier") or "").removeprefix("message-text-")
        rows, before = self.capture(name + "-before")
        silver = self.word_box(before, "silver", frame)
        amber = self.word_box(before, "amber", frame)
        range_start = len(self.range_events())
        self.sim("pbcopy", self.args.udid, input="F2_SENTINEL")
        self.tap(silver[0]+silver[2]/2, silver[1]+silver[3]/2, duration=1)
        time.sleep(0.3)
        _, selected = self.capture(name + "-word")
        if self.args.baseline:
            try:
                actual = self.copy_menu(name)
            except JourneyError as error:
                if error.category != "PRODUCT_FAIL":
                    raise
                actual = self.sim("pbpaste", self.args.udid)
            require(actual != "silver", "HARNESS_ERROR", "baseline_word_selection_already_works_replan_required")
            self.checks.append({"role": role, "text": text, "expected": "silver", "actual": actual, "verdict": "PRODUCT_FAIL"})
            return
        self.require_range(start, start+6, identity, range_start)
        self.two_handles(selected, silver)
        actual = self.copy_menu(name)
        require(actual == "silver", "PRODUCT_FAIL", f"word_clipboard:{actual!r}")
        # A second real long press then a trailing-handle drag expands the native range.
        self.tap(silver[0]+silver[2]/2, silver[1]+silver[3]/2, duration=1)
        time.sleep(0.3)
        _, repeated = self.capture(name + "-redrag")
        hx, hy = self.two_handles(repeated, silver)
        range_start = len(self.range_events())
        self.swipe(hx, hy, amber[0]+amber[2]+1, amber[1]+amber[3]/2)
        time.sleep(0.3)
        rows, after = self.capture(name + "-expanded")
        self.require_range(start, start+len(expanded), identity, range_start)
        self.two_handles(after, silver, amber)
        require(not any("Keyboard" in str(row.get("type")) for row in rows), "PRODUCT_FAIL", "message_selection_opened_keyboard")
        actual = self.copy_menu(name + "-expanded")
        require(actual == expanded, "PRODUCT_FAIL", f"expanded_clipboard:{actual!r}")
        self.checks.append({"role": role, "text": text, "word": "silver", "expanded": actual, "start": start, "end": start+len(expanded), "verdict": "PASS"})

    def runtime(self):
        require(self.command(["git", "rev-parse", "HEAD"]).strip() == self.args.source_sha, "HARNESS_ERROR", "checkout_source_SHA_mismatch")
        manifest_path = self.env.get("F2_ARTIFACT_MANIFEST", "")
        require(bool(manifest_path), "HARNESS_ERROR", "owner_built_artifact_manifest_required")
        manifest = json.loads(Path(manifest_path).read_text())
        require(manifest.get("source_sha") == self.args.source_sha and manifest.get("fixture_sha256") == digest(ROOT / "src/harness/screenshotFixtures.ts")
                and re.fullmatch(r"[0-9a-f]{64}", manifest.get("config_sha256", "")), "HARNESS_ERROR", "artifact_source_fixture_config_binding")
        app = Path(self.sim("get_app_container", self.args.udid, self.args.bundle_id, "app").strip())
        info = plistlib.loads((app / "Info.plist").read_bytes())
        require(digest(app / info["CFBundleExecutable"]) == manifest.get("app_binary_sha256")
                and digest(app / "main.jsbundle") == manifest.get("embedded_bundle_sha256"), "HARNESS_ERROR", "installed_artifact_hash_mismatch")
        self.checks.append({"artifact_manifest_sha256": digest(manifest_path), "installed_app": str(app), "manifest": manifest})
        current = self.command(["node", "-e", "process.stdout.write(String(require('./scripts/gate-app-ready.cjs').currentPid({deviceSetRoot:process.argv[1],udid:process.argv[2],bundleId:process.argv[3]})))", self.args.device_set, self.args.udid, self.args.bundle_id]).strip()
        require(current == "null", "HARNESS_ERROR", "preexisting_app_process_not_owned")
        # Capture before launch so first-render font/runtime errors cannot be missed;
        # retained telemetry is subsequently filtered to the exact launched PID.
        self.start_child(["xcrun", "simctl", "--set", self.args.device_set, "spawn", self.args.udid, "log", "stream", "--style", "ndjson", "--level", "debug", "--predicate", f"process == {json.dumps(info['CFBundleExecutable'])}"], "native-log")
        self.start_child(["xcrun", "simctl", "--set", self.args.device_set, "io", self.args.udid, "recordVideo", str(self.output / "journey.mov")], "video")
        time.sleep(0.5)
        require(all(process.poll() is None for process, _, _ in self.children), "HARNESS_ERROR", "capture_process_exited_before_launch")
        launched = self.sim("launch", self.args.udid, self.args.bundle_id)
        match = re.search(r":\s*([1-9][0-9]*)\s*$", launched)
        require(match, "HARNESS_ERROR", "launch_PID_missing")
        self.owned_pid = int(match.group(1)); self.cleanup["expected"] += 1
        self.sim("openurl", self.args.udid, "pentacle://pentacle/session/hosta%3Aanalysis-sample")
        time.sleep(2)
        self.seek("Copper silver amber violet", "USER")
        if self.args.baseline:
            for role in ("USER", "ASSIST"):
                self.selection_case(role, "Copper silver amber violet", 7, "silver amber")
            raise JourneyError("PRODUCT_FAIL", "baseline_both_roles_whole_message_or_no_native_word_range")
        for role in ("USER", "ASSIST"):
            for text, start, expanded in (("Copper silver amber violet", 7, "silver amber"), ("A 😀 silver amber violet", 5, "silver amber"), ("café silver\namber violet", 6, "silver\namber")):
                self.selection_case(role, text, start, expanded)
        self.regressions()
        self.range_events()
        current = self.command(["node", "-e", "process.stdout.write(String(require('./scripts/gate-app-ready.cjs').currentPid({deviceSetRoot:process.argv[1],udid:process.argv[2],bundleId:process.argv[3]})))", self.args.device_set, self.args.udid, self.args.bundle_id]).strip()
        require(current == str(self.owned_pid), "PRODUCT_FAIL", "candidate_not_live_at_final_observation")

    def regressions(self):
        # Test real inline link routing against one owned loopback HTTP receiver.
        requests = []
        class Receiver(http.server.BaseHTTPRequestHandler):
            def do_GET(handler):
                if handler.path == "/f2-link": requests.append(handler.path)
                handler.send_response(200); handler.end_headers(); handler.wfile.write(b"Local synthetic selection link")
            def log_message(*_): pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 17889), Receiver)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            link = self.seek("Local selection link")
            x,y,w,h = self.frame(link)
            rows, before = self.capture("link-before")
            word = self.word_box(before, "Local", (x,y,w,h))
            self.tap(word[0]+word[2]/2, word[1]+word[3]/2, duration=1)
            time.sleep(0.3)
            self.capture("link-selected")
            require(self.copy_menu("link-selection") == "Local", "PRODUCT_FAIL", "linked_text_selection")
            self.tap(word[0]+word[2]/2, word[1]+word[3]/2)
            for _ in range(30):
                if requests: break
                time.sleep(0.1)
            require(requests == ["/f2-link"], "PRODUCT_FAIL", "link_destination_exactly_once")
            self.sim("openurl", self.args.udid, "pentacle://pentacle/session/hosta%3Aanalysis-sample")
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=5)
        photo = self.seek("message-image-0")
        x,y,w,h = self.frame(photo); self.tap(x+w/2,y+h/2)
        rows = self.ax("attachment-open")
        close = next((row for row in rows if "image-viewer-close" in str(row.get("AXUniqueId"))), None)
        require(close is not None, "PRODUCT_FAIL", "attachment_viewer_missing")
        self.screenshot("attachment-open")
        x,y,w,h = self.frame(close); self.tap(x+w/2,y+h/2)
        rows = self.ax("composer-before")
        composer = next((row for row in rows if row.get("AXUniqueId") == "composer-input"), None)
        require(composer is not None, "PRODUCT_FAIL", "composer_missing")
        x,y,w,h = self.frame(composer); self.tap(x+w/2,y+h/2)
        self.idb("ui", "text", "F2 unsent local draft")
        # Do not tap Send; selection must dismiss the editable keyboard and retain draft.
        self.selection_case("USER", "Copper silver amber violet", 7, "silver amber")
        rows = self.ax("composer-preserved")
        require(any("F2 unsent local draft" in self.label(row) for row in rows), "PRODUCT_FAIL", "unsent_draft_lost")
        # Real vertical movement must change which transcript text is visible.
        rows, screen = self.capture("vertical-before")
        width, height = screen["screen_points"]
        before = self.output / "vertical-before.png"
        self.swipe(width/2, height*0.7, width/2, height*0.3)
        after = self.screenshot("vertical-after")
        require(digest(before) != digest(after), "PRODUCT_FAIL", "vertical_scroll_did_not_move")
        # Horizontal table/code proof uses OCR of visible marker text, never full AX labels.
        for prefix, marker in (("table", "FAR_TABLE_MARKER"), ("code", "END_CODE_MARKER")):
            surface = self.seek(marker)
            x,y,w,h = self.frame(surface)
            rows, before = self.capture(prefix+"-before")
            normalize = lambda value: re.sub(r"[^A-Za-z0-9]", "", value).lower()
            old_visible = normalize("".join(word["text"] for word in before["words"]))
            require(normalize(marker) not in old_visible, "HARNESS_ERROR", prefix+"_marker_not_initially_clipped")
            for attempt in range(6):
                screen_width = before["screen_points"][0]
                self.swipe(screen_width*0.9,y+h/2,screen_width*0.15,y+h/2)
                rows, after = self.capture(prefix+f"-after-{attempt}")
                visible = normalize("".join(word["text"] for word in after["words"]))
                if normalize(marker) in visible:
                    break
            require(normalize(marker) in visible, "PRODUCT_FAIL", prefix+"_horizontal_marker_not_visible")
        self.checks.append({"links_exactly_once": True, "linked_word_selection": True, "attachment_viewer": True,
                            "unsent_draft": True, "vertical_scroll": True, "table_horizontal": True, "code_horizontal": True})

    def cleanup_owned(self):
        for process, handle, label in reversed(self.children):
            try:
                os.killpg(process.pid, signal.SIGINT if label == "video" else signal.SIGTERM)
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)
                    raise JourneyError("CLEANUP_FAIL", label+"_did_not_finalize_gracefully")
                handle.close()
                self.cleanup["closed"] += 1
                if label == "video":
                    video = self.output / "journey.mov"
                    require(video.is_file() and video.stat().st_size > 100, "CLEANUP_FAIL", "video_missing")
                    duration = self.command(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(video)]).strip()
                    require(float(duration) > 0, "CLEANUP_FAIL", "video_not_finalized")
            except Exception as error:
                handle.close()
                self.cleanup["errors"].append(f"{label}:{error}")
        if self.owned_pid is not None:
            try:
                # Verify exact live identity before stopping only this runner's app.
                current = self.command(["node", "-e", "process.stdout.write(String(require('./scripts/gate-app-ready.cjs').currentPid({deviceSetRoot:process.argv[1],udid:process.argv[2],bundleId:process.argv[3]})))", self.args.device_set, self.args.udid, self.args.bundle_id]).strip()
                require(current == str(self.owned_pid), "CLEANUP_FAIL", "owned_app_identity_changed")
                self.sim("terminate", self.args.udid, self.args.bundle_id)
                self.cleanup["closed"] += 1
            except Exception as error:
                self.cleanup["errors"].append(f"app:{error}")


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device-set", required=True)
    parser.add_argument("--udid", required=True)
    parser.add_argument("--bundle-id", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--preflight-only", action="store_true")
    parser.add_argument("--baseline", action="store_true")
    return parser.parse_args()


def main():
    args = parse_args()
    journey = Journey(args)
    result = {"source_sha": args.source_sha, "runner_sha256": digest(__file__), "fixture_sha256": digest(ROOT / "src/harness/screenshotFixtures.ts"), "verdict": "HARNESS_ERROR"}
    code = 2
    try:
        os.chdir(ROOT)
        require(re.fullmatch(r"[0-9a-f]{40}", args.source_sha), "HARNESS_ERROR", "full_source_SHA_required")
        journey.preflight()
        if args.preflight_only:
            result["verdict"] = "PREFLIGHT_ONLY"
            code = 0
        else:
            journey.runtime()
            result["verdict"], code = "PASS", 0
    except JourneyError as error:
        result.update(verdict=error.category, failed_predicate=error.predicate)
        code = 1 if error.category == "PRODUCT_FAIL" else 2
    except Exception as error:
        result.update(verdict="HARNESS_ERROR", failed_predicate=f"{type(error).__name__}:{error}")
    finally:
        journey.cleanup_owned()
        if journey.cleanup["errors"]:
            result["original_verdict"] = result["verdict"]
            result["verdict"], code = "CLEANUP_FAIL", 3
        result.update(checks=journey.checks, commands=journey.commands, cleanup=journey.cleanup)
        (journey.output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        hashes = {str(path.relative_to(journey.output)): digest(path) for path in sorted(journey.output.rglob("*")) if path.is_file()}
        (journey.output / "artifacts.sha256.json").write_text(json.dumps(hashes, indent=2) + "\n")
    print(json.dumps({"verdict": result["verdict"], "failed_predicate": result.get("failed_predicate"), "output": str(journey.output)}))
    return code


if __name__ == "__main__":
    sys.exit(main())
