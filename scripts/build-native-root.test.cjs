'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const builder = require('./build-native-root.cjs');
const EXPECTED_ROOT = fs.realpathSync(path.join(__dirname, '..'));
const EXPECTED_SUBMODULE_PATH = 'pentacle-chat-core';
const EXPECTED_SUBMODULE_REMOTE = process.env.PENTACLE_CHAT_CORE_REMOTE || 'https://github.com/example-org/pentacle-chat-core.git';

test('gate candidate clone source is the local invoking repository', () => {
  const source = builder.gateCandidateCloneSource();
  assert.equal(source, EXPECTED_ROOT);
  assert.equal(path.isAbsolute(source), true);
  assert.doesNotMatch(source, /^(?:https?|ssh|git):\/\/|^[^/]+@[^:]+:/i);
});

test('snapshot builder keeps the candidate clone source on the invoking repository', () => {
  assert.equal(builder.gateCandidateCloneSource({ PENTACLE_GATE_REPOSITORY_ROOT: EXPECTED_ROOT }), EXPECTED_ROOT);
});

test('macOS gate sandbox builds both clone stages from local repositories with remote transports disabled', { skip: process.platform !== 'darwin' ? 'requires macOS sandbox-exec' : false }, () => {
  const containerRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.homedir()), '.pentacle-builder-local-clone-'));
  const roots = ['scratch', 'evidence', 'state'].map((name) => {
    const target = path.join(containerRoot, name);
    fs.mkdirSync(target);
    return fs.realpathSync(target);
  });
  try {
    const profile = require('./storage-sandbox.cjs').renderProfile({ writeRoots: roots.slice(0, 2), readOnlyRoots: [roots[2]] });
    const environment = { ...process.env, GIT_ALLOW_PROTOCOL: 'file', GIT_SSH_COMMAND: '/usr/bin/false', HOME: path.join(roots[0], 'home') };
    fs.mkdirSync(environment.HOME);
    const sandboxedGit = (cwd, args, overrides = {}) => spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/git', ...args], { cwd, encoding: 'utf8', env: { ...environment, ...overrides } });
    const updateSubmodules = (cwd, sourceRoot) => {
      const command = builder.localSubmoduleUpdateCommand(sourceRoot);
      assert.deepEqual(command, {
        args: [
          '-c', `url.${fs.realpathSync(path.join(sourceRoot, EXPECTED_SUBMODULE_PATH))}.insteadOf=${EXPECTED_SUBMODULE_REMOTE}`,
          '-c', 'protocol.file.allow=always',
          'submodule', 'update', '--init', '--recursive',
        ],
        environment: { GIT_ALLOW_PROTOCOL: 'file' },
      });
      return sandboxedGit(cwd, command.args, command.environment);
    };
    const candidateSha = spawnSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: EXPECTED_ROOT, encoding: 'utf8' }).stdout.trim();
    const submoduleSha = spawnSync('/usr/bin/git', ['rev-parse', `HEAD:${EXPECTED_SUBMODULE_PATH}`], { cwd: EXPECTED_ROOT, encoding: 'utf8' }).stdout.trim();
    const candidateRoot = path.join(roots[0], 'candidate');
    const cloned = sandboxedGit(roots[0], ['clone', '--no-checkout', EXPECTED_ROOT, candidateRoot]);
    assert.equal(cloned.status, 0, cloned.stderr);
    const candidateCheckout = sandboxedGit(candidateRoot, ['checkout', '--detach', candidateSha]);
    assert.equal(candidateCheckout.status, 0, candidateCheckout.stderr);
    const candidateSubmodules = updateSubmodules(candidateRoot, EXPECTED_ROOT);
    assert.equal(candidateSubmodules.status, 0, candidateSubmodules.stderr);
    const origin = spawnSync('/usr/bin/git', ['remote', 'get-url', 'origin'], { cwd: candidateRoot, encoding: 'utf8' });
    assert.equal(origin.status, 0, origin.stderr);
    assert.equal(origin.stdout.trim(), EXPECTED_ROOT);
    assert.equal(spawnSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: path.join(candidateRoot, EXPECTED_SUBMODULE_PATH), encoding: 'utf8' }).stdout.trim(), submoduleSha);

    const nativeRoot = path.join(roots[0], 'native');
    const nativeClone = sandboxedGit(roots[0], ['clone', '--no-checkout', origin.stdout.trim(), nativeRoot]);
    assert.equal(nativeClone.status, 0, nativeClone.stderr);
    const nativeCheckout = sandboxedGit(nativeRoot, ['checkout', '--detach', candidateSha]);
    assert.equal(nativeCheckout.status, 0, nativeCheckout.stderr);
    const nativeSubmodules = updateSubmodules(nativeRoot, candidateRoot);
    assert.equal(nativeSubmodules.status, 0, nativeSubmodules.stderr);
    assert.equal(spawnSync('/usr/bin/git', ['remote', 'get-url', 'origin'], { cwd: nativeRoot, encoding: 'utf8' }).stdout.trim(), EXPECTED_ROOT);
    assert.equal(spawnSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: path.join(nativeRoot, EXPECTED_SUBMODULE_PATH), encoding: 'utf8' }).stdout.trim(), submoduleSha);
  } finally {
    fs.rmSync(containerRoot, { recursive: true, force: true });
  }
});

