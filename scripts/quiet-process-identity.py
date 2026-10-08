"""Read actual executable identity and argv for the quiet observer; never read env into output."""
import ctypes
import errno
import json
from pathlib import Path
import re
import subprocess
import sys

libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
libc = ctypes.CDLL(None, use_errno=True)
libproc.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
libproc.proc_pidpath.restype = ctypes.c_int
libc.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint, ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t]
rows = json.loads(Path(sys.argv[1]).read_text())
result = []


def process_args(pid):
    mib = (ctypes.c_int * 3)(1, 49, pid)
    raw = ctypes.create_string_buffer(1024 * 1024)
    length = ctypes.c_size_t(len(raw))
    ctypes.set_errno(0)
    status = libc.sysctl(mib, 3, raw, ctypes.byref(length), None, 0)
    error = ctypes.get_errno()
    if status != 0:
        raise OSError(error, 'KERN_PROCARGS2')
    if length.value < 5 or length.value >= len(raw):
        raise ValueError('invalid argv byte bound')
    data = raw.raw[:length.value]
    argc = int.from_bytes(data[:4], sys.byteorder, signed=True)
    if not 0 < argc <= 8192:
        raise ValueError('invalid argc')
    end = data.index(b'\0', 4)
    executable = data[4:end].decode('utf-8')
    if not executable.startswith('/'):
        raise ValueError('invalid kernel executable path')
    cursor = end + 1
    while cursor < len(data) and data[cursor] == 0:
        cursor += 1
    argv = []
    for _ in range(argc):
        end = data.index(b'\0', cursor)
        argv.append(data[cursor:end].decode('utf-8')); cursor = end + 1
    return executable, argv  # Never decode bytes after the argc entries.


for item in rows:
    pid = item['pid']
    if pid <= 1:
        continue  # Kernel/bootstrap are already in the observer's ancestor exclusion.
    buffer = ctypes.create_string_buffer(4096)
    ctypes.set_errno(0)
    size = libproc.proc_pidpath(pid, buffer, len(buffer))
    error = ctypes.get_errno()
    argv = None
    source = 'proc_pidpath'
    if size <= 0:
        if error == errno.ESRCH:
            result.append({**item, 'exited': True, 'identity_errno': error, 'executable': None, 'argv': []})
            continue
        try:
            executable, argv = process_args(pid)
            source = 'KERN_PROCARGS2 executable prefix'
        except OSError as unavailable:
            result.append({**item, 'exited': unavailable.errno == errno.ESRCH, 'identity_errno': unavailable.errno, 'proc_pidpath_errno': error, 'executable': None, 'argv': []})
            continue
    else:
        executable = buffer.value.decode('utf-8')
        if size >= len(buffer) or not executable.startswith('/'):
            raise ValueError('invalid proc_pidpath result')
    name = Path(executable).name
    if name in {'node', 'xcrun', 'simctl', 'xcodebuild'} or re.fullmatch(r'python(?:\d+(?:\.\d+)*)?', name, re.I):
        try:
            if argv is None:
                _, argv = process_args(pid)
        except OSError as unavailable:
            # The original host observer already uses the system ps reader. It
            # can read another uid where raw procargs refuses; keep this source
            # explicit and bind it to the independently observed executable.
            if unavailable.errno not in {errno.EINVAL, errno.EPERM, errno.EACCES}:
                result.append({**item, 'executable': executable, 'exited': unavailable.errno == errno.ESRCH, 'identity_errno': unavailable.errno, 'argv': None})
                continue
            read = subprocess.run(['/bin/ps', '-ww', '-p', str(pid), '-o', 'args='], capture_output=True, text=True, timeout=1, check=False)
            if read.returncode != 0 or not read.stdout.strip():
                result.append({**item, 'executable': executable, 'exited': False, 'identity_errno': unavailable.errno, 'argv': None})
                continue
            result.append({**item, 'executable': executable, 'executable_source': source, 'argv': None,
                'command_line': read.stdout.strip(), 'argv_source': 'system ps args', 'procargs_errno': unavailable.errno,
                'identity_errno': 0, 'exited': False})
            continue
    else:
        argv = []  # Do not emit a non-tool application's arbitrary brief.
    result.append({**item, 'executable': executable, 'executable_source': source, 'argv': argv, 'identity_errno': 0, 'exited': False})
print(json.dumps(result))
