import socket
import threading
import time
import os
import pytest

from e2e.harness.live_connection_proxy import LiveConnectionProxy


def test_only_owned_connection_is_cut_and_new_connection_recovers(tmp_path):
    server = socket.socket()
    server.bind(('127.0.0.1', 0))
    server.listen()
    server.settimeout(.2)
    stop = threading.Event()

    def echo():
        while not stop.is_set():
            try:
                client, _ = server.accept()
            except socket.timeout:
                continue
            with client:
                client.sendall(client.recv(64))

    worker = threading.Thread(target=echo)
    worker.start()
    control = tmp_path / 'connection'
    try:
        with LiveConnectionProxy(server.getsockname(), control) as proxy:
            def exchange(port):
                with socket.create_connection(('127.0.0.1', port), timeout=2) as client:
                    client.sendall(b'real-unmodified-bytes')
                    return client.recv(64)
            assert exchange(proxy.port) == b'real-unmodified-bytes'
            control.write_text('disconnect\n')
            with socket.create_connection(('127.0.0.1', proxy.port), timeout=2) as client:
                assert client.recv(1) == b''
            assert exchange(server.getsockname()[1]) == b'real-unmodified-bytes'
            control.write_text('connect\n')
            assert exchange(proxy.port) == b'real-unmodified-bytes'
        assert not control.exists()
        assert proxy.connections == 2
    finally:
        stop.set()
        worker.join(2)
        server.close()


def test_preexisting_control_is_never_overwritten(tmp_path):
    control = tmp_path / 'connection'
    control.write_text('another owner\n')
    identity = control.stat().st_ino
    with pytest.raises(FileExistsError):
        LiveConnectionProxy(('127.0.0.1', 1), control)
    assert control.read_text() == 'another owner\n'
    assert control.stat().st_ino == identity


def test_replacement_control_survives_proxy_shutdown(tmp_path):
    control = tmp_path / 'connection'
    with LiveConnectionProxy(('127.0.0.1', 1), control) as proxy:
        descriptor = proxy.control_fd
        control.unlink()
        control.write_text('replacement owner\n')
        assert not proxy.enabled()
    assert control.read_text() == 'replacement owner\n'
    assert not proxy.accept_thread.is_alive()
    assert proxy.listener.fileno() == -1
    with pytest.raises(OSError):
        os.fstat(descriptor)


def test_listener_setup_failure_removes_only_owned_control(tmp_path, monkeypatch):
    control = tmp_path / 'connection'
    def refuse_socket():
        raise OSError('synthetic listener allocation failure')
    monkeypatch.setattr(socket, 'socket', refuse_socket)
    with pytest.raises(OSError, match='synthetic listener'):
        LiveConnectionProxy(('127.0.0.1', 1), control)
    assert not control.exists()
