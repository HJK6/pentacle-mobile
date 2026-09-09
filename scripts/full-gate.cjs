#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { requireGateCodeProvenance } = require('./gate-code-provenance.cjs');
const { withSimulatorResource } = require('./sim-resource-guard.cjs');
const { reapStaleSimulatorSubstrate } = require('./sim-substrate.cjs');
const { collectChecks, requireChecks } = require('./gate-checks.cjs');

function validateScenarioConfiguration(options, env = process.env) {
  if (!options.simE2e) throw new Error('sim-e2e is required; set PENTACLE_GATE_SIM_E2E_CMD or pass --sim-e2e');
  const stage = env.PENTACLE_GATE_SIM_E2E_STAGE || 'pre-integration';
  if (!['pre-integration', 'integration'].includes(stage)) throw new Error('PENTACLE_GATE_SIM_E2E_STAGE must be pre-integration or integration');
  return stage;
}

function runIndependentChecks(actions) {
  return collectChecks([
    { name: 'scenario-configuration', run: actions.configuration },
    { name: 'hostadmission-and-signal', run: actions.health },
    ...['focused-jest', 'serial-jest', 'typecheck'].map((name) => ({ name, dependsOn: ['hostadmission-and-signal'], run: actions[name] })),
  ]);
}

const CODE_ROOT = path.resolve(__dirname, '..');
const ROOT = process.env.PENTACLE_GATE_CANONICAL_RUNNER === '1'
  ? fs.realpathSync(process.cwd())
  : CODE_ROOT;
const FOCUSED_TESTS = [
  'tests/contracts/question_ask_answer_display.test.tsx',
  'tests/contracts/trace_fixture_integrity.test.ts',
  'tests/mobileQuestionSharedModel.test.tsx',
];
const RELEASE_HARNESS_ENV = Object.freeze({ EXPO_PUBLIC_HARNESS: '1' });
const LOCAL_CONFIG = 'pentacle.config.local.ts';
const LOCAL_CONFIG_EXAMPLE = 'pentacle.config.example.ts';
const DEFAULT_SIMULATOR_DEVICE_SET = path.join(os.homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices');
const PENTACLE_SIMULATOR_DEVICE_SET = path.join(os.homedir(), 'Library', 'Developer', 'PentacleCoreSimulator', 'Devices');
const DEFAULT_TESTTIME_RUN_ID = `pentacle-mobile-${Date.now()}-${process.pid}`;
const OWNED_STAGE_TIMEOUT_GRACE_MS = 2_000;
const SIMULATOR_STAGE_TIMEOUT_MS = Object.freeze({
  'release-sim-bootstatus': 180_000,
  'release-sim-build': 1_800_000,
  'release-sim-reset': 60_000,
  'release-sim-install': 120_000,
  'release-sim-launch': 135_000,
  'release-sim-settle': 10_000,
  'release-sim-liveness': 30_000,
  'sim-e2e': 2_700_000,
});
const OWNED_STAGE_RUNNER = require('./owned-process.cjs').RUNNER_SOURCE;

function releaseSimulatorBuildOptions() {
  return { env: { ...RELEASE_HARNESS_ENV, RCT_NO_LAUNCH_PACKAGER: '1' } };
}

function productionIosExportOptions() {
  return {};
}

function usage() {
  console.log('Usage: npm run gate:full -- [--artifacts <dir>] [--sim-e2e <command>]');
}

function gitSha() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function parseArgs(argv) {
  const parsed = { artifacts: process.env.PENTACLE_GATE_ARTIFACT_DIR, simE2e: process.env.PENTACLE_GATE_SIM_E2E_CMD, preflight: false };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--preflight') {
      parsed.preflight = true;
      continue;
    }
    if (arg === '--artifacts' || arg === '--sim-e2e') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      parsed[arg === '--artifacts' ? 'artifacts' : 'simE2e'] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function defaultArtifactDir() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(ROOT, '_artifacts', 'full-gate', `${gitSha().slice(0, 12)}-${stamp}`);
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function installedBundleId(appPath) {
  const infoPlist = path.join(appPath, 'Info.plist');
  const result = spawnSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', infoPlist], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`release-sim-smoke could not read CFBundleIdentifier from ${infoPlist}`);
  }
  const bundleId = result.stdout.trim();
  const expectedBundleId = process.env.PENTACLE_GATE_BUNDLE_ID;
  if (expectedBundleId && expectedBundleId !== bundleId) {
    throw new Error(`PENTACLE_GATE_BUNDLE_ID ${expectedBundleId} does not match built app ${bundleId}`);
  }
  return bundleId;
}

function simulatorDeviceSetRoot() {
  const requested = path.resolve(process.env.PENTACLE_GATE_SIMULATOR_DEVICE_SET_ROOT || DEFAULT_SIMULATOR_DEVICE_SET);
  const admitted = [DEFAULT_SIMULATOR_DEVICE_SET, PENTACLE_SIMULATOR_DEVICE_SET].map((entry) => path.resolve(entry));
  if (!admitted.includes(requested)) {
    throw new Error(`PENTACLE_GATE_SIMULATOR_DEVICE_SET_ROOT is not canonical: ${requested}`);
  }
  return requested;
}

