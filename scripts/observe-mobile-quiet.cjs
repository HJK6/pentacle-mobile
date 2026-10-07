"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnOwned, runOwnedSync } = require("./owned-process.cjs");
const ROOT = path.resolve(__dirname, "..");
const os = require("node:os");
const cp = require("node:child_process");
const { POLICY, canonical } = require("./certified-start-receipt.cjs");
const TARGET = cp.execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const windowPath = process.argv[2];
if (!windowPath || !path.isAbsolute(windowPath) || !process.argv[3] || !path.isAbsolute(process.argv[3])) throw new Error("QUIET_OBSERVER_INPUT_REQUIRED");
const window = JSON.parse(fs.readFileSync(windowPath, "utf8"));
if (window.candidate_sha !== TARGET || window.fd_go !== true || typeof window.from_stream !== "string" || !window.from_stream || !window.tell_id)
  throw new Error("FRESH_FD_WINDOW_GO_REQUIRED");
if (Date.now() / 1000 >= window.expires_epoch) throw new Error("FD_WINDOW_EXPIRED");
const A = process.argv[3];
fs.mkdirSync(A, { recursive: false });
fs.copyFileSync(windowPath, path.join(A, "fd-window.json"), fs.constants.COPYFILE_EXCL);
const receipt = { schema: 2, policy_revision: POLICY.revision, host: os.hostname(), uid: process.getuid(), attempt_id: window.attempt_id, gate_code_sha: TARGET, certification: "UNCERTIFIED", native_certification: false, candidate_sha: TARGET, authority: "Fresh FD closing-window grant required; executable-aware F6 adapter; unchanged quietness thresholds/cadence/bounds; read-only observation, no certification", observer_pid: process.pid,
  observer_sha256: crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex"), started_at: new Date().toISOString(),
  scope: "pre-run quiet-window observation only; production policy/bounds unchanged", required_median_disk_tps_below: 2000, required_peak_disk_tps_at_most: 10000,
  required_observation_seconds: 60, process_checks: [], simulator_checks: [], disk_intervals: [], ready: false };
