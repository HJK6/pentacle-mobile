"""Read Darwin CPU counters, with a complete kernel census or legacy JSON input."""
import argparse
import ctypes
import errno
import json
import os
import sys
import time


class Usage(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_ubyte * 16)] + [
        (name, ctypes.c_uint64) for name in (
            "user", "system", "pkg", "interrupt", "pageins", "wired", "resident",
            "footprint", "start", "exit", "child_user", "child_system", "child_pkg",
            "child_interrupt", "child_pageins", "child_elapsed", "read", "write",
        )
    ]


class ShortInfo(ctypes.Structure):
    # Public SDK proc_bsdshortinfo (PROC_PIDT_SHORTBSDINFO), including PID0.
    _fields_ = [(name, ctypes.c_uint32) for name in ("pid", "ppid", "pgid", "status")] + [
        ("comm", ctypes.c_char * 16)
    ] + [(name, ctypes.c_uint32) for name in (
        "flags", "uid", "gid", "ruid", "rgid", "svuid", "svgid", "reserved",
    )]


class Timebase(ctypes.Structure):
    _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]


class ProcessGone(Exception):
    pass


def fresh_call(function, *args):
    ctypes.set_errno(0)
    result = function(*args)
    return result, ctypes.get_errno()


class Native:
    def __init__(self, library=None, system=None):
        self.library = library or ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        self.system = system or ctypes.CDLL("/usr/lib/libSystem.B.dylib")
        for name, signature in {
            "proc_listpids": [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int],
            "proc_pidinfo": [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int],
            "proc_pid_rusage": [ctypes.c_int, ctypes.c_int, ctypes.c_void_p],
            "proc_pidpath": [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32],
        }.items():
            function = getattr(self.library, name)
            function.argtypes, function.restype = signature, ctypes.c_int
        self.system.mach_host_self.restype = ctypes.c_uint32
        base = Timebase()
        if self.system.mach_timebase_info(ctypes.byref(base)) != 0 or not base.denom:
            raise RuntimeError("CPU_TIMEBASE_UNAVAILABLE")
        self.scale = base.numer / base.denom / 1e9

    def pids(self):
        width = ctypes.sizeof(ctypes.c_int)
        maximum = 100000
        needed, error = fresh_call(self.library.proc_listpids, 1, 0, None, 0)
        if not isinstance(needed, int) or needed <= 0 or needed % width or needed > maximum * width:
            raise RuntimeError(f"CPU_CENSUS_SIZE_INVALID:{needed}:{error}")
        capacity = min(maximum, needed // width + 1024)
        # The unchanged caller deadline encloses all calls and bounded growth.
        for _ in range(4):
            array = (ctypes.c_int * capacity)()
            size = ctypes.sizeof(array)
            received, error = fresh_call(self.library.proc_listpids, 1, 0, array, size)
            if not isinstance(received, int) or received <= 0 or received > size or received % width:
                raise RuntimeError(f"CPU_CENSUS_BYTES_INVALID:{received}:{size}:{error}")
            raw = list(array[:received // width])
            # Validate raw IDs; sorting must never hide duplicates.
            if any(pid < 0 for pid in raw) or len(set(raw)) != len(raw):
                raise RuntimeError("CPU_CENSUS_PID_INVALID_OR_DUPLICATE")
            if received < size:
                if 0 not in raw:
                    raise RuntimeError("CPU_CENSUS_KERNEL_PID_MISSING")
                return sorted(raw)
            if capacity == maximum:
                break
            capacity = min(maximum, capacity * 2)
        raise RuntimeError("CPU_CENSUS_TRUNCATED")

    def metadata(self, pid):
        info = ShortInfo()
        size, error = fresh_call(self.library.proc_pidinfo, pid, 13, 0, ctypes.byref(info), ctypes.sizeof(info))
        if size <= 0 and error == errno.ESRCH:
            raise ProcessGone(pid)
        if size != ctypes.sizeof(info):
            raise RuntimeError(f"CPU_METADATA_UNAVAILABLE:{pid}:{size}:{error}")
        if info.pid != pid or info.ppid > 0x7fffffff or info.pgid > 0x7fffffff:
            raise RuntimeError(f"CPU_METADATA_IDENTITY_INVALID:{pid}")
        return {"pid": pid, "ppid": int(info.ppid), "pgid": int(info.pgid),
                "command": bytes(info.comm).decode("utf-8", "surrogateescape")}

    def usage(self, pid, strict=False):
        value = Usage()
        status, error = fresh_call(self.library.proc_pid_rusage, pid, 2, ctypes.byref(value))
        if strict and status not in (0, -1):
            raise RuntimeError(f"CPU_COUNTER_CALL_INVALID:{pid}:{status}:{error}")
        return (value, 0) if status == 0 else (None, error)

    def simulator_path(self, pid):
        buffer = ctypes.create_string_buffer(4096)  # Public PROC_PIDPATHINFO_MAXSIZE.
        size, error = fresh_call(self.library.proc_pidpath, pid, buffer, len(buffer))
        if size <= 0 and error == errno.ESRCH:
            raise ProcessGone(pid)
        if not 0 < size < len(buffer) or len(buffer.value) != size:
            raise RuntimeError(f"CPU_SIMULATOR_PATH_UNAVAILABLE:{pid}:{size}:{error}")
        value = buffer.value.decode("utf-8", "strict")
        if not os.path.isabs(value) or os.path.basename(value) != "launchd_sim":
            raise RuntimeError(f"CPU_SIMULATOR_IDENTITY_INVALID:{pid}")
        return value

    def ticks(self):
        ticks = (ctypes.c_uint32 * 4)()
        count = ctypes.c_uint32(4)
        if self.system.host_statistics(self.system.mach_host_self(), 3, ctypes.byref(ticks), ctypes.byref(count)) != 0 or count.value != 4:
            raise RuntimeError("CPU_HOST_COUNTER_UNAVAILABLE")
        return {"total": sum(ticks), "idle": ticks[2], "count": os.cpu_count()}


def complete_census(native, owner_pid, probe_pid, simulator_pid):
    roots = {owner_pid, probe_pid, simulator_pid}
    pids = native.pids()
    if not roots.issubset(pids):
        raise RuntimeError("CPU_REQUIRED_ROOT_MISSING")
    rows, exited = [], []
    for pid in pids:
        try:
            before, before_error = native.usage(pid, strict=True)
            if before is None and before_error == errno.ESRCH:
                raise ProcessGone(pid)
            first = native.metadata(pid)
            command = native.simulator_path(pid) if pid == simulator_pid else first["command"]
            last = native.metadata(pid)
            after, after_error = native.usage(pid, strict=True)
            if after is None and after_error == errno.ESRCH:
                raise ProcessGone(pid)
        except ProcessGone:
            if pid in roots or pid == 0:
                raise RuntimeError(f"CPU_REQUIRED_ROOT_DISAPPEARED:{pid}")
            exited.append({"pid": pid, "errno": errno.ESRCH})
            continue
        if first != last:
            raise RuntimeError(f"CPU_METADATA_CHANGED:{pid}")
        if (before is None) != (after is None):
            raise RuntimeError(f"CPU_COUNTER_PAIR_MIXED:{pid}")
        if before is None:
            if before_error not in (errno.EPERM, errno.EACCES) or after_error not in (errno.EPERM, errno.EACCES):
                raise RuntimeError(f"CPU_COUNTER_UNAVAILABLE:{pid}:{before_error}:{after_error}")
            if pid in roots:
                raise RuntimeError(f"CPU_ROOT_COUNTER_UNAVAILABLE:{pid}:{after_error}")
            # Explicit foreign permission row; no invented birth or CPU credit.
            row = {**first, "start": None, "cpuSeconds": None, "cpuProbeErrno": after_error}
        else:
            if not before.start or before.start != after.start:
                raise RuntimeError(f"CPU_PROCESS_BIRTH_CHANGED:{pid}")
            if after.user < before.user or after.system < before.system:
                raise RuntimeError(f"CPU_COUNTER_REGRESSED:{pid}")
            row = {**first, "start": str(after.start),
                   "cpuSeconds": (after.user + after.system) * native.scale, "cpuProbeErrno": 0}
        row["command"] = command
        rows.append(row)
    return {"rows": rows, "exitedPids": exited, "cpuTicks": native.ticks(), "monotonicMs": time.monotonic() * 1000}


def legacy_census(native, file):
    with open(file) as source:
        rows = json.load(source)
    for row in rows:
        usage, error = native.usage(row["pid"])
        if usage is not None:
            row.update(cpuSeconds=(usage.user + usage.system) * native.scale, start=str(usage.start), cpuProbeErrno=0)
        else:
            row.update(cpuSeconds=None, cpuProbeErrno=error)
    return {"rows": rows, "cpuTicks": native.ticks(), "monotonicMs": time.monotonic() * 1000}


def root_pid(value):
    if not value.isdecimal() or not 1 < int(value) <= 0x7fffffff:
        raise argparse.ArgumentTypeError("required root must be a positive process PID")
    return int(value)


def main(args=None, native=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?")
    parser.add_argument("--complete-census", action="store_true")
    for role in ("owner", "probe", "simulator"):
        parser.add_argument(f"--{role}-pid", type=root_pid)
    options = parser.parse_args(args)
    roots = (options.owner_pid, options.probe_pid, options.simulator_pid)
    if options.complete_census:
        if options.input or None in roots:
            parser.error("complete census requires exactly the three root identities and no input file")
    elif not options.input or any(pid is not None for pid in roots):
        parser.error("legacy census requires only a JSON input file")
    native = native or Native()
    result = complete_census(native, *roots) if options.complete_census else legacy_census(native, options.input)
    json.dump(result, sys.stdout)
    return 0


if __name__ == "__main__":
    main()
