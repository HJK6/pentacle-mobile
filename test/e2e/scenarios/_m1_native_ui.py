"""Bounded accessibility actions for the synthetic M1 native journey."""
from __future__ import annotations

import json
import subprocess
import time


class NativeUI:
    def __init__(self, config):
        self.udid = config['SIMULATOR_UDID']
        self.trace = config['trace']

    def _command(self, *args):
        result = subprocess.run(['idb', 'ui', *args, '--udid', self.udid], capture_output=True,
                                text=True, timeout=20, check=False)
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
            rows = self.visible(elements, label=label)
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
                if not isinstance(hit, dict) or hit.get('AXLabel') != label:
                    return False
                if identifier and identifier not in (hit.get('AXIdentifier'), hit.get('AXUniqueId')):
                    return False
            return True
        except (RuntimeError, ValueError, TypeError, KeyError):
            return False

    def row_visible(self, label):
        return self.hit_visible(label, roster=True)

    def wait_hit(self, label, timeout=20, *, roster=False):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.hit_visible(label, roster=roster):
                return
            time.sleep(.2)
        raise RuntimeError('M1 visible row did not pass hit testing: ' + label)

    def wait_row(self, label, timeout=1):
        self.wait_hit(label, timeout=timeout, roster=True)

    def count(self, label):
        # Include off-screen accessibility nodes when checking duplicate rows.
        return sum(1 for element in self.elements() if element.get('AXLabel') == label)

    def wait(self, identifier=None, label=None, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            found = self.visible(self.elements(), identifier, label)
            if len(found) == 1:
                return found[0]
            time.sleep(.2)
        raise RuntimeError('M1 visible target missing or ambiguous: ' + str(identifier or label))

    def present(self, identifier, timeout=1):
        try:
            self.wait(identifier, timeout=timeout)
            return True
        except RuntimeError:
            return False

    def wait_absent(self, identifier=None, label=None, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not self.visible(self.elements(), identifier, label):
                if self.absent(identifier, label):
                    return True
            time.sleep(.2)
        return False

    def absent(self, identifier=None, label=None, duration=2):
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
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

    def type_text(self, identifier, text):
        self.tap(identifier)
        self._command('text', text)

    def swipe_up(self):
        root = next(e['frame'] for e in self.elements() if e.get('role') == 'AXApplication')
        x = str(int(root['x'] + root['width'] * .5))
        self._command('swipe', x, str(int(root['y'] + root['height'] * .78)), x,
                      str(int(root['y'] + root['height'] * .28)), '--duration', '.4')