test('native builder exports only the ID-bound mutator and pure helpers', () => {
  assert.deepEqual(Object.keys(builder).sort(), ['buildForRun', 'commandEnvironment', 'gateCandidateCloneSource', 'localSubmoduleUpdateCommand', 'nativePreflightInvocation', 'nativePrebuildEnvironment', 'patchProject', 'validateNativeRoot'].sort());
  assert.equal(builder.buildNativeRoot, undefined);
  assert.equal(builder.parseArgs, undefined);
});

test('native builder preflight executes canonical gate code against the candidate checkout', () => {
  const invocation = builder.nativePreflightInvocation('/native/root', '/candidate/root', 'a'.repeat(40));
  assert.equal(invocation.cwd, '/candidate/root');
  assert.deepEqual(invocation.args, [path.join(EXPECTED_ROOT, 'scripts', 'full-gate.cjs'), '--preflight']);
  assert.equal(invocation.environment.PENTACLE_GATE_NATIVE_ROOT, '/native/root');
  assert.equal(invocation.environment.PENTACLE_GATE_CANONICAL_RUNNER, '1');
  assert.equal(invocation.environment.PENTACLE_GATE_CANDIDATE_SHA, 'a'.repeat(40));
});

test('direct path-taking native builder CLI is retired', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'build-native-root.cjs'), '--output-dir', '/tmp/escape'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /internal/);
});

test('prebuild strips inherited harness mode before identity patching', () => {
  assert.deepEqual(builder.commandEnvironment(builder.nativePrebuildEnvironment(), { PATH: '/bin', EXPO_PUBLIC_HARNESS: '1', KEEP_ME: 'yes' }), { PATH: '/bin', KEEP_ME: 'yes' });
});

test('ID-bound builder rejects path-shaped direct internal authority', () => {
  assert.throws(() => builder.buildForRun('/tmp/tree', 'HEAD'), /OPAQUE_ID_INVALID/);
});

test('builder worker accepts only an opaque run id and never a path', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'storage-builder-worker.cjs'), '/tmp/tree'], { encoding: 'utf8' });
  assert.equal(result.status, 17);
  assert.match(result.stderr, /ID_ONLY/);
});

