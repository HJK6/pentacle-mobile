"""Run the installed idb CLI while recording events after client gRPC sends."""
from __future__ import annotations
import os
import hashlib
import json
import time
from pathlib import Path
import sys
from collections import deque
from ._m1_diagnostic_capture import write_events


def main():
    import idb.grpc.client as client
    from idb.cli.main import main as idb_main
    evidence = os.environ.get('M1_DIAGNOSTIC_HID_PATH')
    if not evidence:
        raise RuntimeError('M1_DIAGNOSTIC_HID_PATH required')
    metadata_path = os.environ.get('M1_DIAGNOSTIC_CLIENT_PATH')
    if metadata_path:
        import idb.common.hid as hid
        paths = {'interpreter': sys.executable, 'cli': os.environ.get('M1_DIAGNOSTIC_IDB_CLI', ''),
                 'grpc_client': client.__file__, 'hid_module': hid.__file__}
        identity = {}
        for name, path in paths.items():
            if not path or not Path(path).is_file():
                raise RuntimeError('idb client identity unavailable: ' + name)
            identity[name] = {'path': path, 'sha256': hashlib.sha256(Path(path).read_bytes()).hexdigest()}
        with open(metadata_path, 'a', encoding='utf-8') as output:
            output.write(json.dumps({'wall_ns': time.time_ns(), 'identity': identity}) + '\n')
    pending = deque()
    convert = client.event_to_grpc
    drain = client.drain_to_stream

    def capture_conversion(event):
        wire = convert(event)
        pending.append(event)
        return wire

    async def capture_drain(stream, generator, logger):
        class Proxy:
            async def send_message(self, message):
                if not pending:
                    raise RuntimeError('unmatched HID message')
                event = pending.popleft()
                await stream.send_message(message)
                write_events(evidence, os.environ.get('M1_DIAGNOSTIC_COMMAND', 'unknown'), [event])
            def __getattr__(self, name):
                return getattr(stream, name)
        result = await drain(stream=Proxy(), generator=generator, logger=logger)
        if pending:
            raise RuntimeError('HID event stream ended with unsent messages')
        return result

    client.event_to_grpc = capture_conversion
    client.drain_to_stream = capture_drain
    return idb_main()

if __name__ == '__main__':
    sys.exit(main())
