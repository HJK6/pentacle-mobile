"""Transparent, run-owned TCP hop for a real-client disconnect/reconnect walk.

No frame rewriting or injected samples. Only the loopback listener's connections
are interrupted; the production daemon and other consumers are untouched.
"""
from contextlib import AbstractContextManager
import select
import os
import socket
import threading
from pathlib import Path


class LiveConnectionProxy(AbstractContextManager):
    def __init__(self, upstream: tuple[str, int], control: Path):
        self.upstream, self.control = upstream, control
        self.stop = threading.Event()
        # Keep the exclusive descriptor open so an unlinked inode cannot be
        # recycled into a replacement control file during this proxy's life.
        self.control_fd = os.open(control, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(self.control_fd, b'connect\n')
            self.listener = socket.socket()
            self.listener.bind(('127.0.0.1', 0))
            self.listener.listen()
            self.listener.settimeout(.2)
        except BaseException:
            if hasattr(self, 'listener'):
                self.listener.close()
            self._remove_owned_control()
            raise
        self.port = self.listener.getsockname()[1]
        self.threads = []
        self.connections = 0
        self.disconnected = 0
        self.bytes_forwarded = [0, 0]
        self.errors = []

    def _owns_control(self):
        try:
            current, owned = self.control.lstat(), os.fstat(self.control_fd)
            return (current.st_dev, current.st_ino) == (owned.st_dev, owned.st_ino)
        except FileNotFoundError:
            return False

    def _remove_owned_control(self):
        try:
            if self._owns_control():
                self.control.unlink()
        finally:
            os.close(self.control_fd)

    def enabled(self):
        return (not self.stop.is_set() and self._owns_control()
                and self.control.read_text().strip() == 'connect')

    def _relay(self, client):
        peer = None
        try:
            if not self.enabled():
                return
            peer = socket.create_connection(self.upstream, timeout=8)
            client.settimeout(2)
            peer.settimeout(2)
            self.connections += 1
            while self.enabled():
                readable, _, _ = select.select([client, peer], [], [], .1)
                for source in readable:
                    data = source.recv(65536)
                    if not data:
                        return
                    dest, index = (peer, 0) if source is client else (client, 1)
                    dest.sendall(data)
                    self.bytes_forwarded[index] += len(data)
            self.disconnected += 1
        except OSError as exc:
            self.errors.append(type(exc).__name__)
        finally:
            client.close()
            if peer:
                peer.close()

    def _accept(self):
        while not self.stop.is_set():
            try:
                client, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            thread = threading.Thread(target=self._relay, args=(client,), daemon=True)
            self.threads.append(thread)
            thread.start()

    def __enter__(self):
        self.accept_thread = threading.Thread(target=self._accept, daemon=True)
        self.accept_thread.start()
        return self

    def __exit__(self, *args):
        self.stop.set()
        self.listener.close()
        self.accept_thread.join(2)
        for thread in self.threads:
            thread.join(10)
        try:
            if any(t.is_alive() for t in self.threads) or self.accept_thread.is_alive():
                raise RuntimeError('run-owned TCP proxy did not stop')
        finally:
            self._remove_owned_control()