// Regression (spec_example_2026_01): the derived
// commit's path set was compared for EQUALITY against DERIVED_PATHS, which additionally demanded
// that every native identity file differ after prebuild. Once the plugin-patched AppDelegate was
// committed (1007d320), prebuild regenerated it byte-identically, it dropped out of the derived
// diff, and the whole gate failed NATIVE_BUILD_FAILED:17 at main. The contract is nothing-BUT
// native identity paths, not all-of-them.
const ORIGIN = 'https://example.invalid/repo.git';
// patchProject requires exactly two bundle-identifier and two product-name entries.
// A minimally harness-complete AppDelegate: helper, marker, call site and both handoffs.
const GATE_BASE = [
  'import Expo',
  '  private func launchOptionsWithHarnessURL(',
  '    let e = environment["PENTACLE_ALLOW_HARNESS_LAUNCH_ARG"]',
  '  }',
  '    let effectiveLaunchOptions = launchOptionsWithHarnessURL(launchOptions)',
  '      launchOptions: effectiveLaunchOptions)',
  '    return super.application(application, didFinishLaunchingWithOptions: effectiveLaunchOptions)',
  '',
].join('\n');
const PROJECT_BASE = [
  'PRODUCT_BUNDLE_IDENTIFIER = quest.pentacle.mobile;',
  'PRODUCT_NAME = "Pentacle";',
  'PRODUCT_BUNDLE_IDENTIFIER = quest.pentacle.mobile;',
  'PRODUCT_NAME = "Pentacle";',
].join('\n');

function derivedRoot({ appDelegateDiffers, appDelegateContent = GATE_BASE }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-root-')));
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '--quiet');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('remote', 'add', 'origin', ORIGIN);
  fs.mkdirSync(path.join(root, 'ios', 'Pentacle.xcodeproj'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ios', 'Pentacle'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
  // The real plugin short-circuits when the helper is already present, so an already-patched
  // candidate transforms to itself. `appDelegateDiffers` picks which of those two worlds we are in.
  fs.writeFileSync(
    path.join(root, 'plugins', 'withHarnessLaunchUrl.js'),
    appDelegateDiffers
      ? 'module.exports.patchAppDelegate = (s) => `${s}// patched\n`;\n'
      : 'module.exports.patchAppDelegate = (s) => s;\n',
  );
  fs.writeFileSync(path.join(root, 'ios', 'Pentacle.xcodeproj', 'project.pbxproj'), PROJECT_BASE);
  fs.writeFileSync(path.join(root, 'ios', 'Pentacle', 'AppDelegate.swift'), appDelegateContent);
  // These exist in a real native root but are ignored; the validator only requires them to be local.
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\npentacle.config.local.ts\nios/Pentacle.xcworkspace/\n');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'candidate');
  const candidateSha = git('rev-parse', 'HEAD').stdout.trim();
  // Prebuild always rewrites the project file; it rewrites AppDelegate only when the committed
  // copy is not already the plugin's own output.
  fs.writeFileSync(path.join(root, 'ios', 'Pentacle.xcodeproj', 'project.pbxproj'), builder.patchProject(`${PROJECT_BASE}\n`));
  if (appDelegateDiffers) {
    fs.writeFileSync(path.join(root, 'ios', 'Pentacle', 'AppDelegate.swift'), `${appDelegateContent}// patched\n`);
  }
  git('add', '-A');
  git('commit', '--quiet', '-m', 'derived');
  // Local-root assertions that follow the path check.
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ios', 'Pentacle.xcworkspace'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pentacle.config.local.ts'), 'export default {};\n');
  return { root, candidateSha };
}

