"""Bounded accessibility actions for the synthetic M1 native journey."""
from __future__ import annotations

import json
import os
import sys
import shutil
from pathlib import Path
import re
import subprocess
import time

from ..harness import scenario_simctl_command

# Bounded number of corrective drags applied when a row exists in the
# accessibility tree but is clipped by its enclosing ScrollView (the PR #97
# hit-test class). After this budget the caller's deadline fails closed.
CORRECTIVE_DRAG_BUDGET = 4


def _transcript_text(element):
    label = element.get('AXLabel')
    if isinstance(label, str) and label:
        return label
    value = element.get('AXValue')
    if label in (None, '') and element.get('role') == 'AXStaticText' and isinstance(value, str):
        return value
    return None


class SystemUIInterception(Exception):
    def __init__(self, foreground, video_timestamp_s):
        self.foreground = foreground or 'unavailable'
        self.video_timestamp_s = video_timestamp_s
        super().__init__('system UI interception: ' + self.foreground)


def foreground_bundle(elements, launchctl):
    roots = [e for e in elements if e.get('role') == 'AXApplication']
    if len(roots) != 1 or not isinstance(roots[0].get('pid'), int):
        return None
    pid = str(roots[0]['pid'])
    matches = []
    for line in launchctl.splitlines():
        fields = line.split()
        if len(fields) < 3 or fields[0] != pid:
            continue
        match = re.fullmatch(r'UIKitApplication:([^\[]+)\[.+', fields[-1])
        if match:
            matches.append(match.group(1))
    return matches[0] if len(matches) == 1 else None


def check_navigation(expected_bundle, foreground, changed, timestamp):
    if not foreground or foreground != expected_bundle:
        raise SystemUIInterception(foreground, timestamp)
    if not changed:
        raise AssertionError('M1 expected navigation state did not change')