function simctlArgs(deviceSetRoot, ...args) {
  return ['xcrun', 'simctl', '--set', deviceSetRoot, ...args];
}

function scenarioGateOptions(target) {
  return { env: {
    PENTACLE_SCENARIO_DEVICE_SET_ROOT: target.deviceSetRoot,
    PENTACLE_SIMULATOR_UDID: target.udid,
    PENTACLE_BUNDLE_ID: target.bundleId,
    PENTACLE_GATE_BOUND_SIMULATOR_UDID: target.udid,
    PENTACLE_GATE_BOUND_BUNDLE_ID: target.bundleId,
  } };
}

function commandLabel(argv) {
  return Array.isArray(argv) ? argv.join(' ') : argv;
}

function gateEnvironment(artifactDir, options = {}, parentEnv = process.env) {
  const env = {
    ...parentEnv,
    PENTACLE_GATE_ARTIFACT_DIR: artifactDir,
    TESTTIME_REPO: parentEnv.TESTTIME_REPO || 'pentacle-mobile',
    TESTTIME_RUN_ID: parentEnv.TESTTIME_RUN_ID || DEFAULT_TESTTIME_RUN_ID,
    TESTTIME_OUT: parentEnv.TESTTIME_OUT || path.join(artifactDir, 'testtime.jsonl'),
  };
  delete env.EXPO_PUBLIC_HARNESS;
  return { ...env, ...options.env };
}

function runGate(name, argv, artifactDir, options = {}) {
  const logPath = path.join(artifactDir, `${name}.log`);
  const startedAt = new Date().toISOString();
  const output = fs.openSync(logPath, 'w');
  const env = gateEnvironment(artifactDir, options);
  const command = Array.isArray(argv) ? argv : ['sh', '-c', argv];
  const timeoutMs = options.timeoutMs || ({ 'focused-jest': 300000, 'serial-jest': 1800000, typecheck: 300000, 'ios-export': 600000 }[name] || 60000);
  const timeoutMarker = path.join(artifactDir, `.${name}.timeout.json`);
  const executed = timeoutMs ? [
    process.execPath,
    '-e',
    OWNED_STAGE_RUNNER,
    JSON.stringify({
      stage: name,
      ownerPid: process.pid,
      command,
      marker: timeoutMarker,
      boundMs: timeoutMs,
      graceMs: OWNED_STAGE_TIMEOUT_GRACE_MS,
    }),
  ] : command;
  const timed = [env.TESTTIME_BIN || 'testtime', 'stage', env.TESTTIME_RUN_ID, name, '--', ...executed];
  const spawnOptions = {
    cwd: options.cwd || ROOT,
    env,
    shell: false,
    detached: true,
    stdio: ['ignore', output, output],
  };
  let result = spawnSync(timed[0], timed.slice(1), spawnOptions);
  if (result.error) {
    fs.writeSync(output, `[testtime unavailable: ${result.error.message}; running original command]\n`);
    result = spawnSync(executed[0], executed.slice(1), spawnOptions);
  }
  fs.closeSync(output);
  let timeout = null;
  let ownership = null;
  try {
    if (fs.existsSync(timeoutMarker)) timeout = JSON.parse(fs.readFileSync(timeoutMarker, 'utf8'));
  } finally {
    fs.rmSync(timeoutMarker, { force: true });
  }
  if (timeout?.kind === 'ownership') { ownership = timeout; timeout = null; }
  const status = result.error ? 1 : (result.status ?? 1);
  const evidence = {
    name,
    command: commandLabel(argv),
    status,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    log: path.basename(logPath),
    ...(ownership ? { owned_process_group: ownership.owned_process_group, ownership } : {}),
    ...(options.readiness ? { readiness: options.readiness } : {}),
    ...(timeout ? { failure_class: 'setup_tooling_timeout', timeout } : {}),
  };
  writeJson(path.join(artifactDir, `${name}.json`), evidence);
  if (timeout) {
    throw new Error(`${name} timed out after ${timeout.bound_ms}ms; owned child ${timeout.disposition}; inspect ${logPath}`);
  }
  if (status !== 0) throw new Error(`${name} failed; inspect ${logPath}`);
  return evidence;
}

