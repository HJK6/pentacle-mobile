#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const APP_DELEGATE = 'ios/Pentacle/AppDelegate.swift';
const PROJECT = 'ios/Pentacle.xcodeproj/project.pbxproj';
const CHAT_CORE_PATH = 'pentacle-chat-core';
const CHAT_CORE_REMOTE = process.env.PENTACLE_CHAT_CORE_REMOTE || 'https://github.com/example-org/pentacle-chat-core.git';
const DERIVED_PATHS = [PROJECT, APP_DELEGATE];
let activeEnvironment = null;

function parseArgs(argv) {
  const parsed = { candidate: 'HEAD', outputDir: '/private/tmp', help: false };
  const positional = [];
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg === '--candidate' || arg === '--output-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      parsed[arg === '--candidate' ? 'candidate' : 'outputDir'] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown argument: ${arg}`);
    positional.push(arg);
  }
  if (positional.length > 2) throw new Error('expected at most candidate and output-dir positional arguments');
  if (positional[0]) parsed.candidate = positional[0];
  if (positional[1]) parsed.outputDir = positional[1];
  return parsed;
}

function git(cwd, args, options = {}) {
  return execFileSync('git', args, { cwd, env: activeEnvironment || process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', options.quiet ? 'pipe' : 2] }).trim();
}

function gateCandidateCloneSource(environment = process.env) {
  return fs.realpathSync(environment.PENTACLE_GATE_REPOSITORY_ROOT || ROOT);
}

function localSubmoduleUpdateCommand(sourceRoot) {
  const source = fs.realpathSync(path.join(sourceRoot, CHAT_CORE_PATH));
  return {
    args: [
      '-c', `url.${source}.insteadOf=${CHAT_CORE_REMOTE}`,
      '-c', 'protocol.file.allow=always',
      'submodule', 'update', '--init', '--recursive',
    ],
    environment: { GIT_ALLOW_PROTOCOL: 'file' },
  };
}

function commandEnvironment(overrides = {}, inherited = process.env) {
  const environment = { ...inherited };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return environment;
}

function run(cwd, command, args, environment = {}) {
  const argv = activeEnvironment && process.env.PENTACLE_STORAGE_SANDBOXED !== '1'
    ? require('./storage-sandbox.cjs').sandboxed([command, ...args])
    : [command, ...args];
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env: commandEnvironment(environment, activeEnvironment || process.env),
    stdio: ['inherit', 2, 2],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}`);
}

function updateSubmodulesFromLocal(repositoryRoot, sourceRoot) {
  const expected = git(repositoryRoot, ['rev-parse', `HEAD:${CHAT_CORE_PATH}`], { quiet: true });
  const source = fs.realpathSync(path.join(sourceRoot, CHAT_CORE_PATH));
  try { git(source, ['cat-file', '-e', `${expected}^{commit}`], { quiet: true }); }
  catch { throw new Error('LOCAL_SUBMODULE_OBJECT_MISSING'); }
  const command = localSubmoduleUpdateCommand(sourceRoot);
  run(repositoryRoot, 'git', command.args, command.environment);
  const actual = git(path.join(repositoryRoot, CHAT_CORE_PATH), ['rev-parse', 'HEAD'], { quiet: true });
  if (actual !== expected) throw new Error('LOCAL_SUBMODULE_HEAD_MISMATCH');
}

function replaceExactly(source, before, after, count, label) {
  const actual = source.split(before).length - 1;
  if (actual !== count) throw new Error(`expected ${count} ${label} entries, found ${actual}`);
  return source.split(before).join(after);
}

function patchProject(source) {
  let patched = replaceExactly(
    source,
    'PRODUCT_BUNDLE_IDENTIFIER = quest.pentacle.mobile;',
    'PRODUCT_BUNDLE_IDENTIFIER = com.example.pentacle.harness;',
    2,
    'bundle identifier',
  );
  patched = replaceExactly(
    patched,
    'PRODUCT_NAME = "Pentacle";',
    'PRODUCT_NAME = "PentacleHarness";',
    2,
    'product name',
  );
  return patched;
}

function makeModulemapsOwnerWritable(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) makeModulemapsOwnerWritable(target);
    else if (entry.isFile() && entry.name.endsWith('.modulemap')) fs.chmodSync(target, fs.statSync(target).mode | 0o200);
  }
}

function nativePrebuildEnvironment() {
  return { EXPO_PUBLIC_HARNESS: undefined };
}

function defaultPrepare(nativeRoot) {
  run(nativeRoot, 'npm', ['ci']);
  fs.copyFileSync(
    path.join(nativeRoot, 'pentacle.config.example.ts'),
    path.join(nativeRoot, 'pentacle.config.local.ts'),
    fs.constants.COPYFILE_EXCL,
  );
  run(nativeRoot, 'npx', ['expo', 'prebuild', '-p', 'ios', '--clean'], nativePrebuildEnvironment());
}

function assertRootLocal(nativeRoot, target, label) {
  if (!fs.existsSync(target)) throw new Error(`${label} is missing`);
  const real = fs.realpathSync(target);
  if (!real.startsWith(`${nativeRoot}${path.sep}`)) throw new Error(`${label} must be inside the native root`);
}

function validateNativeRoot(nativeRoot, candidateSha, candidateOrigin) {
  nativeRoot = fs.realpathSync(nativeRoot);
  if (git(nativeRoot, ['remote', 'get-url', 'origin'], { quiet: true }) !== candidateOrigin) {
    throw new Error('origin does not match the candidate checkout');
  }
  if (git(nativeRoot, ['status', '--porcelain=v1', '--untracked-files=all'], { quiet: true })) {
    throw new Error('repository is dirty');
  }
  if (git(nativeRoot, ['rev-parse', 'HEAD^'], { quiet: true }) !== candidateSha) {
    throw new Error('derived commit parent does not match the candidate');
  }
  // The contract is that the derived commit touches NOTHING BUT the native identity paths — not
  // that it touches all of them. Requiring equality also required every generated file to differ
  // after prebuild, which was only incidentally true: once the plugin-patched AppDelegate was
  // committed (1007d320), prebuild regenerated it byte-identically, it dropped out of this diff,
  // and the whole gate failed NATIVE_BUILD_FAILED:17 at main. A generated file that already equals
  // its committed form is a legitimate no-op, and the transform equality checked just below still
  // proves the derived content is exactly the expected transformation either way.
  //
  // `--no-renames` is required, not cosmetic: with rename detection on, `--name-only` reports only
  // a rename's DESTINATION, so `foreign.swift -> ios/Pentacle/AppDelegate.swift` presents as a lone
  // identity path and the nothing-but contract silently does not hold.
  const paths = git(nativeRoot, ['diff', '--name-only', '--no-renames', 'HEAD^', 'HEAD'], { quiet: true }).split('\n').filter(Boolean);
  const foreign = paths.filter((candidate) => !DERIVED_PATHS.includes(candidate));
  if (!paths.length || foreign.length) throw new Error('derived commit does not contain the exact native identity paths');
  // lstat, not stat: a symlinked identity file would let the checks below read content that is not
  // embedded in the product. KNOWN LIMITATION: a hardlink to a file outside the root still passes,
  // because a hardlink has no target path to resolve — the inode is genuinely present in the tree
  // and indistinguishable from an ordinary file by path inspection. Refusing multiply-linked inodes
  // outright (st_nlink > 1) was considered and rejected: it would reject legitimate trees, and git
  // commits content rather than links, so the derived commit's bytes are unaffected either way.
  for (const identity of DERIVED_PATHS) {
    const target = path.join(nativeRoot, identity);
    const stats = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stats || !stats.isFile()) throw new Error(`${identity} must be an embedded regular file`);
    assertRootLocal(nativeRoot, target, identity);
  }
  const { patchAppDelegate } = require(path.join(nativeRoot, 'plugins', 'withHarnessLaunchUrl.js'));
  const parentAppDelegate = git(nativeRoot, ['show', `${candidateSha}:${APP_DELEGATE}`]);
  const parentProject = git(nativeRoot, ['show', `${candidateSha}:${PROJECT}`]);
  const derivedAppDelegate = fs.readFileSync(path.join(nativeRoot, APP_DELEGATE), 'utf8');
  if (derivedAppDelegate !== patchAppDelegate(`${parentAppDelegate}\n`)) {
    throw new Error('AppDelegate does not match the exact harness launch transformation');
  }
  // NOTE: the equality above is transform-RELATIVE, and both of its inputs come from the candidate's
  // own tree — the plugin is `require`d out of it and short-circuits on an already-patched
  // AppDelegate — so for a committed-patched candidate it reduces to `x === x`. That is deliberate,
  // not an oversight. This file does NOT attempt to prove the harness launch gate is wired.
  //
  // A source-substring assertion cannot prove wiring: fragments can sit in comments or string
  // literals, a helper can be defined but never reached, and any negated fragment risks a FALSE
  // REJECT that blocks every merge through this gate. That risk is real harm; the assurance is not.
  //
  // The wiring is proven BEHAVIOURALLY, on the artifact that actually ships:
  //   1. MERGE-BLOCKING: `test/e2e/run_scenario.py` asserts `harness:harness_armed` at runtime
  //      (~:1654) before any scenario work, with a cause chain naming the first broken link. This
  //      always executes on the gate path — full-gate requires the sim-e2e stage and throws on a
  //      non-PASS verdict — so no candidate reaches merge without an app that actually armed.
  //   2. FAIL-FAST ONLY: `test/e2e/harness/simulator.py` `native_harness_launch_gate_failures`
  //      (~:1704) scans the built product's Mach-O images for PENTACLE_ALLOW_HARNESS_LAUNCH_ARG.
  //      It is reached only when PENTACLE_E2E_MOCK_ONLY is truthy (~:1973), so it is a fast, clear
  //      failure for mock-only scenario runs — NOT part of the merge-blocking path.
  // (1) is what makes dropping a lexical check here sound: it proves arming behaviourally rather
  // than inferring it from source text. Keep the proof there; do not reintroduce a lexical check.
  if (fs.readFileSync(path.join(nativeRoot, PROJECT), 'utf8') !== patchProject(`${parentProject}\n`)) {
    throw new Error('Xcode project does not match the exact harness identity transformation');
  }
  assertRootLocal(nativeRoot, path.join(nativeRoot, 'node_modules'), 'node_modules');
  assertRootLocal(nativeRoot, path.join(nativeRoot, 'pentacle.config.local.ts'), 'pentacle.config.local.ts');
  assertRootLocal(nativeRoot, path.join(nativeRoot, 'ios', 'Pentacle.xcworkspace'), 'generated workspace');
  return {
    root: nativeRoot,
    candidate_sha: candidateSha,
    derived_sha: git(nativeRoot, ['rev-parse', 'HEAD'], { quiet: true }),
  };
}

function defaultVerify(nativeRoot, candidateRoot, candidateSha, candidateOrigin) {
  let verifierRoot = candidateRoot;
  let temporaryRoot;
  if (git(candidateRoot, ['rev-parse', 'HEAD'], { quiet: true }) !== candidateSha) {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-native-root-verify-'));
    run(temporaryRoot, 'git', ['clone', '--no-checkout', '--quiet', candidateOrigin, 'candidate']);
    verifierRoot = path.join(temporaryRoot, 'candidate');
    run(verifierRoot, 'git', ['checkout', '--detach', '--quiet', candidateSha]);
  }
  try {
    const invocation = nativePreflightInvocation(nativeRoot, verifierRoot, candidateSha);
    run(invocation.cwd, invocation.command, invocation.args, invocation.environment);
  } finally {
    if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function nativePreflightInvocation(nativeRoot, candidateRoot, candidateSha) {
  return {
    cwd: candidateRoot,
    command: process.execPath,
    args: [path.join(ROOT, 'scripts', 'full-gate.cjs'), '--preflight'],
    environment: {
      PENTACLE_GATE_NATIVE_ROOT: nativeRoot,
      PENTACLE_GATE_CANONICAL_RUNNER: '1',
      PENTACLE_GATE_CANDIDATE_SHA: candidateSha,
      PENTACLE_GATE_CODE_SHA: process.env.PENTACLE_GATE_CODE_SHA,
      PENTACLE_GATE_CODE_TREE_CLEAN: process.env.PENTACLE_GATE_CODE_TREE_CLEAN,
    },
  };
}

function buildNativeRoot(options = {}) {
  const candidateRoot = fs.realpathSync(options.candidateRoot || ROOT);
  const candidate = options.candidate || 'HEAD';
  const outputDir = path.resolve(options.outputDir || '/private/tmp');
  const candidateSha = git(candidateRoot, ['rev-parse', `${candidate}^{commit}`], { quiet: true });
  const candidateOrigin = git(candidateRoot, ['remote', 'get-url', 'origin'], { quiet: true });
  const nativeRoot = path.join(outputDir, `pentacle-mobile-native-${candidateSha.slice(0, 12)}`);
  const prepare = options.prepare || defaultPrepare;
  const verify = options.verify || defaultVerify;

  if (
    git(candidateRoot, ['rev-parse', 'HEAD'], { quiet: true }) === candidateSha
    && git(candidateRoot, ['status', '--porcelain=v1', '--untracked-files=all'], { quiet: true })
  ) {
    throw new Error('candidate checkout must be clean');
  }
  if (nativeRoot === candidateRoot || nativeRoot.startsWith(`${candidateRoot}${path.sep}`)) {
    throw new Error('output directory must be outside the candidate checkout');
  }

  if (fs.existsSync(nativeRoot)) {
    try {
      const evidence = validateNativeRoot(fs.realpathSync(nativeRoot), candidateSha, candidateOrigin);
      verify(nativeRoot, candidateRoot, candidateSha, candidateOrigin);
      return { ...evidence, reused: true };
    } catch (error) {
      throw new Error(`existing native root is not reusable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  fs.mkdirSync(outputDir, { recursive: true });
  run(outputDir, 'git', ['clone', '--no-checkout', candidateOrigin, path.basename(nativeRoot)]);
  run(nativeRoot, 'git', ['checkout', '--detach', candidateSha]);
  updateSubmodulesFromLocal(nativeRoot, candidateRoot);
  prepare(nativeRoot);
  run(nativeRoot, 'git', ['checkout', candidateSha, '--', 'ios']);

  const { patchAppDelegate } = require(path.join(nativeRoot, 'plugins', 'withHarnessLaunchUrl.js'));
  const appDelegate = `${git(nativeRoot, ['show', `${candidateSha}:${APP_DELEGATE}`])}\n`;
  const project = `${git(nativeRoot, ['show', `${candidateSha}:${PROJECT}`])}\n`;
  fs.writeFileSync(path.join(nativeRoot, APP_DELEGATE), patchAppDelegate(appDelegate));
  fs.writeFileSync(path.join(nativeRoot, PROJECT), patchProject(project));
  makeModulemapsOwnerWritable(path.join(nativeRoot, 'ios'));
  run(nativeRoot, 'git', ['add', '-f', '--', ...DERIVED_PATHS]);
  run(nativeRoot, 'git', [
    '-c', 'user.name=Pentacle Native Root Builder',
    '-c', 'user.email=native-root@pentacle.invalid',
    'commit', '--quiet', '-m', 'build: derive gate native identity',
  ]);

  const evidence = validateNativeRoot(nativeRoot, candidateSha, candidateOrigin);
  verify(nativeRoot, candidateRoot, candidateSha, candidateOrigin);
  return { ...evidence, reused: false };
}

function buildForRun(runId, candidateRef) {
  const { fixedLayout } = require('./storage-authority.cjs');
  const layout = fixedLayout();
  // NOTE: must not be named `run` -- that shadows the module-level `run()`
  // command helper below, making every run(...) call in this function throw
  // "run is not a function" and rendering the native-root build unrunnable.
  const runRecord = require('./storage-state.cjs').readRecord('runs', runId);
  if (runRecord.state !== 'allocated' || runRecord.candidate_ref !== candidateRef) throw new Error('RUN_NATIVE_BUILD_AUTHORITY');
  const resolved = require('./storage-containers.cjs').resolveMounted('scratch', runId);
  require('./storage-containers.cjs').requireSeal(resolved.seal, runRecord.scratch_seal);
  activeEnvironment = {
    ...process.env,
    HOME: path.join(layout.scratchMount, 'home'),
    TMPDIR: path.join(layout.scratchMount, 'tmp'),
    XDG_CACHE_HOME: path.join(layout.scratchMount, 'cache'),
    XDG_CONFIG_HOME: path.join(layout.scratchMount, 'config'),
    GIT_OPTIONAL_LOCKS: '0',
  };
  try {
    const candidateRoot = path.join(layout.scratchMount, 'candidate');
    if (fs.existsSync(candidateRoot)) throw new Error('RUN_CANDIDATE_COLLISION');
    const cloneSource = gateCandidateCloneSource();
    run(layout.scratchMount, 'git', ['clone', '--no-checkout', cloneSource, 'candidate']);
    run(candidateRoot, 'git', ['checkout', '--detach', candidateRef]);
    updateSubmodulesFromLocal(candidateRoot, cloneSource);
    run(candidateRoot, 'npm', ['ci']);
    const config = path.join(candidateRoot, 'pentacle.config.example.ts');
    if (!fs.lstatSync(config).isFile() || fs.statSync(config).size > require('./storage-containers.cjs').LIMITS.config) throw new Error('CONTAINER_CAP_EXCEEDED');
    return buildNativeRoot({ candidateRoot, candidate: 'HEAD', outputDir: path.join(layout.scratchMount, 'native') });
  }
  finally { activeEnvironment = null; }
}

if (require.main === module) {
  process.stderr.write('build-native-root is internal; use gate:native-root with a candidate ref\n');
  process.exitCode = 1;
}

module.exports = {
  buildForRun,
  commandEnvironment,
  gateCandidateCloneSource,
  localSubmoduleUpdateCommand,
  nativePreflightInvocation,
  nativePrebuildEnvironment,
  patchProject,
  validateNativeRoot,
};
