import socket
import threading
import time

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