function gitValue(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed for ${cwd}`);
  return result.stdout.trim();
}

function requireNoGitDiff(cwd, args, label, kind) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`git ${args.join(' ')} failed for ${cwd}`);
  }
  if (result.status === 1) throw new Error(`${label} has a ${kind} diff`);
}

function requireCleanRepository(cwd, label) {
  const porcelain = gitValue(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (porcelain) throw new Error(`${label} must be clean before gate provenance is accepted`);
  requireNoGitDiff(cwd, ['diff', '--quiet', '--no-ext-diff', '--ignore-submodules=none', '--'], label, 'worktree');
  requireNoGitDiff(cwd, ['diff', '--cached', '--quiet', '--no-ext-diff', '--ignore-submodules=none', '--'], label, 'staged');
}

function resolveGateCodeProvenance(candidateSha) {
  const expectedCandidate = process.env.PENTACLE_GATE_CANDIDATE_SHA;
  if (expectedCandidate && expectedCandidate !== candidateSha) {
    throw new Error('GATE_CANDIDATE_SHA_MISMATCH');
  }
  const gateCodeSha = process.env.PENTACLE_GATE_CODE_SHA;
  const gateCodeTreeClean = process.env.PENTACLE_GATE_CODE_TREE_CLEAN;
  if (gateCodeSha || gateCodeTreeClean) {
    if (!/^[0-9a-f]{40}$/.test(gateCodeSha || '') || gateCodeTreeClean !== 'true') {
      throw new Error('GATE_CODE_PROVENANCE_INVALID');
    }
    return { gate_code_sha: gateCodeSha, gate_code_tree_clean: true };
  }
  return requireGateCodeProvenance(CODE_ROOT);
}

function requireInitializedSubmodules(cwd, label) {
  const status = gitValue(cwd, ['submodule', 'status', '--recursive']);
  if (status.split('\n').some((entry) => entry.startsWith('-'))) {
    throw new Error(`${label} must initialize all tracked submodules before gate provenance is accepted`);
  }
}

function rootLocalRegularFile(root, relativePath, label) {
  const file = path.join(root, relativePath);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  const resolvedRoot = fs.realpathSync(root);
  const resolvedFile = fs.realpathSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} must be a regular root-local file`);
  }
  return { file, resolvedFile };
}

function requireBuildCompatibleIosPermissions(nativeRoot) {
  const iosRoot = path.join(nativeRoot, 'ios');
  let modulemapFiles = 0;
  const visit = (entry) => {
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entry)) visit(path.join(entry, child));
      return;
    }
    if (!stat.isFile() || path.extname(entry) !== '.modulemap') return;
    modulemapFiles += 1;
    if ((stat.mode & 0o200) === 0) {
      throw new Error(`PENTACLE_GATE_NATIVE_ROOT ios build inputs must be build-compatible and owner-writable: ${path.relative(nativeRoot, entry)}`);
    }
  };
  visit(iosRoot);
  return { scope: 'ios/**/*.modulemap', modulemap_files: modulemapFiles, owner_writable_required: true };
}

