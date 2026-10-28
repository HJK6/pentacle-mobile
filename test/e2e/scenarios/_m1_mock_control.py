"""Control only an explicitly bound loopback scripted mock."""
from __future__ import annotations

import json
import time
import uuid
from urllib.parse import urlsplit
from websockets.sync.client import connect

ASSISTANT_STREAM = 'home:assistant'
SESSION_CONTRACT = {
    'home:assistant': ('assistant-composite-v1', 'assistant_composite', 'Synthetic assistant'),
    'mock-host:mock-session': ('parent-generation', 'nexus', 'Assistant history fixture'),
    'mock-host:control-session': ('control-generation', 'worker', 'Non-Nexus control'),
    'mock-host:childless': ('childless-generation', 'nexus', 'Childless Nexus'),
    'mock-host:card-control': ('card-control-generation', 'worker', 'Non-Nexus card control'),
}


def validate_baseline(snapshot, history, clients):
    """Reject unknown attention and identity instead of manufacturing an empty baseline."""
    sessions = snapshot.get('sessions')
    if not isinstance(sessions, list) or len(sessions) != len(SESSION_CONTRACT):
        raise RuntimeError('M1 requires exact five-summary inventory')
    ids = [s.get('stream_id') for s in sessions if isinstance(s, dict)]
    if len(ids) != 5 or len(set(ids)) != 5 or set(ids) != set(SESSION_CONTRACT):
        raise RuntimeError('M1 summary identity absent, duplicate or wrong')
    for s in sessions:
        generation, role, title = SESSION_CONTRACT[s['stream_id']]
        if (s.get('session_generation'), s.get('role'), s.get('title')) != (generation, role, title):
            raise RuntimeError('M1 summary generation/role/title mismatch')
        if (s.get('host') != 'mock-host' or s.get('session_name') != s['stream_id'].split(':')[-1]
                or s.get('provider') != ('composite' if s['stream_id'] == ASSISTANT_STREAM else 'codex')):
            raise RuntimeError('M1 summary serving identity mismatch')
        if s.get('question') is not None:
            raise RuntimeError('M1 legacy question prevents zero-attention baseline')
    assistant = next(s for s in sessions if s['stream_id'] == ASSISTANT_STREAM)
    if (assistant.get('provider') != 'composite' or assistant.get('session_kind') != 'assistant_composite'
            or assistant.get('bootstrap_state') != 'ready' or assistant.get('visibility') != 'visible'
            or assistant.get('session_name') != 'assistant'
            or assistant.get('capabilities') != {'pane': False, 'terminal': False,
                'assistant_composite_v1': True, 'reply_metadata_v1': True}):
        raise RuntimeError('M1 configured assistant is not ready')
    if snapshot.get('notifications') != []:
        raise RuntimeError('M1 open or unknown attention prevents drawer navigation')
    if not isinstance(clients, dict) or clients.get('pentacle-mobile') != 1:
        raise RuntimeError('M1 requires actual unique mobile registration')
    events = history.get('events')
    if (history.get('type') != 'request_stream_events.ok' or history.get('stream_id') != ASSISTANT_STREAM
            or history.get('complete') is not True or not isinstance(events, list) or len(events) != 1):
        raise RuntimeError('M1 assistant history incomplete or ambiguous')
    event = events[0]
    if (event.get('stream_id') != ASSISTANT_STREAM or event.get('session_id') != ASSISTANT_STREAM
            or event.get('kind') != 'ASSIST_TEXT' or event.get('text') != 'Synthetic assistant home ready.'
            or event.get('daemon_seq') != 39 or event.get('raw', {}).get('session_name') != 'assistant'):
        raise RuntimeError('M1 assistant history identity/content mismatch')
    return {s['stream_id']: s for s in sessions}


class MockControl:
    def __init__(self, url):
        parsed = urlsplit(url)
        if parsed.scheme != 'ws' or parsed.hostname != '127.0.0.1' or not parsed.port or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
            raise ValueError('M1 control requires an explicit loopback mock URL')
        self.url = url
        self.ws = connect(url, open_timeout=5, max_size=None)
        self.events = []
        self.last_notification = None
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

    def verify_baseline(self):
        # A separate non-RPC observer reads authoritative state; no debug/config
        # or mobile-identity frames are sent on this connection.
        with connect(self.url, open_timeout=5, max_size=None) as observer:
            if json.loads(observer.recv(timeout=5)).get('type') != 'welcome':
                raise RuntimeError('M1 read-only observer welcome missing')
            observer.send(json.dumps({'type': 'hello', 'client': 'harness',
                                      'subscribe': {'snapshot': True, 'events_mode': 'none'}}))
            snapshot, hello_seen = None, False
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                frame = json.loads(observer.recv(timeout=max(.01, deadline-time.monotonic())))
                if frame.get('type') == 'hello':
                    hello_seen = True
                if frame.get('type') == 'snapshot':
                    if not hello_seen:
                        raise RuntimeError('M1 read-only observer hello missing')
                    snapshot = frame
                    break
            if snapshot is None:
                raise RuntimeError('M1 read-only snapshot missing')
            def read(kind, **payload):
                request_id = uuid.uuid4().hex
                observer.send(json.dumps({'type': kind, 'request_id': request_id, **payload}))
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    frame = json.loads(observer.recv(timeout=max(.01, deadline-time.monotonic())))
                    if frame.get('request_id') == request_id:
                        return frame
                raise RuntimeError('M1 read-only response missing: ' + kind)
            stats = read('daemon.stats')
            if stats.get('type') != 'daemon.stats.ok':
                raise RuntimeError('M1 mobile registration inventory missing')
            history = read('request_stream_events', stream_id=ASSISTANT_STREAM, limit=25)
            self.baseline = validate_baseline(snapshot, history, stats.get('stats', {}).get('clients'))
            self.observation = {'snapshot': snapshot, 'history': history, 'clients': stats['stats']['clients']}
            return self.baseline

    def rpc(self, kind, **payload):
        request_id = uuid.uuid4().hex
        if kind == 'debug_replay_notification':
            self.last_notification = payload.get('notification')
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
