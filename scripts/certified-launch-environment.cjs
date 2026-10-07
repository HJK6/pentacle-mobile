'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { runOwnedSync } = require('./owned-process.cjs');

const REQUIRED_TOOLS = Object.freeze([
  'node', 'npm', 'npx', 'git', 'python3', 'sim-queue', 'idb', 'idb_companion',
  'ps', 'plutil', 'xcodebuild', 'xcrun', 'sandbox-exec', 'hdiutil', 'codesign',
  'defaults', 'lsof', 'sysctl',
]);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function canonicalChildEnvironment(repository, inherited = process.env) {
  const environment = { ...inherited };
  const home = os.userInfo().homedir;
  const prefix = [path.join(home, '.local', 'bin'), path.join(repository, 'node_modules', '.bin'),
    path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  environment.PATH = [...new Set([...prefix, ...(inherited.PATH || '').split(path.delimiter)])].join(path.delimiter);
  delete environment.npm_config_cache;
  return environment;
}

function resolveExecutable(name, environment) {
  for (const directory of (environment.PATH || '').split(path.delimiter)) {
    const candidate = path.join(directory, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {}
  }
  throw new Error(`CERTIFIED_LAUNCH_DEPENDENCY_MISSING:${name}`);
}

function probeChildEnvironment(repository, environment) {
  const tools = Object.fromEntries(REQUIRED_TOOLS.map(name => [name, resolveExecutable(name, environment)]));
  const commands = [];
  const probe = (name, args, childEnvironment = environment) => {
    const result = runOwnedSync(tools[name], args, { cwd: repository, env: environment,
      ...{ env: childEnvironment },
      timeout: 5000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    commands.push({ tool: name, executable_sha256: digest(fs.readFileSync(tools[name])),
      status: result.status, error: result.error?.code || null,
      stdout_sha256: digest(result.stdout || ''), stderr_sha256: digest(result.stderr || ''),
      ownership: result.ownership });
    if (result.error || result.status !== 0 || result.ownership?.group_alive_after !== false) {
      throw new Error(`CERTIFIED_LAUNCH_DEPENDENCY_PROBE:${name}`);
    }
    return result.stdout;
  };
  probe('sim-queue', ['--help']);
  // Import only; no companion, queue, simulator or application is started.
  const python = JSON.parse(probe('python3', ['-c', 'import idb, json, site, sys; print(json.dumps({"python": sys.version.split()[0], "user_site": site.getusersitepackages()}))']));
  environment.PYTHONPATH = [python.user_site, environment.PYTHONPATH].filter(Boolean).join(path.delimiter);
  // The real wrapper redirects HOME. Prove imports still resolve with that redirect
  // and the same explicit user-site wiring, without creating a probe home or cache.
  probe('python3', ['-c', 'import idb, idb.cli.main'], {
    ...environment, HOME: path.join(os.tmpdir(), 'pentacle-certified-empty-probe-home'), PYTHONDONTWRITEBYTECODE: '1',
  });
  return { schema: 1, tools: Object.fromEntries(Object.entries(tools).map(([name, file]) => [name, {
    executable_sha256: digest(fs.readFileSync(file)), path_sha256: digest(file),
  }])), path_sha256: digest(environment.PATH), python_version: python.python,
  python_user_site_sha256: digest(python.user_site), commands, global_environment_changed: false };
}

module.exports = { REQUIRED_TOOLS, canonicalChildEnvironment, resolveExecutable, probeChildEnvironment };