function rawGitValue(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed for ${cwd}`);
  return result.stdout;
}

function requireSemanticMinimalLaunchNativeDiff(nativeRoot, parentSha, nativeSha, derivedPaths) {
  const appDelegate = 'ios/Pentacle/AppDelegate.swift';
  const project = 'ios/Pentacle.xcodeproj/project.pbxproj';
  if (derivedPaths.includes(appDelegate)) {
    const { patchAppDelegate } = require(path.join(CODE_ROOT, 'plugins', 'withHarnessLaunchUrl.js'));
    const parent = rawGitValue(nativeRoot, ['show', `${parentSha}:${appDelegate}`]);
    const actual = fs.readFileSync(path.join(nativeRoot, appDelegate), 'utf8');
    if (actual !== patchAppDelegate(parent)) {
      throw new Error('PENTACLE_GATE_NATIVE_ROOT must preserve a semantic-minimal launch identity AppDelegate delta');
    }
  }
  if (derivedPaths.includes(project)) {
    const changes = rawGitValue(nativeRoot, ['diff', '--unified=0', parentSha, nativeSha, '--', project])
      .split('\n')
      .filter((line) => (/^[+-]/).test(line) && !line.startsWith('+++') && !line.startsWith('---'))
      .map((line) => `${line[0]}${line.slice(1).trim()}`)
      .sort();
    const expected = [
      '-PRODUCT_BUNDLE_IDENTIFIER = quest.pentacle.mobile;',
      '-PRODUCT_BUNDLE_IDENTIFIER = quest.pentacle.mobile;',
      '-PRODUCT_NAME = "Pentacle";',
      '-PRODUCT_NAME = "Pentacle";',
      '+PRODUCT_BUNDLE_IDENTIFIER = com.example.pentacle.harness;',
      '+PRODUCT_BUNDLE_IDENTIFIER = com.example.pentacle.harness;',
      '+PRODUCT_NAME = "PentacleHarness";',
      '+PRODUCT_NAME = "PentacleHarness";',
    ].sort();
    if (JSON.stringify(changes) !== JSON.stringify(expected)) {
      throw new Error('PENTACLE_GATE_NATIVE_ROOT must preserve a semantic-minimal launch identity project delta');
    }
  }
  return { app_delegate: derivedPaths.includes(appDelegate), project: derivedPaths.includes(project) };
}

function provisionCandidateLocalConfig(candidateRoot = ROOT) {
  const source = rootLocalRegularFile(candidateRoot, LOCAL_CONFIG_EXAMPLE, `tracked ${LOCAL_CONFIG_EXAMPLE}`);
  if (!source) throw new Error(`candidate checkout lacks tracked ${LOCAL_CONFIG_EXAMPLE}`);
  gitValue(candidateRoot, ['ls-files', '--error-unmatch', '--', LOCAL_CONFIG_EXAMPLE]);
  const targetPath = path.join(candidateRoot, LOCAL_CONFIG);
  let target = rootLocalRegularFile(candidateRoot, LOCAL_CONFIG, `candidate checkout ${LOCAL_CONFIG}`);
  let provisioned = false;
  if (!target) {
    fs.copyFileSync(source.file, targetPath, fs.constants.COPYFILE_EXCL);
    target = rootLocalRegularFile(candidateRoot, LOCAL_CONFIG, `candidate checkout ${LOCAL_CONFIG}`);
    provisioned = true;
  }
  if (fs.readFileSync(target.file).compare(fs.readFileSync(source.file)) !== 0) {
    throw new Error(`candidate checkout ${LOCAL_CONFIG} must match tracked ${LOCAL_CONFIG_EXAMPLE}`);
  }
  return { path: target.file, source: source.file, provisioned };
}

function requireNativeRoot(artifactDir) {
  const configured = process.env.PENTACLE_GATE_NATIVE_ROOT;
  if (!configured) throw new Error('release-sim-smoke requires PENTACLE_GATE_NATIVE_ROOT');
  const candidateRoot = fs.realpathSync(ROOT);
  const nativeRoot = fs.realpathSync(path.resolve(configured));
  if (nativeRoot === candidateRoot) {
    throw new Error('PENTACLE_GATE_NATIVE_ROOT must be a disposable root, not the candidate checkout');
  }
  const candidateRepoRoot = fs.realpathSync(gitValue(candidateRoot, ['rev-parse', '--show-toplevel']));
  const nativeRepoRoot = fs.realpathSync(gitValue(nativeRoot, ['rev-parse', '--show-toplevel']));
  if (candidateRepoRoot === nativeRepoRoot) {
    throw new Error('PENTACLE_GATE_NATIVE_ROOT resolves to the candidate repository identity');
  }
  const candidateOrigin = gitValue(candidateRoot, ['remote', 'get-url', 'origin']);
  const nativeOrigin = gitValue(nativeRoot, ['remote', 'get-url', 'origin']);
  if (candidateOrigin !== nativeOrigin) {
    throw new Error('PENTACLE_GATE_NATIVE_ROOT must share the candidate repository origin');
  }
  requireCleanRepository(candidateRoot, 'candidate checkout');
  requireCleanRepository(nativeRoot, 'PENTACLE_GATE_NATIVE_ROOT');
  requireInitializedSubmodules(nativeRoot, 'PENTACLE_GATE_NATIVE_ROOT');
  const candidateGitDir = fs.realpathSync(gitValue(candidateRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const nativeGitDir = fs.realpathSync(gitValue(nativeRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  if (candidateGitDir === nativeGitDir) {
    throw new Error('PENTACLE_GATE_NATIVE_ROOT must be an isolated clone, not a shared worktree');
  }
  const nativeNodeModules = path.join(nativeRoot, 'node_modules');
  if (!fs.existsSync(nativeNodeModules) || !fs.realpathSync(nativeNodeModules).startsWith(`${nativeRoot}${path.sep}`)) {
    throw new Error('PENTACLE_GATE_NATIVE_ROOT must provide its own node_modules inside the disposable root');
  }
  const localConfig = path.join(nativeRoot, 'pentacle.config.local.ts');
  if (!fs.existsSync(localConfig) || !fs.realpathSync(localConfig).startsWith(`${nativeRoot}${path.sep}`)) {
    throw new Error('PENTACLE_GATE_NATIVE_ROOT must provide a root-local pentacle.config.local.ts');
  }
  const candidateSha = gitSha();
  const gateCodeProvenance = resolveGateCodeProvenance(candidateSha);
  const nativeSha = gitValue(nativeRoot, ['rev-parse', 'HEAD']);
  const nativeParent = gitValue(nativeRoot, ['rev-parse', 'HEAD^']);
  if (nativeParent !== candidateSha) {
    throw new Error('PENTACLE_GATE_NATIVE_ROOT must be a derived commit whose parent is the candidate SHA');
  }
  const derivedPaths = gitValue(nativeRoot, ['diff', '--name-only', `${candidateSha}..${nativeSha}`])
    .split('\n').filter(Boolean);
  if (!derivedPaths.length || derivedPaths.some((entry) => !entry.startsWith('ios/'))) {
    throw new Error('PENTACLE_GATE_NATIVE_ROOT derived diff must contain only generated ios paths');
  }
  const semanticContract = requireSemanticMinimalLaunchNativeDiff(nativeRoot, nativeParent, nativeSha, derivedPaths);
  const workspace = path.join(nativeRoot, 'ios', 'Pentacle.xcworkspace');
  if (!fs.existsSync(workspace)) {
    throw new Error(`PENTACLE_GATE_NATIVE_ROOT lacks generated workspace: ${workspace}`);
  }
  const permissionContract = requireBuildCompatibleIosPermissions(nativeRoot);
  const evidence = {
    native_root: nativeRoot,
    candidate_sha: candidateSha,
    derived_sha: nativeSha,
    parent_sha: nativeParent,
    derived_paths: derivedPaths,
    workspace,
    permission_contract: permissionContract,
    semantic_contract: semanticContract,
  };
  if (artifactDir) writeJson(path.join(artifactDir, 'native-root.json'), evidence);
  return { nativeRoot, workspace, evidence, gateCodeProvenance };
}

function readLaunchHost(remainingMs) {
  const started = performance.now();
  const timeoutMs = Math.max(1, Math.floor(Math.min(2000, remainingMs)));
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,pcpu=,comm='], {
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
  });
  const stdout = String(result.stdout || '');
  const lines = stdout.trim().split('\n');
  const census = { kind: 'ps_spawn', spawn_ms: performance.now() - started, timeout_ms: timeoutMs,
    status: result.status, signal: result.signal, rows: stdout.trim() ? lines.length : 0,
    stdout_bytes: Buffer.byteLength(stdout), stderr: String(result.stderr || '').slice(0, 4096),
    spawn_error: result.error ? { name: result.error.name, code: result.error.code,
      message: String(result.error.message).slice(0, 1024) } : null };
  if (result.error || result.status !== 0) throw Object.assign(new Error('process census unavailable'), { census });
  const processes = lines.map((line, index) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/);
    if (!match) throw Object.assign(new Error('invalid process census'), {
      census: { ...census, kind: 'ps_parse', invalid_row_index: index, invalid_row: line.slice(0, 512) },
    });
    return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), cpu: Number(match[4]), command: match[5] };
  });
  try {
    const cpus = os.cpus();
    return { ncpu: cpus.length, loadavg: os.loadavg(), processes, census,
    cpu: {
      idle: cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0),
      total: cpus.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((a, b) => a + b, 0), 0),
    },
    };
  } catch (error) { throw Object.assign(error, { census }); }
}

function waitForLaunchReadiness(buildGroup, dependencies = {}) {
  const now = dependencies.now || (() => performance.now());
  const sleep = dependencies.sleep || ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  const read = dependencies.read || readLaunchHost;
  const started = now();
  const readiness = { bound_ms: 120000, elapsed_ms: 0, samples: [], census: [] };
  let previous = null;
  const reject = (code, failure = { phase: code === 'HOST_LAUNCH_NOT_READY' ? 'deadline' : 'validation', message: code }) => {
    readiness.failure = failure;
    throw Object.assign(new Error(code), { code, readiness });
  };
  if (!Number.isInteger(buildGroup) || buildGroup <= 0) reject('HOST_BUILD_OWNER_MISSING');
  while (true) {
    readiness.elapsed_ms = now() - started;
    if (readiness.elapsed_ms >= readiness.bound_ms) reject('HOST_LAUNCH_NOT_READY');
    let observation;
    try { observation = read(readiness.bound_ms - readiness.elapsed_ms); }
    catch (error) {
      readiness.elapsed_ms = now() - started;
      const failure = { phase: 'read', name: String(error?.name || 'Error'), code: error?.code || null,
        message: String(error?.message || error).slice(0, 1024), census: error?.census || null };
      readiness.samples.push({ elapsed_ms: readiness.elapsed_ms, not_ready: true, failure });
      if (failure.census?.kind !== 'ps_spawn' || failure.census.spawn_error?.code !== 'ETIMEDOUT') {
        reject('HOST_LAUNCH_READINESS_UNAVAILABLE', failure);
      }
      // A timed-out census supplies no CPU baseline or ownership proof. Settle again within the same bound.
      previous = null;
      if (readiness.elapsed_ms >= readiness.bound_ms) reject('HOST_LAUNCH_NOT_READY');
      sleep(Math.min(5000, readiness.bound_ms - readiness.elapsed_ms));
      continue;
    }
    readiness.elapsed_ms = now() - started;
    const validRow = (row) => row && Number.isInteger(row.pid) && row.pid > 0
      && Number.isInteger(row.ppid) && row.ppid >= 0 && Number.isInteger(row.pgid) && row.pgid >= 0
      && Number.isFinite(row.cpu) && row.cpu >= 0 && typeof row.command === 'string' && row.command.length > 0;
    if (!observation || !Number.isInteger(observation.ncpu) || observation.ncpu <= 0
      || !Array.isArray(observation.loadavg) || observation.loadavg.length !== 3
      || !observation.loadavg.every((value) => Number.isFinite(value) && value >= 0)
      || !observation.cpu || !Number.isFinite(observation.cpu.idle) || observation.cpu.idle < 0
      || !Number.isFinite(observation.cpu.total) || observation.cpu.total < observation.cpu.idle
      || !Array.isArray(observation.processes) || !observation.processes.every(validRow)) {
      const failure = { phase: 'validate_observation', message: 'invalid host census', census: observation?.census || null,
        ncpu: observation?.ncpu, loadavg: observation?.loadavg, cpu: observation?.cpu,
        rows: Array.isArray(observation?.processes) ? observation.processes.length : null,
        invalid_rows: Array.isArray(observation?.processes) ? observation.processes.filter((row) => !validRow(row)).slice(0, 5) : null };
      readiness.samples.push({ elapsed_ms: readiness.elapsed_ms, not_ready: true, failure });
      reject('HOST_LAUNCH_READINESS_UNAVAILABLE', failure);
    }
    readiness.census = observation.processes;
    const owned = observation.processes.filter((row) => row.pgid === buildGroup).map((row) => row.pid);
    let idleRatio = null;
    let sampleMs = 0;
    if (previous) {
      const totalDelta = observation.cpu.total - previous.cpu.total;
      const idleDelta = observation.cpu.idle - previous.cpu.idle;
      sampleMs = readiness.elapsed_ms - previous.elapsed_ms;
      if (observation.ncpu !== previous.ncpu || totalDelta <= 0 || idleDelta < 0 || idleDelta > totalDelta) {
        const failure = { phase: 'cpu_delta', message: 'invalid CPU counter delta', total_delta: totalDelta,
          idle_delta: idleDelta, previous_ncpu: previous.ncpu, ncpu: observation.ncpu, census: observation.census || null };
        readiness.samples.push({ elapsed_ms: readiness.elapsed_ms, not_ready: true, failure });
        reject('HOST_LAUNCH_READINESS_UNAVAILABLE', failure);
      }
      idleRatio = idleDelta / totalDelta;
    }
    readiness.samples.push({ elapsed_ms: readiness.elapsed_ms, sample_ms: sampleMs, ncpu: observation.ncpu,
      loadavg: observation.loadavg, cpu_ticks: observation.cpu, idle_ratio: idleRatio, owned_pids: owned,
      census: observation.census || null });
    if (readiness.elapsed_ms <= readiness.bound_ms && sampleMs >= 5000 && idleRatio >= 0.5 && owned.length === 0) return readiness;
    if (readiness.elapsed_ms >= readiness.bound_ms) reject('HOST_LAUNCH_NOT_READY');
    previous = { ...observation, elapsed_ms: readiness.elapsed_ms };
    sleep(Math.min(5000, readiness.bound_ms - readiness.elapsed_ms));
  }
}

function createReleaseTarget(identity, persist) {
  let snapshot = Object.freeze({ schema: 1, ...identity, bundleId: null, appPath: null, phase: 'allocated', status: 'pending' });
  persist(snapshot);
  return { get value() { return snapshot; }, advance(phase, fields = {}) {
    snapshot = Object.freeze({ ...snapshot, ...fields, phase });
    persist(snapshot);
    return snapshot;
  } };
}

const defaultRunGate = runGate;

function releaseSmoke(artifactDir, native, dependencies = {}) {
  const udid = process.env.PENTACLE_GATE_SIMULATOR_UDID || process.env.PENTACLE_SIMULATOR_UDID;
  if (!udid) throw new Error('release-sim-smoke requires PENTACLE_GATE_SIMULATOR_UDID or PENTACLE_SIMULATOR_UDID');
  const { nativeRoot, workspace } = native;
  const derivedPath = path.join(artifactDir, 'release-sim-derived-data');
  const derivedData = fs.existsSync(derivedPath) ? fs.realpathSync(derivedPath) : derivedPath;
  const deviceSetRoot = simulatorDeviceSetRoot();
  const targetState = createReleaseTarget({ run_id: process.env.PENTACLE_STORAGE_RUN_ID || process.env.TESTTIME_RUN_ID,
    candidate_sha: native.evidence?.candidate_sha, native_sha: native.evidence?.derived_sha, udid, deviceSetRoot,
    expected_bundle_id: process.env.PENTACLE_BUNDLE_ID || process.env.PENTACLE_GATE_BUNDLE_ID || 'com.example.pentacle.harness',
  }, dependencies.onTarget || (() => undefined));
  const runGate = dependencies.runGate || defaultRunGate;
  const evidence = [];
  targetState.advance('boot');
  evidence.push(runGate('release-sim-bootstatus', simctlArgs(deviceSetRoot, 'bootstatus', udid, '-b'), artifactDir, { timeoutMs: SIMULATOR_STAGE_TIMEOUT_MS['release-sim-bootstatus'] }));
  const bundleOverride = String(process.env.PENTACLE_BUNDLE_ID || '').trim();
  const buildArgs = require('./gate-build-policy.cjs').buildArguments(workspace, derivedData, bundleOverride);
  const health = (dependencies.hostHealth || require('./gate-host-health.cjs').requireHostHealth)(path.join(artifactDir, 'host-health-build.json'), { ownerPid: process.pid, deviceSetRoot, udid });
  targetState.advance('build');
  evidence.push(runGate('release-sim-build', buildArgs, artifactDir, {
    cwd: nativeRoot,
    ...releaseSimulatorBuildOptions(),
    timeoutMs: SIMULATOR_STAGE_TIMEOUT_MS['release-sim-build'],
    readiness: { host_health: health },
  }));
  const build = evidence.at(-1);
  const productDir = path.join(derivedData, 'Build', 'Products', 'Release-iphonesimulator');
  const app = fs.readdirSync(productDir, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
  if (!app) throw new Error(`release-sim-smoke found no app under ${productDir}`);
  const appPath = path.join(productDir, app.name);
  const bundleId = (dependencies.installedBundleId || installedBundleId)(appPath);
  targetState.advance('reset', { bundleId, appPath });
  evidence.push(runGate('release-sim-reset', [
    process.execPath, 'scripts/reset-simulator-app.cjs',
    '--device-set', deviceSetRoot, '--udid', udid, '--bundle-id', bundleId,
  ], artifactDir, { timeoutMs: SIMULATOR_STAGE_TIMEOUT_MS['release-sim-reset'] }));
  targetState.advance('install');
  evidence.push(runGate('release-sim-install', simctlArgs(deviceSetRoot, 'install', udid, appPath), artifactDir, { timeoutMs: SIMULATOR_STAGE_TIMEOUT_MS['release-sim-install'] }));
  // Built identity is already persisted; bind this launch before collecting readiness evidence.
  const target = targetState.advance('launch', { udid, bundleId, deviceSetRoot, appPath });
  let readiness;
  const readinessStarted = new Date().toISOString();
  try { readiness = (dependencies.settle || waitForLaunchReadiness)(build.owned_process_group); }
  catch (error) {
    fs.writeFileSync(path.join(artifactDir, 'release-sim-launch.log'), `${error.code || 'HOST_LAUNCH_READINESS_UNAVAILABLE'}\n`);
    writeJson(path.join(artifactDir, 'release-sim-launch.json'), {
      name: 'release-sim-launch', status: 1, started_at: readinessStarted, finished_at: new Date().toISOString(),
      log: 'release-sim-launch.log', failure_class: 'setup_host_not_ready', readiness: error.readiness || null,
    });
    throw error;
  }
  const nonce = require('node:crypto').randomUUID();
  const receiptFile = path.join(artifactDir, 'release-sim-readiness.json');
  const launchInput = { target, nonce, receiptFile };
  targetState.advance('launch', { launch_nonce: nonce });
  const launchChecks = [];
  try {
    evidence.push(runGate('release-sim-launch', [process.execPath, require.resolve('./gate-app-ready.cjs'), JSON.stringify(launchInput)], artifactDir,
      { timeoutMs: SIMULATOR_STAGE_TIMEOUT_MS['release-sim-launch'], readiness }));
  } catch (error) {
    launchChecks.push({ name: 'release-sim-launch', status: 'failed', dependencies: [], error: error.message });
  } finally {
    if (fs.existsSync(receiptFile)) {
      try {
        const observed = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
        targetState.advance(observed.ready ? 'ready' : 'launch-failed', { live_pid: observed.pid || null, status: observed.ready ? 'ready' : 'failed' });
      } catch (error) { launchChecks.push({ name: 'readiness-receipt', status: 'failed', dependencies: [], error: error.message }); }
    }
  }
  const verifyArgs = [process.execPath, require.resolve('./gate-app-ready.cjs'), JSON.stringify({ ...launchInput, verify: true })];
  requireChecks(collectChecks([
    { name: 'release-sim-settle', run: () => evidence.push(runGate('release-sim-settle', ['sleep', '2'], artifactDir, { timeoutMs: SIMULATOR_STAGE_TIMEOUT_MS['release-sim-settle'] })) },
    { name: 'release-sim-liveness', run: () => evidence.push(runGate('release-sim-liveness', verifyArgs, artifactDir, { timeoutMs: SIMULATOR_STAGE_TIMEOUT_MS['release-sim-liveness'] })) },
  ], launchChecks));
  return { evidence, target: targetState.value };
}

function main() {
  const options = parseArgs(process.argv);
  if (options.help) return usage();
  if (options.preflight) {
    const native = requireNativeRoot(null);
    console.log(`native-root preflight passed: candidate=${native.evidence.candidate_sha} gate-code=${native.gateCodeProvenance.gate_code_sha} root=${native.nativeRoot}`);
    return;
  }
  const bindingChecks = collectChecks([
    { name: 'native-root-binding', run: () => requireNativeRoot(null) },
    { name: 'scenario-configuration', run: () => validateScenarioConfiguration(options) },
  ]);
  if (bindingChecks[0].status !== 'passed') {
    const checks = collectChecks([
      { name: 'hostadmission-and-signal', run: () => require('./gate-host-health.cjs').requireHostHealth() },
      ...['focused-jest', 'serial-jest', 'typecheck', 'ios-export', 'release-sim-build', 'sim-e2e'].map((name) => ({ name, dependsOn: ['native-root-binding'], run: () => undefined })),
    ], bindingChecks);
    requireChecks(checks);
  }
  const native = bindingChecks[0].value;
  const candidateConfig = provisionCandidateLocalConfig();
  const artifactDir = path.resolve(options.artifacts || defaultArtifactDir());
  fs.mkdirSync(artifactDir, { recursive: true });
  process.env.TESTTIME_REPO ||= 'pentacle-mobile';
  process.env.TESTTIME_RUN_ID ||= `pentacle-mobile-${gitSha().slice(0, 12)}-${Date.now()}`;
  process.env.TESTTIME_OUT ||= path.join(artifactDir, 'testtime.jsonl');
  const summary = {
    sha: gitSha(),
    candidate_sha: native.evidence.candidate_sha,
    ...native.gateCodeProvenance,
    run_id: process.env.TESTTIME_RUN_ID,
    artifact_dir: artifactDir,
    started_at: new Date().toISOString(),
    hardening_version: 5,
    host_health_baseline: JSON.parse(process.env.PENTACLE_HOST_HEALTH_BASELINE || 'null'),
    release_target: { schema: 1, run_id: process.env.PENTACLE_STORAGE_RUN_ID, candidate_sha: native.evidence.candidate_sha,
      native_sha: native.evidence.derived_sha, deviceSetRoot: simulatorDeviceSetRoot(),
      udid: process.env.PENTACLE_GATE_SIMULATOR_UDID || process.env.PENTACLE_SIMULATOR_UDID,
      expected_bundle_id: process.env.PENTACLE_BUNDLE_ID || process.env.PENTACLE_GATE_BUNDLE_ID || 'com.example.pentacle.harness',
      bundleId: null, appPath: null, phase: 'allocated', status: 'pending' },
    candidate_config: {
      source: path.basename(candidateConfig.source),
      provisioned: candidateConfig.provisioned,
    },
    owned_boot_started_monotonic_ms: Number(process.env.PENTACLE_OWNED_BOOT_MONOTONIC_MS),
    gates: [],
  };
  writeJson(path.join(artifactDir, 'run.json'), summary);
  writeJson(path.join(artifactDir, 'native-root.json'), native.evidence);
  try {
    summary.checks = runIndependentChecks({
      configuration: () => validateScenarioConfiguration(options),
      health: () => require('./gate-host-health.cjs').requireHostHealth(path.join(artifactDir, 'host-health-start.json'), { settleBoot: true, bootStartedMs: summary.owned_boot_started_monotonic_ms, ownerPid: process.pid, deviceSetRoot: summary.release_target.deviceSetRoot, udid: summary.release_target.udid }),
      'focused-jest': () => { summary.gates.push(runGate('focused-jest', ['npx', 'jest', '--runInBand', '--runTestsByPath', ...FOCUSED_TESTS], artifactDir)); },
      'serial-jest': () => { summary.gates.push(runGate('serial-jest', ['npx', 'jest', '--runInBand'], artifactDir)); },
      typecheck: () => { summary.gates.push(runGate('typecheck', ['npm', 'run', 'typecheck'], artifactDir)); },
    }).map(({ value, ...row }) => row);
    writeJson(path.join(artifactDir, 'run.json'), summary);
    requireChecks(summary.checks);
    summary.gates.push(runGate('ios-export', ['node', 'scripts/prod-build.cjs', 'run', 'expo', 'export', '--platform', 'ios', '--output-dir', path.join(artifactDir, 'ios-export')], artifactDir, productionIosExportOptions()));
    withSimulatorResource(() => {
      summary.sim_substrate_reap = { scope: 'runner-owned-only', foreign_resources_untouched: true };
      const release = releaseSmoke(artifactDir, native, { onTarget: (target) => { summary.release_target = target; writeJson(path.join(artifactDir, 'run.json'), summary); } });
      summary.gates.push(...release.evidence);
      summary.release_target = release.target;
      const simE2eStage = validateScenarioConfiguration(options);
      const simE2e = runGate('sim-e2e', options.simE2e, artifactDir, {
        ...scenarioGateOptions(release.target),
        timeoutMs: SIMULATOR_STAGE_TIMEOUT_MS['sim-e2e'],
      });
      simE2e.stage = simE2eStage;
      writeJson(path.join(artifactDir, 'sim-e2e.json'), simE2e);
      summary.gates.push(simE2e);
      summary.status = simE2eStage === 'integration' ? 'passed' : 'passed-pre-integration';
    }, { label: `pentacle-mobile-full-gate-${summary.sha.slice(0, 12)}` });
  } catch (error) {
    summary.status = 'failed';
    summary.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    let dependency = summary.checks?.filter((row) => row.status !== 'passed').map((row) => row.name) || ['native-root-binding'];
    for (const name of ['ios-export', 'release-sim-bootstatus', 'release-sim-build', 'release-sim-reset', 'release-sim-install', 'release-sim-launch', 'release-sim-settle', 'release-sim-liveness', 'sim-e2e']) {
      const file = path.join(artifactDir, `${name}.json`);
      if (fs.existsSync(file)) {
        const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
        summary.checks.push({ name, status: receipt.status === 0 ? 'passed' : 'failed', dependencies: [], ...(receipt.status === 0 ? {} : { error: `${name} exit ${receipt.status}` }) });
        dependency = receipt.status === 0 ? [] : [name];
      } else {
        if (!dependency.length) dependency = [summary.release_target?.phase || 'release-preparation'];
        summary.checks.push({ name, status: 'unreachable', dependencies: [...dependency], error: summary.error });
        dependency = [name];
      }
    }
    summary.finished_at = new Date().toISOString();
    writeJson(path.join(artifactDir, 'run.json'), summary);
    if (summary.status === 'failed') console.error(`GATE_CHECK_BATCH:${JSON.stringify(summary.checks)}`);
    console.log(`full-gate ${summary.status}: candidate=${summary.candidate_sha} gate-code=${summary.gate_code_sha} artifacts=${artifactDir}`);
  }
}

if (require.main === module) main();

module.exports = {
  runIndependentChecks,
  validateScenarioConfiguration,
  LOCAL_CONFIG,
  LOCAL_CONFIG_EXAMPLE,
  OWNED_STAGE_TIMEOUT_GRACE_MS,
  RELEASE_HARNESS_ENV,
  SIMULATOR_STAGE_TIMEOUT_MS,
  gateEnvironment,
  installedBundleId,
  simulatorDeviceSetRoot,
  scenarioGateOptions,
  productionIosExportOptions,
  provisionCandidateLocalConfig,
  releaseSmoke,
  createReleaseTarget,
  releaseSimulatorBuildOptions,
  runGate,
  waitForLaunchReadiness,
};
