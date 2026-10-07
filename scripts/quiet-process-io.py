"""Diagnostic disk-byte counters; unavailable or reused identities receive no attribution."""
import ctypes
import hashlib
import json
from pathlib import Path
import time

ROOT = Path(__file__).resolve().parent.parent
producer = ROOT / 'scripts/gate-process-cpu.py'
source = producer.read_bytes()
namespace = {'__name__': 'public_cpu_diagnostic', '__file__': str(producer)}
exec(compile(source, str(producer), 'exec'), namespace)
Native, ProcessGone, fresh_call = (namespace[name] for name in ['Native', 'ProcessGone', 'fresh_call'])
native = Native()
started_wall, started_mono = time.time(), time.monotonic()
pids = native.pids()
rows = []
for pid in pids:
    row = {'pid': pid}
    try:
        before, before_errno = native.usage(pid, strict=True)
        first = native.metadata(pid)
        buffer = ctypes.create_string_buffer(4096)
        path_size, path_errno = fresh_call(native.library.proc_pidpath, pid, buffer, len(buffer))
        executable = buffer.value.decode('utf-8', 'surrogateescape') if 0 < path_size < len(buffer) else None
        last = native.metadata(pid)
        after, after_errno = native.usage(pid, strict=True)
        row.update(first)
        row.update(executable=executable, executable_errno=path_errno,
                   before_errno=before_errno, after_errno=after_errno)
        if first != last:
            row['status'] = 'METADATA_CHANGED_NO_ATTRIBUTION'
        elif before is None or after is None:
            row['status'] = 'COUNTERS_UNAVAILABLE_NO_ATTRIBUTION'
        elif not before.start or before.start != after.start:
            row['status'] = 'BIRTH_CHANGED_NO_ATTRIBUTION'
        elif after.read < before.read or after.write < before.write:
            row['status'] = 'COUNTERS_REGRESSED_NO_ATTRIBUTION'
        else:
            row.update(status='OBSERVED', birth=str(after.start),
                       disk_read_bytes=int(after.read), disk_write_bytes=int(after.write))
    except ProcessGone:
        row['status'] = 'EXITED_NO_ATTRIBUTION'
    except Exception as error:
        row.update(status='UNAVAILABLE_NO_ATTRIBUTION', error=str(error))
    rows.append(row)
print(json.dumps({
    'schema': 1, 'scope': 'UNCERTIFIED diagnostic process I/O; no acceptance predicate change',
    'producer_sha256': hashlib.sha256(source).hexdigest(),
    'collector_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    'started_epoch': started_wall, 'finished_epoch': time.time(),
    'elapsed_ms': (time.monotonic() - started_mono) * 1000,
    'counters': 'Public SDK rusage_info_v2 ri_diskio_bytesread/ri_diskio_byteswritten',
    'limitations': ['Permission-denied/exit/reuse rows remain explicit and receive no delta.',
                    'Process disk-byte counters do not partition physical device TPS.'],
    'pid_count': len(pids), 'rows': rows,
}))
