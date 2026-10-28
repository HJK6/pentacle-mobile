"""Explicitly bounded M1 idb client-stream capture; never claims OS delivery."""
from __future__ import annotations
import json
import time
from pathlib import Path


def _normalise(event):
    from idb.common.types import HIDPress, HIDKey, HIDTouch, HIDButton, HIDDelay, HIDSwipe
    if isinstance(event, HIDPress):
        result = {'type': 'press', 'direction': event.direction.name}
        if isinstance(event.action, HIDKey):
            result.update(action='key', keycode=event.action.keycode)
        elif isinstance(event.action, HIDTouch):
            result.update(action='touch', x=event.action.point.x, y=event.action.point.y)
        elif isinstance(event.action, HIDButton):
            result.update(action='button', button=event.action.button.name)
        else:
            raise ValueError('unsupported HID action')
        return result
    if isinstance(event, HIDDelay):
        return {'type': 'delay', 'duration': event.duration}
    if isinstance(event, HIDSwipe):
        return {'type': 'swipe', 'x1': event.start.x, 'y1': event.start.y,
                'x2': event.end.x, 'y2': event.end.y, 'duration': event.duration, 'delta': event.delta}
    raise ValueError('unsupported HID event')


def write_events(path, command, events):
    rows = [_normalise(event) for event in events]  # Validate before writing any row.
    with Path(path).open('a', encoding='utf-8') as output:
        for event in rows:
            output.write(json.dumps({'provenance': 'client_submitted_not_delivered', 'command': command,
                                     'wall_ns': time.time_ns(), 'monotonic_ns': time.monotonic_ns(), 'event': event}) + '\n')
