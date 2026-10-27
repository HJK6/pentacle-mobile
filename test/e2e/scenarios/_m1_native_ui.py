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
