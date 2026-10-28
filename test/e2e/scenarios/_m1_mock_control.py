"""Control only an explicitly bound loopback scripted mock."""
from __future__ import annotations

import json
import time
import uuid
from urllib.parse import urlsplit
from websockets.sync.client import connect


class MockControl:
    def __init__(self, url):
        parsed = urlsplit(url)
        if parsed.scheme != 'ws' or parsed.hostname != '127.0.0.1' or not parsed.port or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
            raise ValueError('M1 control requires an explicit loopback mock URL')
        self.ws = connect(url, open_timeout=5, max_size=None)
        self.events = []
        try:
            if json.loads(self.ws.recv(timeout=5)).get('type') != 'welcome':
                raise RuntimeError('M1 mock welcome missing')
            self.ws.send(json.dumps({'type': 'hello', 'client': 'harness', 'subscribe': {'mode': 'rpc', 'snapshot': False}}))
            if json.loads(self.ws.recv(timeout=5)).get('type') != 'ready':
                raise RuntimeError('M1 mock ready missing')
            self.rpc('debug_replay_snapshot_config', snapshot={})
        except Exception:
            self.ws.close()
            raise

    def close(self):
        self.ws.close()

    def rpc(self, kind, **payload):
        request_id = uuid.uuid4().hex
        self.ws.send(json.dumps({'type': kind, 'request_id': request_id, **payload}))
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            frame = json.loads(self.ws.recv(timeout=max(.01, deadline - time.monotonic())))
            if frame.get('type') == 'debug_replay_observed':
                self.events.append(frame)
            elif frame.get('type') == kind + '.ack' and frame.get('request_id') == request_id:
                if frame.get('status') != 'ok':
                    raise RuntimeError('M1 mock rejected ' + kind)
                return frame
        raise RuntimeError('M1 mock acknowledgement missing: ' + kind)

    def answer(self, question_id, selections, text, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for event in self.events:
                if event.get('event') == 'prompt.answer.received' and event.get('question_id') == question_id:
                    return event.get('selections') == selections and event.get('text') == text
            frame = json.loads(self.ws.recv(timeout=max(.01, deadline - time.monotonic())))
            if frame.get('type') == 'debug_replay_observed':
                self.events.append(frame)
        return False
