'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { runOwnedSync } = require('./owned-process.cjs');

const REQUIRED_TOOLS = Object.freeze([
  'node', 'npm', 'npx', 'git', 'python3', 'sim-queue', 'idb', 'idb_companion',
  'ps', 'plutil', 'xcodebuild', 'xcrun', 'sandbox-exec', 'hdiutil', 'codesign',
  'defaults', 'lsof', 'sysctl', 'pod', 'ruby', 'iostat',
]);
// Caller-supplied values that would let a stale outer shell steer the certified children. The facade
// sets the quiet receipt itself; owned-process sets its own group receipt per child.
const STRIPPED = Object.freeze(['npm_config_cache', 'PENTACLE_GATE_QUIET_RECEIPT', 'PENTACLE_OWNED_GROUP_RECEIPT']);
const PROBE_TIMEOUT_MS = 5000;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function canonicalChildEnvironment(repository, inherited = process.env, home = os.userInfo().homedir, nodeExecutable = process.execPath) {
  const environment = { ...inherited };
  const prefix = [path.join(home, '.local', 'bin'), path.join(repository, 'node_modules', '.bin'),
    path.dirname(nodeExecutable), '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  environment.PATH = [...new Set([...prefix, ...(inherited.PATH || '').split(path.delimiter).filter(Boolean)])].join(path.delimiter);
  for (const name of STRIPPED) delete environment[name];
  return environment;
}

function resolveExecutable(name, environment) {
  for (const directory of (environment.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {}
  }
  throw new Error(`CERTIFIED_LAUNCH_DEPENDENCY_MISSING:${name}`);
}

// The gate runs idb under the interpreter named by idb's own shebang (storage-gate hostUserSitePackages),
// not whichever python3 is first on PATH. Probe that same interpreter, or the probe proves the wrong thing.
function idbInterpreter(launcher, environment) {
  const firstLine = fs.readFileSync(launcher, 'utf8').split(/\r?\n/, 1)[0];
  const match = /^#!\s*(\/\S+)(?:\s+(\S+))?\s*$/.exec(firstLine);
  if (match && path.basename(match[1]) === 'env' && /^python(?:3(?:\.\d+)?)?$/.test(match[2] || '')) return resolveExecutable(match[2], environment);
  if (match && !match[2] && /^python(?:3(?:\.\d+)?)?$/.test(path.basename(match[1]))) return match[1];
  throw new Error('CERTIFIED_LAUNCH_DEPENDENCY_INTERPRETER:idb');
}

// Resolution and import probes only, executed under the child environment the gate will see. No
// companion, queue, simulator, application, install or host repair; the environment is not mutated.
function probeChildEnvironment(repository, environment, run = runOwnedSync, tmpdir = os.tmpdir()) {
  const tools = Object.fromEntries(REQUIRED_TOOLS.map(name => [name, resolveExecutable(name, environment)]));
  const interpreter = idbInterpreter(tools.idb, environment);
  const commands = [];
  const probe = (label, executable, args, childEnvironment = environment) => {
    const result = run(executable, args, { cwd: repository, env: childEnvironment,
      timeout: PROBE_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    commands.push({ probe: label, executable_sha256: digest(fs.readFileSync(executable)),
      status: result.status, error: result.error?.code || null,
      stdout_sha256: digest(result.stdout || ''), stderr_sha256: digest(result.stderr || ''),
      group_alive_after: result.ownership?.group_alive_after ?? null });
    if (result.error || result.status !== 0 || result.ownership?.group_alive_after !== false) {
      throw new Error(`CERTIFIED_LAUNCH_DEPENDENCY_PROBE:${label}`);
    }
    return String(result.stdout || '');
  };
  probe('node', tools.node, ['--version']);
  probe('npm', tools.npm, ['--version']);
  probe('git', tools.git, ['--version']);
  probe('pod', tools.pod, ['--version']);
  probe('ruby', tools.ruby, ['--version']);
  probe('xcode-version', tools.xcodebuild, ['-version']);
  probe('simulator-sdk', tools.xcrun, ['--sdk', 'iphonesimulator', '--show-sdk-path']);
  probe('sim-queue', tools['sim-queue'], ['--help']);
  let site;
  try { site = JSON.parse(probe('idb-user-site', interpreter, ['-c', 'import json, site; print(json.dumps(site.getusersitepackages()))'])); }
  catch (error) { if (String(error.message).startsWith('CERTIFIED_LAUNCH_')) throw error; throw new Error('CERTIFIED_LAUNCH_DEPENDENCY_PROBE:idb-user-site'); }
  if (typeof site !== 'string' || !path.isAbsolute(site) || !fs.existsSync(path.join(site, 'idb'))) throw new Error('CERTIFIED_LAUNCH_DEPENDENCY_IMPORT:idb');
  // The gate redirects HOME into scratch and prepends the host user site to PYTHONPATH; prove the import
  // under exactly that wiring. The probe HOME is a path that is never created.
  const redirected = { ...environment, HOME: path.join(tmpdir, `pentacle-certified-probe-home-${process.pid}-absent`),
    PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: [site, environment.PYTHONPATH].filter(Boolean).join(path.delimiter) };
  try { probe('idb-import-redirected-home', interpreter, ['-c', 'import idb, idb.cli.main'], redirected); }
  catch { throw new Error('CERTIFIED_LAUNCH_DEPENDENCY_IMPORT:idb'); }
  return { schema: 1, tools: Object.fromEntries(Object.entries(tools).map(([name, file]) => [name, {
    executable_sha256: digest(fs.readFileSync(file)), path_sha256: digest(file),
  }])), idb_interpreter_sha256: digest(interpreter), path_sha256: digest(environment.PATH),
  python_user_site_sha256: digest(site), commands, global_environment_changed: false };
}

module.exports = { REQUIRED_TOOLS, STRIPPED, canonicalChildEnvironment, resolveExecutable, idbInterpreter, probeChildEnvironment };
