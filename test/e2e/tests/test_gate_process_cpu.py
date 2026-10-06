"""Native-boundary controls using the compiled public SDK's byte layouts."""
import ctypes
import errno
import importlib.util
import json
from pathlib import Path
import struct
import tempfile

import pytest

SOURCE = Path(__file__).resolve().parents[3] / "scripts/gate-process-cpu.py"
spec = importlib.util.spec_from_file_location("gate_process_cpu", SOURCE)
cpu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cpu)


class Function:
    def __init__(self, callback):
        self.callback = callback

    def __call__(self, *args):
        return self.callback(*args)


class Boundary:
    def __init__(self):
        self.ids = [0, 20, 30, 40, 50, 60]
        self.needed = None
        self.list_plan = []
        self.meta_plan = {}
        self.usage_plan = {}
        self.usage_calls = {}
        self.events = []
        self.path = b"/runtime/launchd_sim"
        self.path_size = None
        self.path_errno = 0
        self.proc_listpids = Function(self.listpids)
        self.proc_pidinfo = Function(self.metadata)
        self.proc_pid_rusage = Function(self.usage)
        self.proc_pidpath = Function(self.pidpath)
        self.mach_timebase_info = Function(self.timebase)
        self.mach_host_self = Function(lambda: 1)
        self.host_statistics = Function(self.ticks)

    def native(self):
        return cpu.Native(self, self)

    def listpids(self, flavor, typeinfo, buffer, size):
        assert (flavor, typeinfo) == (1, 0)
        if buffer is None:
            return self.needed if self.needed is not None else len(self.ids) * 4
        if self.list_plan:
            action = self.list_plan.pop(0)
            ids, result = (list(range(size // 4)), size) if action == "full" else action
        else:
            ids, result = self.ids, len(self.ids) * 4
        for index, pid in enumerate(ids[:size // 4]):
            buffer[index] = pid
        return result

    def metadata(self, pid, flavor, arg, pointer, size):
        assert (flavor, arg, size) == (13, 0, 64)
        self.events.append(("metadata", pid))
        values = {"pid": pid, "ppid": 20 if pid in (30, 50) else 0 if pid == 0 else 1,
                  "pgid": 0 if pid == 0 else 20, "command": b"kernel_task" if pid == 0 else b"worker"}
        changes, result, error = self.meta_plan.get(pid, []).pop(0) if self.meta_plan.get(pid) else ({}, 64, 0)
        values.update(changes)
        if error is not None:
            ctypes.set_errno(error)
        raw = struct.pack("<4I16s8I", values["pid"], values["ppid"], values["pgid"], 2,
                          values["command"], *([0] * 8))
        ctypes.memmove(pointer, raw, 64)
        return result

    def usage(self, pid, flavor, pointer):
        assert flavor == 2
        self.events.append(("usage", pid))
        number = self.usage_calls.get(pid, 0)
        self.usage_calls[pid] = number + 1
        default = (pid * 100 + 1, (10 + number) * 10**9, 3 * 10**9, 0, 0)
        if pid in (0, 60):
            default = (0, 0, 0, -1, errno.EPERM)
        birth, user, system, status, error = self.usage_plan.get(pid, []).pop(0) if self.usage_plan.get(pid) else default
        if error is not None:
            ctypes.set_errno(error)
        fields = [0] * 18
        fields[0], fields[1], fields[8] = user, system, birth
        ctypes.memmove(pointer, struct.pack("<16s18Q", b"", *fields), 160)
        return status

    def pidpath(self, pid, pointer, size):
        assert (pid, size) == (40, 4096)
        self.events.append(("path", pid))
        ctypes.memmove(pointer, self.path, min(len(self.path), size))
        ctypes.set_errno(self.path_errno)
        return len(self.path) if self.path_size is None else self.path_size

    @staticmethod
    def timebase(pointer):
        ctypes.memmove(pointer, struct.pack("<2I", 1, 1), 8)
        return 0

    @staticmethod
    def ticks(host, flavor, pointer, count):
        assert (host, flavor) == (1, 3)
        ctypes.memmove(pointer, struct.pack("<4I", 10, 20, 30, 40), 16)
        return 0


def collect(boundary):
    return cpu.complete_census(boundary.native(), 20, 30, 40)


def denied(error=errno.EPERM):
    return (0, 0, 0, -1, error)


def successful(birth=5001, user=10**9, system=10**9):
    return (birth, user, system, 0, 0)


def test_complete_census_retains_actual_pid0_and_permission_restricted_foreign_rows():
    b = Boundary()
    output = collect(b)
    assert [r["pid"] for r in output["rows"]] == b.ids
    for pid in (0, 60):
        row = next(r for r in output["rows"] if r["pid"] == pid)
        assert row["start"] is None and row["cpuSeconds"] is None and row["cpuProbeErrno"] == errno.EPERM
    simulator = next(r for r in output["rows"] if r["pid"] == 40)
    assert simulator["command"] == "/runtime/launchd_sim" and simulator["start"] == "4001"
    assert [kind for kind, pid in b.events if pid == 40] == ["usage", "metadata", "path", "metadata", "usage"]
    assert output["exitedPids"] == [] and output["cpuTicks"]["idle"] == 30


@pytest.mark.parametrize("ids,result", [([0, 20, 20], 12), ([0, 0, 20], 12), ([0, -1], 8),
    ([0, 0x80000000], 8), ([0], 0), ([0], -4), ([0], 3), ([0], 10**7)])
def test_raw_pid_duplicates_invalid_ids_and_byte_bounds_reject(ids, result):
    b = Boundary()
    b.list_plan = [(ids, result)]
    with pytest.raises(RuntimeError, match="CPU_CENSUS_"):
        b.native().pids()


@pytest.mark.parametrize("needed", [0, -4, 3, 400004])
def test_invalid_initial_capacity_rejects(needed):
    b = Boundary()
    b.needed = needed
    with pytest.raises(RuntimeError, match="CPU_CENSUS_SIZE_INVALID"):
        b.native().pids()


def test_full_buffer_grows_and_only_complete_raw_membership_succeeds():
    b = Boundary()
    b.list_plan = ["full", ([60, 0, 40, 20, 30, 50], 24)]
    assert b.native().pids() == b.ids


@pytest.mark.parametrize("needed", [24, 400000])
def test_truncation_and_capacity_retry_exhaustion_fail(needed):
    b = Boundary()
    b.needed, b.list_plan = needed, ["full"] * 4
    with pytest.raises(RuntimeError, match="CPU_CENSUS_TRUNCATED"):
        b.native().pids()


def test_missing_pid0_or_required_root_fails():
    for missing in (0, 20, 30, 40):
        b = Boundary()
        b.ids.remove(missing)
        with pytest.raises(RuntimeError, match="CPU_CENSUS_KERNEL_PID_MISSING|CPU_REQUIRED_ROOT_MISSING"):
            collect(b)


@pytest.mark.parametrize("size,error", [(0, None), (0, errno.EPERM), (0, errno.EACCES),
    (0, errno.EINVAL), (32, errno.ESRCH), (68, 0)])
def test_fresh_errno_permission_unknown_or_short_metadata_cannot_omit_a_row(size, error):
    b = Boundary()
    b.meta_plan[50] = [({}, size, error)]
    ctypes.set_errno(errno.ESRCH)  # Failed call leaving errno untouched must not reuse this.
    with pytest.raises(RuntimeError, match="CPU_METADATA_UNAVAILABLE"):
        collect(b)


@pytest.mark.parametrize("changes", [{"pid": 77}, {"ppid": 0xffffffff}, {"pgid": 0xffffffff}])
def test_metadata_identity_and_parent_group_bounds_fail(changes):
    b = Boundary()
    b.meta_plan[50] = [(changes, 64, 0)]
    with pytest.raises(RuntimeError, match="CPU_METADATA_IDENTITY_INVALID"):
        collect(b)


@pytest.mark.parametrize("changes", [{"ppid": 1}, {"pgid": 77}, {"command": b"new executable"}])
def test_ancestry_group_or_command_drift_fails(changes):
    b = Boundary()
    b.meta_plan[50] = [({}, 64, 0), (changes, 64, 0)]
    with pytest.raises(RuntimeError, match="CPU_METADATA_CHANGED"):
        collect(b)


@pytest.mark.parametrize("stage", ["usage_before", "metadata_before", "metadata_after", "usage_after"])
def test_fresh_esrch_ordinary_exit_is_explicit_and_conservative(stage):
    b = Boundary()
    if stage.startswith("usage"):
        b.usage_plan[50] = ([successful()] if stage.endswith("after") else []) + [denied(errno.ESRCH)]
    else:
        b.meta_plan[50] = ([({}, 64, 0)] if stage.endswith("after") else []) + [({}, 0, errno.ESRCH)]
    output = collect(b)
    assert 50 not in [r["pid"] for r in output["rows"]]
    assert output["exitedPids"] == [{"pid": 50, "errno": errno.ESRCH}]


@pytest.mark.parametrize("pid", [0, 20, 30, 40])
@pytest.mark.parametrize("stage", ["usage_before", "metadata_before", "metadata_after", "usage_after"])
def test_required_root_or_pid0_disappearance_fails(pid, stage):
    b = Boundary()
    if stage.startswith("usage"):
        first = denied() if pid == 0 else successful()
        b.usage_plan[pid] = ([first] if stage.endswith("after") else []) + [denied(errno.ESRCH)]
    else:
        b.meta_plan[pid] = ([({}, 64, 0)] if stage.endswith("after") else []) + [({}, 0, errno.ESRCH)]
    with pytest.raises(RuntimeError, match="CPU_REQUIRED_ROOT_DISAPPEARED"):
        collect(b)


@pytest.mark.parametrize("pid", [20, 30, 40])
@pytest.mark.parametrize("error", [errno.EPERM, errno.EACCES])
def test_permission_restricted_required_root_counter_fails(pid, error):
    b = Boundary()
    b.usage_plan[pid] = [denied(error), denied(error)]
    with pytest.raises(RuntimeError, match="CPU_ROOT_COUNTER_UNAVAILABLE"):
        collect(b)


@pytest.mark.parametrize("error", [errno.EPERM, errno.EACCES])
@pytest.mark.parametrize("order", ["success_then_denied", "denied_then_success"])
def test_nonrequired_mixed_rusage_success_and_permission_denial_rejects_in_both_orders(error, order):
    b = Boundary()
    pair = [successful(), denied(error)]
    b.usage_plan[50] = pair if order == "success_then_denied" else pair[::-1]
    with pytest.raises(RuntimeError, match="CPU_COUNTER_PAIR_MIXED"):
        collect(b)


@pytest.mark.parametrize("error", [0, errno.EINVAL, errno.EIO])
def test_nonrequired_unknown_rusage_errno_rejects_complete_census(error):
    b = Boundary()
    b.usage_plan[60] = [denied(error), denied(error)]
    with pytest.raises(RuntimeError, match="CPU_COUNTER_UNAVAILABLE"):
        collect(b)


def test_nonrequired_unknown_rusage_return_code_cannot_be_a_permission_exception():
    b = Boundary()
    b.usage_plan[60] = [(0, 0, 0, 1, errno.EPERM)]
    with pytest.raises(RuntimeError, match="CPU_COUNTER_CALL_INVALID"):
        collect(b)


@pytest.mark.parametrize("before,after,expected", [
    (successful(), successful(birth=777), "CPU_PROCESS_BIRTH_CHANGED"),
    (successful(birth=0), successful(birth=0), "CPU_PROCESS_BIRTH_CHANGED"),
    (successful(), successful(user=0), "CPU_COUNTER_REGRESSED"),
    (successful(), successful(system=0), "CPU_COUNTER_REGRESSED"),
])
def test_birth_reuse_zero_identity_or_counter_regression_fails(before, after, expected):
    b = Boundary()
    b.usage_plan[50] = [before, after]
    with pytest.raises(RuntimeError, match=expected):
        collect(b)


@pytest.mark.parametrize("path,size,error", [(b"/runtime/launchd_sim_extra", None, 0),
    (b"launchd_sim", None, 0), (b"/runtime/launchd_si", None, 0), (b"", 0, 0),
    (b"/runtime/launchd_sim\0spoof", None, 0), (b"x" * 4096, 4096, 0),
    (b"/runtime/launchd_sim", 5, 0), (b"", 0, errno.EPERM)])
def test_missing_prefix_unknown_or_truncated_complete_simulator_identity_fails(path, size, error):
    b = Boundary()
    b.path, b.path_size, b.path_errno = path, size, error
    with pytest.raises(RuntimeError, match="CPU_SIMULATOR_"):
        collect(b)


def test_simulator_path_fresh_esrch_is_a_required_root_failure():
    b = Boundary()
    b.path, b.path_size, b.path_errno = b"", 0, errno.ESRCH
    with pytest.raises(RuntimeError, match="CPU_REQUIRED_ROOT_DISAPPEARED"):
        collect(b)


def test_actual_legacy_json_cli_preserves_unavailable_rows_and_cleans_input(capsys):
    b = Boundary()
    with tempfile.TemporaryDirectory() as directory:
        file = Path(directory) / "pids.json"
        file.write_text(json.dumps([{"pid": 0, "start": "supplied legacy birth", "command": "kernel_task"},
                                    {"pid": 50, "start": "supplied self birth", "command": "worker"}]))
        assert cpu.main([str(file)], native=b.native()) == 0
        output = json.loads(capsys.readouterr().out)
        assert output["rows"][0]["start"] == "supplied legacy birth"
        assert output["rows"][0]["cpuSeconds"] is None and output["rows"][0]["cpuProbeErrno"] == errno.EPERM
        assert output["rows"][1]["start"] == "5001" and output["rows"][1]["cpuSeconds"] == 13
    assert not file.exists() and not Path(directory).exists()


@pytest.mark.parametrize("args", [[], ["--complete-census"], ["file.json", "--complete-census"],
    ["--complete-census", "--owner-pid", "0"], ["--complete-census", "--owner-pid", "-2"],
    ["--complete-census", "--owner-pid", "2147483648"], ["file.json", "--probe-pid", "30"]])
def test_malformed_or_mixed_cli_identity_arguments_fail_before_native_collection(args):
    with pytest.raises(SystemExit) as error:
        cpu.main(args, native=Boundary().native())
    assert error.value.code == 2