test('derived commit is accepted when the committed AppDelegate already matches the plugin output', () => {
  const { root, candidateSha } = derivedRoot({ appDelegateDiffers: false });
  try {
    assert.doesNotThrow(() => builder.validateNativeRoot(root, candidateSha, ORIGIN));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('derived commit is still accepted when both native identity paths differ', () => {
  const { root, candidateSha } = derivedRoot({ appDelegateDiffers: true });
  try {
    assert.doesNotThrow(() => builder.validateNativeRoot(root, candidateSha, ORIGIN));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('derived commit is rejected when it touches anything outside the native identity paths', () => {
  const { root, candidateSha } = derivedRoot({ appDelegateDiffers: true });
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  fs.writeFileSync(path.join(root, 'smuggled.txt'), 'nope\n');
  git('add', '--', 'smuggled.txt');
  git('commit', '--quiet', '--amend', '--no-edit');
  try {
    assert.throws(() => builder.validateNativeRoot(root, candidateSha, ORIGIN), /native identity paths/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('derived commit is rejected when it changes no native identity path at all', () => {
  const { root, candidateSha } = derivedRoot({ appDelegateDiffers: false });
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('reset', '--quiet', '--hard', candidateSha);
  git('commit', '--quiet', '--allow-empty', '-m', 'derived');
  try {
    assert.throws(() => builder.validateNativeRoot(root, candidateSha, ORIGIN), /native identity paths/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The lexical harness-gate assertion that briefly lived here was removed deliberately: a
// source-substring check cannot prove wiring and risks false-rejecting every merge. Wiring is
// proven behaviourally on the built product — see the NOTE in validateNativeRoot. What remains
// here is what path inspection CAN honestly prove.
function gateLessRoot(appDelegateContent) {
  return derivedRoot({ appDelegateDiffers: false, appDelegateContent });
}

test('a gate-less AppDelegate is NOT rejected here — that proof lives on the built product', () => {
  // Documents the deliberate boundary: this validator checks derived-path identity and transform
  // equality, not wiring. `native_harness_launch_gate_failures` and the runtime harness_armed
  // assertion are what reject a product that cannot arm.
  const { root, candidateSha } = gateLessRoot('import Expo\n// nothing harness about this\n');
  try {
    assert.doesNotThrow(() => builder.validateNativeRoot(root, candidateSha, ORIGIN));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a symlinked native identity file is rejected', () => {
  const { root, candidateSha } = derivedRoot({ appDelegateDiffers: false });
  const target = path.join(root, 'ios', 'Pentacle', 'AppDelegate.swift');
  const outside = path.join(root, '..', `outside-${path.basename(root)}.swift`);
  fs.writeFileSync(outside, GATE_BASE);
  fs.unlinkSync(target);
  fs.symlinkSync(outside, target);
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('add', '--', 'ios/Pentacle/AppDelegate.swift');
  git('commit', '--quiet', '--amend', '--no-edit');
  try {
    assert.throws(() => builder.validateNativeRoot(root, candidateSha, ORIGIN), /embedded regular file|inside the native root/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test('rename detection is disabled, so a rename reports both endpoints to the path check', () => {
  // QA probe on 14044ab3, reproduced here: for a PURE rename (destination absent in the parent),
  // `git diff --name-only` reports only the DESTINATION, so `foreign.swift ->
  // ios/Pentacle/AppDelegate.swift` presents as a lone identity path and the nothing-but contract
  // does not hold at this check. `--no-renames` reports both endpoints, so the foreign source is
  // visible. Downstream checks catch some shapes of this, but the path check must not rely on that.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rename-')));
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  try {
    git('init', '--quiet');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    fs.mkdirSync(path.join(root, 'ios', 'Pentacle'), { recursive: true });
    fs.writeFileSync(path.join(root, 'foreign.swift'), GATE_BASE);
    git('add', '-A');
    git('commit', '--quiet', '-m', 'candidate');
    git('mv', 'foreign.swift', 'ios/Pentacle/AppDelegate.swift');
    git('commit', '--quiet', '-m', 'derived');

    const detected = git('diff', '--name-only', 'HEAD^', 'HEAD').stdout.split('\n').filter(Boolean);
    const literal = git('diff', '--name-only', '--no-renames', 'HEAD^', 'HEAD').stdout.split('\n').filter(Boolean);

    assert.deepEqual(detected, ['ios/Pentacle/AppDelegate.swift']);
    assert.deepEqual(literal, ['foreign.swift', 'ios/Pentacle/AppDelegate.swift']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