class NativeUI:
    def __init__(self, config):
        self.udid = config['SIMULATOR_UDID']
        self.trace = config['trace']
        self.config = config
        self.bundle = config.get('PENTACLE_GATE_BOUND_BUNDLE_ID') or config.get('PENTACLE_BUNDLE_ID')
        self.video_started_at = config.get('_video_started_at')

    def read_foreground(self):
        try:
            elements = self.elements()
            result = subprocess.run(scenario_simctl_command('spawn', self.udid, 'launchctl', 'list', config=self.config),
                                    capture_output=True, text=True, timeout=20, check=False)
            self.trace('m1 foreground launchctl', result)
            return foreground_bundle(elements, result.stdout) if result.returncode == 0 else None
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
            return None

    def check_foreground(self):
        foreground = self.read_foreground()
        stamp = max(0.0, time.time() - self.video_started_at) if isinstance(self.video_started_at, (int, float)) else None
        check_navigation(self.bundle, foreground, True, stamp)

    def _command(self, *args):
        capture_path = os.environ.get('M1_DIAGNOSTIC_HID_PATH')
        is_hid = args[0] in ('tap', 'text', 'swipe', 'button', 'key', 'key-sequence')
        command = ['idb']
        env = dict(os.environ, M1_DIAGNOSTIC_COMMAND=str(args[0]))
        if capture_path and is_hid:
            cli = Path(shutil.which('idb') or '').resolve(strict=True)
            first = cli.read_text(encoding='utf-8').splitlines()[0]
            if not first.startswith('#!/') or ' ' in first:
                raise RuntimeError('unsupported idb interpreter; cannot capture actual client')
            interpreter = first[2:]
            env['M1_DIAGNOSTIC_IDB_CLI'] = str(cli)
            command = [interpreter, '-m', 'e2e.scenarios._m1_idb_capture']
            env['PYTHONPATH'] = str(Path(__file__).resolve().parents[2]) + os.pathsep + env.get('PYTHONPATH', '')
        start_ns = time.time_ns()
        run_options = {'env': env} if capture_path and is_hid else {}
        result = subprocess.run([*command, 'ui', *args, '--udid', self.udid], capture_output=True,
                                text=True, timeout=20, check=False, **run_options)
        command_path = os.environ.get('M1_DIAGNOSTIC_COMMAND_PATH')
        if command_path and is_hid:
            with open(command_path, 'a', encoding='utf-8') as output:
                output.write(json.dumps({'command': list(args), 'wall_start_ns': start_ns,
                    'wall_end_ns': time.time_ns(), 'status': result.returncode,
                    'instrumented_client': bool(capture_path), 'provenance': 'client_command'}) + '\n')
        self.trace('m1 idb ' + str(args[0]), result)
        if result.returncode:
            raise RuntimeError('M1 native accessibility command failed: ' + str(args[0]))
        return result.stdout

    def elements(self):
        raw = self._command('describe-all', '--json')
        try:
            data = json.loads(raw)
        except ValueError:
            data = [json.loads(line) for line in raw.splitlines() if line.strip()]
        if isinstance(data, dict):
            data = data.get('elements')
        if not isinstance(data, list) or not all(isinstance(e, dict) for e in data):
            raise RuntimeError('M1 accessibility output is malformed')
        return data

    @staticmethod
    def visible(elements, identifier=None, label=None):
        roots = [e.get('frame') for e in elements if e.get('role') == 'AXApplication']
        if len(roots) != 1 or not isinstance(roots[0], dict):
            raise RuntimeError('M1 application bounds missing')
        root = roots[0]
        keys = ('x', 'y', 'width', 'height')
        if not all(isinstance(root.get(k), (int, float)) for k in keys):
            raise RuntimeError('M1 application bounds malformed')
        found = []
        for element in elements:
            if identifier is not None and identifier not in (element.get('AXIdentifier'), element.get('AXUniqueId')):
                continue
            if label is not None and element.get('AXLabel') != label:
                continue
            frame = element.get('frame')
            if not isinstance(frame, dict) or not all(isinstance(frame.get(k), (int, float)) for k in keys):
                continue
            if (frame['width'] > 0 and frame['height'] > 0 and frame['x'] >= root['x'] and frame['y'] >= root['y']
                    and frame['x'] + frame['width'] <= root['x'] + root['width']
                    and frame['y'] + frame['height'] <= root['y'] + root['height']):
                found.append(element)
        return found

    def hit_visible(self, label, *, roster=False):
        try:
            elements = self.elements()
            rows = [row for row in self.visible(elements) if _transcript_text(row) == label]
            if len(rows) != 1:
                return False
            row = rows[0]
            frame = row['frame']
            x = int(frame['x'] + frame['width'] / 2)
            points = [(x, int(frame['y'] + frame['height'] / 2))]
            if roster:
                headers = self.visible(elements, identifier='status-overlay-close')
                if len(headers) != 1:
                    return False
                header_frame = headers[0]['frame']
                points.append((x, int(frame['y'] + frame['height'] * .75)))
                if any(y <= header_frame['y'] + header_frame['height'] for _, y in points):
                    return False
            identifier = row.get('AXIdentifier') or row.get('AXUniqueId')
            for px, py in points:
                hit = json.loads(self._command('describe-point', str(px), str(py), '--json'))
                if not isinstance(hit, dict) or _transcript_text(hit) != label:
                    return False
                if identifier and identifier not in (hit.get('AXIdentifier'), hit.get('AXUniqueId')):
                    return False
            return True
        except (RuntimeError, ValueError, TypeError, KeyError):
            return False

    def row_visible(self, label):
        return self.hit_visible(label, roster=True)

    def _labeled_frame(self, label):
        # First on-screen (or off-screen) accessibility node for this label.
        for element in self.elements():
            if _transcript_text(element) == label and isinstance(element.get('frame'), dict):
                return element['frame']
        return None

    def _root_frame(self):
        return next(e['frame'] for e in self.elements() if e.get('role') == 'AXApplication')

    def _corrective_drag(self, *, down):
        # Reuse the swipe primitive. `down` scrolls content down (reveals a row
        # clipped above the viewport); otherwise up (reveals one clipped below).
        root = self._root_frame()
        x = str(int(root['x'] + root['width'] * .5))
        near = str(int(root['y'] + root['height'] * (.28 if down else .78)))
        far = str(int(root['y'] + root['height'] * (.78 if down else .28)))
        self._command('swipe', x, near, x, far, '--duration', '.4')

    def wait_hit(self, label, timeout=20, *, roster=False, corrective=False):
        deadline = time.monotonic() + timeout
        corrections = 0
        while time.monotonic() < deadline:
            self.check_foreground()
            if self.hit_visible(label, roster=roster):
                return
            # PR #97 hit-test gate: when the row is present in the accessibility
            # tree (including off-screen nodes) but describe-point in
            # `hit_visible` rejects it, it is clipped by the enclosing
            # ScrollView. Apply a bounded, direction-aware corrective drag to
            # bring it into the unclipped region, re-gating with describe-point.
            if corrective and corrections < CORRECTIVE_DRAG_BUDGET:
                before = self._labeled_frame(label)
                if before is not None:
                    root = self._root_frame()
                    # A row whose top sits above the viewport is clipped at the
                    # top (scroll down to reveal); otherwise clipped at the
                    # bottom (scroll up).
                    self._corrective_drag(down=before['y'] < root['y'])
                    corrections += 1
                    after = self._labeled_frame(label)
                    # Movement check: if the drag did not move the row it cannot
                    # become hittable, so fail closed instead of burning the
                    # budget against a pinned scroll view.
                    if after is None or abs(after['y'] - before['y']) < 1:
                        raise RuntimeError('M1 visible row did not pass hit testing: ' + label
                                           + ' (corrective drag did not move the row)')
                    continue
            time.sleep(.2)
        raise RuntimeError('M1 visible row did not pass hit testing: ' + label)

    def wait_row(self, label, timeout=1):
        self.wait_hit(label, timeout=timeout, roster=True)

    def count(self, label):
        # Include off-screen accessibility nodes when checking duplicate rows.
        self.check_foreground()
        return sum(1 for element in self.elements() if _transcript_text(element) == label)

    def wait(self, identifier=None, label=None, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.check_foreground()
            found = self.visible(self.elements(), identifier, label)
            if len(found) == 1:
                return found[0]
            time.sleep(.2)
        raise RuntimeError('M1 visible target missing or ambiguous: ' + str(identifier or label))

    def present(self, identifier=None, label=None, timeout=1):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.check_foreground()
            found = self.visible(self.elements(), identifier, label)
            if len(found) > 1:
                raise RuntimeError('M1 visible target ambiguous: ' + str(identifier or label))
            if found:
                return True
            time.sleep(.2)
        return False

    def wait_absent(self, identifier=None, label=None, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.check_foreground()
            if not self.visible(self.elements(), identifier, label):
                if self.absent(identifier, label):
                    return True
            time.sleep(.2)
        return False

    def absent(self, identifier=None, label=None, duration=2):
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            self.check_foreground()
            if self.visible(self.elements(), identifier, label):
                return False
            time.sleep(.2)
        return True

    def tap_stable(self, label):
        self.wait_hit(label)
        time.sleep(.6)
        self.wait_hit(label)
        self.tap(label=label)

    def tap(self, identifier=None, label=None):
        item = self.wait(identifier, label)
        if item.get('enabled') is False:
            raise RuntimeError('M1 target disabled: ' + str(identifier or label))
        frame = item['frame']
        self._command('tap', str(int(frame['x'] + frame['width'] / 2)), str(int(frame['y'] + frame['height'] / 2)))
        self.check_foreground()
        # Navigation targets have an explicit destination; selecting or editing a
        # control is verified by its caller's corresponding interaction oracle.
        target = identifier or label
        destinations = {
            'agent-thread-back-status': ('label', 'Close session status'),
            'nexus-status-history-mock-host-child-worker': ('label', 'Close thread history'),
            'Back to chats': ('id', 'chat-row-mock-host-mock-session'),
            'chat-row-mock-host-control-session': ('id', 'composer-input'),
            'chat-row-mock-host-card-control': ('id', 'composer-input'),
            'chat-row-mock-host-childless': ('id', 'composer-input'),
            'chat-row-mock-host-mock-session': ('id', 'composer-input'),
            'Close thread history': ('label', 'Close session status'),
        }
        if target == 'Close session status':
            if not self.wait_absent(identifier='status-overlay-close'):
                raise AssertionError('M1 status overlay did not close')
        elif target in destinations:
            kind, destination = destinations[target]
            self.wait(**({'identifier': destination} if kind == 'id' else {'label': destination}))

    def type_text(self, identifier, text):
        self._diagnostic_snapshot('before_focus', identifier)
        self.tap(identifier)
        self._diagnostic_snapshot('after_focus', identifier)
        self._command('text', text)
        self._diagnostic_snapshot('after_text', identifier)

    def _diagnostic_snapshot(self, step, identifier):
        path = os.environ.get('M1_DIAGNOSTIC_AX_PATH')
        if not path:
            return
        elements = self.elements()
        selected = [e for e in elements if identifier in (e.get('AXIdentifier'), e.get('AXUniqueId'))]
        with open(path, 'a', encoding='utf-8') as output:
            output.write(json.dumps({'step': step, 'target': identifier, 'wall_ns': time.time_ns(),
                'monotonic_ns': time.monotonic_ns(), 'elements': selected,
                'native_first_responder': 'unavailable', 'provenance': 'idb_accessibility_snapshot'}) + '\n')

    def swipe_up(self):
        root = next(e['frame'] for e in self.elements() if e.get('role') == 'AXApplication')
        x = str(int(root['x'] + root['width'] * .5))
        self._command('swipe', x, str(int(root['y'] + root['height'] * .78)), x,
                      str(int(root['y'] + root['height'] * .28)), '--duration', '.4')
