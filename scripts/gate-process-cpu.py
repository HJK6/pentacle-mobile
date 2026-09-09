"""Read CPU counters without the signed ps shim's zero-valued task times."""
import ctypes
import json
import os
import time
import sys


class Usage(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_ubyte * 16)] + [
        (name, ctypes.c_uint64) for name in (
            "user", "system", "pkg", "interrupt", "pageins", "wired", "resident",
            "footprint", "start", "exit", "child_user", "child_system", "child_pkg",
            "child_interrupt", "child_pageins", "child_elapsed", "read", "write",
        )
    ]


class Timebase(ctypes.Structure):
    _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]


library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
library.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
timebase = Timebase()
if ctypes.CDLL("/usr/lib/libSystem.B.dylib").mach_timebase_info(ctypes.byref(timebase)) != 0 or not timebase.denom:
    raise RuntimeError("CPU_TIMEBASE_UNAVAILABLE")
with open(sys.argv[1]) as source:
    rows = json.load(source)
for row in rows:
    usage = Usage()
    if library.proc_pid_rusage(row["pid"], 2, ctypes.byref(usage)) == 0:
        row.update(cpuSeconds=(usage.user + usage.system) * timebase.numer / timebase.denom / 1e9,
                   start=str(usage.start), cpuProbeErrno=0)
    else:
        row.update(cpuSeconds=None, cpuProbeErrno=ctypes.get_errno())
system = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
system.mach_host_self.restype = ctypes.c_uint32
ticks = (ctypes.c_uint32 * 4)()
count = ctypes.c_uint32(4)
if system.host_statistics(system.mach_host_self(), 3, ctypes.byref(ticks), ctypes.byref(count)) != 0 or count.value != 4:
    raise RuntimeError("CPU_HOST_COUNTER_UNAVAILABLE")
json.dump({"rows": rows, "cpuTicks": {"total": sum(ticks), "idle": ticks[2], "count": os.cpu_count()}, "monotonicMs": time.monotonic() * 1000}, sys.stdout)