const write = () => fs.writeFileSync(path.join(A, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
const hash = f => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
function command(label, binary, args, timeout) {
  const result = runOwnedSync(binary, args, { cwd: ROOT, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  const stdout = path.join(A, label + ".stdout.log"), stderr = path.join(A, label + ".stderr.log");
  fs.writeFileSync(stdout, result.stdout || ""); fs.writeFileSync(stderr, result.stderr || "");
  return { result, binding: { label, binary, args, observed_at: new Date().toISOString(), status: result.status,
    error: result.error?.code || null, ownership: result.ownership, stdout_sha256: hash(stdout), stderr_sha256: hash(stderr) } };
}
function captureProcessIo(label) {
  const helper = path.join(ROOT, "scripts/quiet-process-io.py");
  const observation = command(label + "-io", "python3", [helper], 5000);
  let payload; try { payload = JSON.parse(observation.result.stdout); } catch { payload = null; }
  receipt.process_io_observations ||= [];
  receipt.process_io_observations.push({ ...observation.binding,
    collector_sha256: hash(helper), collection_started_epoch: payload?.started_epoch || null,
    collection_finished_epoch: payload?.finished_epoch || null,
    pid_count: payload?.pid_count || null, parsed: Array.isArray(payload?.rows) });
  write();
}
function processCheck(label) {
  const { result, binding } = command(label, "ps", ["-axo", "pid=,ppid="], 5000);
  const rows = String(result.stdout || "").split("\n").filter(s => s.trim()).map(s => {
    const m = s.trim().match(/^(\d+)\s+(\d+)$/);
    return m ? { pid: Number(m[1]), ppid: Number(m[2]) } : { malformed: s };
  });
  const byPid = new Map(rows.filter(x => !x.malformed).map(x => [x.pid, x]));
  const ownAncestors = new Set(); let cursor = process.pid;
  while (cursor > 0 && !ownAncestors.has(cursor)) { ownAncestors.add(cursor); cursor = byPid.get(cursor)?.ppid || 0; }
  const input = path.join(A, label + "-pids.json"); fs.writeFileSync(input, JSON.stringify(rows.filter(x => !x.malformed)));
  const helper = path.join(ROOT, "scripts/quiet-process-identity.py");
  const identities = command(label + "-identity", "python3", [helper, input], 5000);
  let observed; try { observed = JSON.parse(identities.result.stdout); } catch { observed = null; }
  const { heavyWork, heavyWorkCommand } = require(path.join(ROOT, "scripts/quiet-host-processes.cjs"));
  const unavailable = observed?.filter(x => !ownAncestors.has(x.pid) && !x.exited && (x.identity_errno !== 0 || !x.executable || !Array.isArray(x.argv) && typeof x.command_line !== "string")) || [];
  const heavy = observed?.filter(x => !ownAncestors.has(x.pid) && !x.exited && x.identity_errno === 0 && (Array.isArray(x.argv) ? heavyWork(x.executable, x.argv) : typeof x.command_line === "string" && heavyWorkCommand(x.executable, x.command_line))) || [];
  const check = { ...binding, identity: { ...identities.binding, helper_sha256: hash(helper), classifier_sha256: hash(path.join(ROOT,"scripts/quiet-host-processes.cjs")) },
    excluded_own_ancestor_pids: [...ownAncestors], malformed_rows: rows.filter(x => x.malformed).length, unavailable, heavy,
    ok: result.status === 0 && !result.error && rows.every(x => !x.malformed)
      && identities.result.status === 0 && !identities.result.error && Array.isArray(observed) && unavailable.length === 0 && heavy.length === 0 };
  captureProcessIo(label);
  receipt.process_checks.push(check); write();
  console.log(JSON.stringify({ phase: "quiet-process-check", label, ok: check.ok, heavy_pids: heavy.map(x => x.pid), unavailable_count: unavailable.length, artifact_dir: A }));
  return check.ok;
}
function simulatorCheck(label) {
  const { result, binding } = command(label, "/usr/bin/xcrun", ["simctl", "list", "devices", "available", "--json"], 10000);
  let devices; try { devices = Object.values(JSON.parse(result.stdout).devices).flat(); } catch { devices = null; }
  const booting = devices?.filter(d => !["Shutdown", "Booted"].includes(d.state)) || [];
  const check = { ...binding, booted_idle_devices: devices?.filter(d => d.state === "Booted").map(d => ({ udid: d.udid, name: d.name })) || [],
    booting, ok: result.status === 0 && !result.error && Array.isArray(devices) && booting.length === 0 };
  receipt.simulator_checks.push(check); write(); return check.ok;
}
async function main() {
  write();
  if (!processCheck("process-start") || !simulatorCheck("simulator-start")) { receipt.result = "BUSY_OR_UNAVAILABLE"; write(); process.exitCode = 2; return; }
  const stdoutFile = path.join(A, "iostat.stdout.log"), stderrFile = path.join(A, "iostat.stderr.log");
  const stdoutFd = fs.openSync(stdoutFile, "wx"), stderrFd = fs.openSync(stderrFile, "wx");
  const started = performance.now(); let pending = "", numericRows = 0, parserErrors = [];
  // macOS -c counts all displays; request61 so exclusion of the cumulative row leaves60 timed samples.
  // FD75860fc6 permits this90-second private observer guard: observed56 samples took65s; production command bounds are unchanged.
  const child = spawnOwned("/usr/sbin/iostat", ["-d", "-w", "1", "-c", "61"], { cwd: ROOT, timeout: 90000, stdio: ["ignore", "pipe", "pipe"] });
  const supervision = JSON.parse(child.spawnargs.at(-1));
  const closed = new Promise(resolve => child.once("close", resolve));
  child.stdout.on("data", data => {
    fs.writeSync(stdoutFd, data); pending += data.toString(); let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (!/^\s*\d/.test(line)) continue;
      const fields = line.trim().split(/\s+/).map(Number);
      if (!fields.length || fields.length % 3 || !fields.every(Number.isFinite)) { parserErrors.push(line); continue; }
      numericRows += 1;
      if (numericRows === 1) continue; // Initial row is since boot, not this interval.
      const tps = fields.filter((_, i) => i % 3 === 1).reduce((x, y) => x + y, 0);
      receipt.disk_intervals.push({ index: numericRows - 1, elapsed_ms: performance.now() - started, tps, raw: line }); write();
    }
  });
  child.stderr.on("data", data => fs.writeSync(stderrFd, data));
  let tick = 0;
  const timer = setInterval(() => { tick += 1; processCheck("process-during-" + tick); }, 10000);
  const terminal = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      let ownership; try { ownership = JSON.parse(fs.readFileSync(supervision.marker, "utf8")); } catch (e) { ownership = { receipt_error: e.code || e.message }; }
      resolve({ code, signal, ownership });
    });
  });
  await closed; clearInterval(timer); fs.closeSync(stdoutFd); fs.closeSync(stderrFd);
  receipt.observation_elapsed_ms = performance.now() - started;
  receipt.iostat = { binary: "/usr/sbin/iostat", args: ["-d", "-w", "1", "-c", "61"], observer_bound_ms: 90000, ...terminal,
    stdout_sha256: hash(stdoutFile), stderr_sha256: hash(stderrFile), numeric_rows: numericRows, parser_errors: parserErrors,
    initial_cumulative_row_excluded: true };
  const finalProcesses = processCheck("process-end"), finalSimulator = simulatorCheck("simulator-end");
  const intervals = receipt.disk_intervals;
  const sortedTps = intervals.map(x => x.tps).sort((a, b) => a - b);
  receipt.max_disk_tps = sortedTps.length ? sortedTps.at(-1) : null;
  receipt.median_disk_tps = sortedTps.length ? (sortedTps[Math.floor((sortedTps.length - 1) / 2)] + sortedTps[Math.floor(sortedTps.length / 2)]) / 2 : null;
  receipt.fd_window_go_sha256 = hash(windowPath);
  receipt.ready = finalProcesses && finalSimulator && receipt.process_checks.every(x => x.ok) && receipt.simulator_checks.every(x => x.ok)
    && terminal.code === 0 && terminal.ownership.disposition === "completed" && terminal.ownership.group_alive_after === false
    && receipt.observation_elapsed_ms >= 60000 && intervals.length >= 60 && parserErrors.length === 0 && receipt.median_disk_tps < 2000 && receipt.max_disk_tps <= 10000;
  receipt.finished_at = new Date().toISOString(); receipt.result = receipt.ready ? "QUIET_60S_PASS" : "BUSY_OR_UNAVAILABLE";
  const raw = fs.readdirSync(A).filter(name => name !== "receipt.json" && name !== "fd-window.json").sort().map(relative => ({ relative, size: fs.statSync(path.join(A, relative)).size, sha256: hash(path.join(A, relative)) }));
  receipt.raw_evidence_digest = crypto.createHash("sha256").update(canonical(raw)).digest("hex"); write();
  console.log(JSON.stringify({ result: receipt.result, intervals: intervals.length, max_disk_tps: receipt.max_disk_tps,
    median_disk_tps: receipt.median_disk_tps, observation_elapsed_ms: receipt.observation_elapsed_ms, artifact_dir: A }));
  if (!receipt.ready) process.exitCode = 2;
}
main().catch(error => { receipt.error = error.stack; receipt.ready = false; write(); console.error(error.stack); process.exitCode = 1; });
