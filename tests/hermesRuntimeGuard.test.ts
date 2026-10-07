/**
 * Regression tests for the Hermes Debug-in-Release build defect (2026-07-20/21).
 *
 * Root cause: RN's replace_hermes_version.js caches its engine choice in
 * Pods/.last_build_configuration; a `pod install` can reset Pods/hermes-engine to
 * the Debug default while the marker still reads "Release", so a Release build
 * silently embeds the DEBUG engine and crashes on device (EXC_BAD_ACCESS in
 * HermesRuntimeImpl on the first JS task).
 *
 * Two defenses, both covered here:
 *   1. withHermesBuildState plugin — deletes the stale marker in the generated
 *      Podfile post_install so the build-time swap always re-runs; must be
 *      idempotent and must not crash prebuild when the Podfile isn't written yet.
 *   2. scripts/verify-hermes-runtime.cjs — a fail-closed build phase that compares
 *      the embedded engine against the per-configuration artifact tarball.
 *
 * These tests fail against the pre-fix implementations: the old verifier looked
 * for tarballs under node_modules (absent) and used a 1 MB buffer (ENOBUFS), so
 * it could never reach the compare; the old plugin threw ENOENT on a missing
 * Podfile.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const VERIFIER = path.join(REPO_ROOT, 'scripts', 'verify-hermes-runtime.cjs');
const DEVICE_SLICE = 'destroot/Library/Frameworks/universal/hermes.xcframework/ios-arm64/hermes.framework/hermes';
const SIMULATOR_SLICE = 'destroot/Library/Frameworks/universal/hermes.xcframework/ios-arm64_x86_64-simulator/hermes.framework/hermes';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-guard-'));
}

/** Write `bytes` to the canonical slice path under `rootDir` and return the file path. */
function writeSlice(rootDir: string, slice: string, bytes: Buffer): string {
  const dest = path.join(rootDir, slice);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bytes);
  return dest;
}

function isGnuTar(): boolean {
  return /GNU tar/.test(spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout ?? '');
}

/** Build a hermes artifact tarball whose ios-arm64 slice contains `bytes`. */
function makeArtifactTarball(
  artifactsDir: string,
  config: 'release' | 'debug',
  deviceBytes: Buffer,
  simulatorBytes: Buffer = deviceBytes,
): void {
  const staging = makeTempDir();
  writeSlice(staging, DEVICE_SLICE, deviceBytes);
  writeSlice(staging, SIMULATOR_SLICE, simulatorBytes);
  fs.mkdirSync(artifactsDir, { recursive: true });
  const tarPath = path.join(artifactsDir, `hermes-ios-0.81.5-${config}.tar.gz`);
  // Real artifacts store members with a leading "./", which bsdtar (macOS, where the
  // verifier runs) matches without the prefix. GNU tar matches names literally, so
  // on GNU hosts store the unprefixed names the verifier asks for.
  const prefix = isGnuTar() ? '' : './';
  execFileSync('tar', ['-czf', tarPath, '-C', staging, `${prefix}${DEVICE_SLICE}`, `${prefix}${SIMULATOR_SLICE}`]);
  fs.rmSync(staging, { recursive: true, force: true });
}

/**
 * Assemble a fake PODS_ROOT with debug+release artifact tarballs and a destroot
 * engine equal to `destrootBytes`. Returns the PODS_ROOT path.
 */
function makePodsRoot(
  releaseBytes: Buffer,
  debugBytes: Buffer,
  destrootBytes: Buffer,
  platform: 'iphoneos' | 'iphonesimulator' = 'iphoneos',
): string {
  const podsRoot = makeTempDir();
  const artifactsDir = path.join(podsRoot, 'hermes-engine-artifacts');
  makeArtifactTarball(artifactsDir, 'release', releaseBytes);
  makeArtifactTarball(artifactsDir, 'debug', debugBytes);
  writeSlice(
    path.join(podsRoot, 'hermes-engine'),
    platform === 'iphoneos' ? DEVICE_SLICE : SIMULATOR_SLICE,
    destrootBytes,
  );
  return podsRoot;
}

function runVerifier(config: string, podsRoot: string, platform = 'iphoneos') {
  return spawnSync('node', [VERIFIER, config], {
    env: { ...process.env, PODS_ROOT: podsRoot, PLATFORM_NAME: platform },
    encoding: 'utf8',
  });
}

// Distinct, larger-than-1MB payloads so the test also guards the ENOBUFS regression.
const RELEASE_BYTES = Buffer.alloc(2 * 1024 * 1024, 0x52); // 'R'
const DEBUG_BYTES = Buffer.alloc(2 * 1024 * 1024, 0x44); // 'D'

describe('verify-hermes-runtime.cjs (fail-closed Hermes engine guard)', () => {
  const created: string[] = [];
  afterAll(() => {
    for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('passes when the Release destroot matches the Release artifact', () => {
    const podsRoot = makePodsRoot(RELEASE_BYTES, DEBUG_BYTES, RELEASE_BYTES);
    created.push(podsRoot);
    const r = runVerifier('Release', podsRoot);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/runtime identity OK/);
  });

  test.each(['Release-Candidate', 'Release-Staging'])('normalizes %s to Release', (config) => {
    const podsRoot = makePodsRoot(RELEASE_BYTES, DEBUG_BYTES, RELEASE_BYTES);
    created.push(podsRoot);
    expect(runVerifier(config, podsRoot).status).toBe(0);
  });

  test.each(['Debug', 'Debug-Local'])('accepts the Debug artifact for %s', (config) => {
    const podsRoot = makePodsRoot(RELEASE_BYTES, DEBUG_BYTES, DEBUG_BYTES);
    created.push(podsRoot);
    expect(runVerifier(config, podsRoot).status).toBe(0);
  });

  test('FAILS closed when a Debug build carries the Release engine', () => {
    const podsRoot = makePodsRoot(RELEASE_BYTES, DEBUG_BYTES, RELEASE_BYTES);
    created.push(podsRoot);
    const r = runVerifier('Debug', podsRoot);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/runtime mismatch/);
  });

  test('checks the active simulator slice rather than a device-only canary', () => {
    const podsRoot = makePodsRoot(RELEASE_BYTES, DEBUG_BYTES, DEBUG_BYTES, 'iphonesimulator');
    created.push(podsRoot);
    const r = runVerifier('Release', podsRoot, 'iphonesimulator');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/runtime mismatch/);
  });

  test('FAILS closed when a Release build carries the Debug engine (the shipped bug)', () => {
    const podsRoot = makePodsRoot(RELEASE_BYTES, DEBUG_BYTES, DEBUG_BYTES);
    created.push(podsRoot);
    const r = runVerifier('Release', podsRoot);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/runtime mismatch/);
  });

  test('handles engines larger than 1MB (ENOBUFS regression)', () => {
    // RELEASE_BYTES is 2MB; a passing run proves the tar output was fully buffered.
    const podsRoot = makePodsRoot(RELEASE_BYTES, DEBUG_BYTES, RELEASE_BYTES);
    created.push(podsRoot);
    const r = runVerifier('Release', podsRoot);
    expect(r.status).toBe(0);
  });

  test('FAILS closed when the artifact tarball is missing', () => {
    const podsRoot = makeTempDir();
    created.push(podsRoot);
    writeSlice(path.join(podsRoot, 'hermes-engine'), DEVICE_SLICE, RELEASE_BYTES);
    const r = runVerifier('Release', podsRoot);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/inputs missing/);
  });

  test('rejects an unsupported configuration', () => {
    const podsRoot = makePodsRoot(RELEASE_BYTES, DEBUG_BYTES, RELEASE_BYTES);
    created.push(podsRoot);
    const r = runVerifier('Profiling', podsRoot);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Unsupported Hermes configuration/);
  });

  test('rejects an unsupported platform', () => {
    const podsRoot = makePodsRoot(RELEASE_BYTES, DEBUG_BYTES, RELEASE_BYTES);
    created.push(podsRoot);
    const r = runVerifier('Release', podsRoot, 'watchos');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Unsupported Hermes platform/);
  });
});

// The generated Podfile policy is Ruby; run it when Ruby exists (skip only on ENOENT). macOS dev hosts always
// ship it, so a missing Ruby there must fail loudly rather than skip.
const rubyTest = process.platform !== 'darwin' && (spawnSync('ruby', ['-v']).error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? test.skip : test;

describe('withHermesBuildState plugin (Podfile hooks)', () => {
  // Exercise only the dangerous (Podfile) mod: capture the mod fn, then drive it
  // against a temp Podfile. withXcodeProject is a no-op passthrough here.
  function loadDangerousMod() {
    jest.resetModules();
    let dangerousFn: ((cfg: any) => Promise<any>) | undefined;
    jest.doMock('@expo/config-plugins', () => ({
      withXcodeProject: (config: any) => config,
      withDangerousMod: (_config: any, [, fn]: [string, (cfg: any) => Promise<any>]) => {
        dangerousFn = fn;
        return _config;
      },
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../plugins/withHermesBuildState')({});
    return dangerousFn!;
  }

  // Mirrors the generated Podfile tail the plugin anchors on: `    )\n  end\nend\n`.
  const PODFILE = [
    "require File.join(...)",
    "",
    "target 'Pentacle' do",
    '  post_install do |installer|',
    '    react_native_post_install(',
    '      installer,',
    '    )',
    '  end',
    'end',
    '',
  ].join('\n');

  function driveWith(platformRoot: string) {
    const mod = loadDangerousMod();
    return mod({ modRequest: { platformProjectRoot: platformRoot } });
  }

  test('inserts the marker-deletion once and is idempotent on re-run', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'Podfile'), PODFILE);
    await driveWith(dir);
    let src = fs.readFileSync(path.join(dir, 'Podfile'), 'utf8');
    expect(src).toContain('pentacle-hermes-build-state');
    expect(src).toContain('.last_build_configuration');
    expect(src).toContain('pentacle-ios-deployment-target-floor');
    expect(src).toContain("minimum_ios_deployment_target = '15.0'");
    expect(src).toContain('installer.pods_project.targets.each do |target|');
    expect(src).toContain("build_configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET']");
    const firstCount = (src.match(/pentacle-hermes-build-state/g) || []).length;
    expect(firstCount).toBe(1);
    expect((src.match(/pentacle-ios-deployment-target-floor/g) || []).length).toBe(1);
    // second application must not duplicate
    await driveWith(dir);
    src = fs.readFileSync(path.join(dir, 'Podfile'), 'utf8');
    expect((src.match(/pentacle-hermes-build-state/g) || []).length).toBe(1);
    expect((src.match(/pentacle-ios-deployment-target-floor/g) || []).length).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('does not throw when the Podfile does not exist yet (non-clean prebuild)', async () => {
    const dir = makeTempDir(); // no Podfile written
    await expect(driveWith(dir)).resolves.toBeDefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  test.each(['missing anchor', PODFILE + '  end\nend\n'])('refuses a malformed or duplicate anchor without changing source', async source => {
    const dir = makeTempDir();
    try {
      fs.writeFileSync(path.join(dir, 'Podfile'), source);
      await expect(driveWith(dir)).rejects.toThrow('unique Podfile post_install hook');
      expect(fs.readFileSync(path.join(dir, 'Podfile'), 'utf8')).toBe(source);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  rubyTest('generated Ruby policy raises older targets but never lowers newer ones', async () => {
    const dir = makeTempDir();
    try {
      fs.writeFileSync(path.join(dir, 'Podfile'), PODFILE);
      await driveWith(dir);
      const source = fs.readFileSync(path.join(dir, 'Podfile'), 'utf8');
      const start = source.indexOf('    # pentacle-ios-deployment-target-floor');
      const policy = source.slice(start, source.lastIndexOf('  end\nend\n'));
      const fakeProgram = `require 'json'
require 'rubygems'
Configuration = Struct.new(:build_settings)
Target = Struct.new(:build_configurations)
Project = Struct.new(:targets)
Installer = Struct.new(:pods_project)
configs = [nil, '13.0', '15.0', '17.2'].map { |value| Configuration.new({'IPHONEOS_DEPLOYMENT_TARGET' => value}) }
installer = Installer.new(Project.new([Target.new(configs)]))
${policy}
puts JSON.generate(configs.map { |config| config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] })`;
      const ruby = fs.existsSync('/opt/homebrew/opt/ruby/bin/ruby') ? '/opt/homebrew/opt/ruby/bin/ruby' : 'ruby';
      const result = spawnSync(ruby, ['-e', fakeProgram], { encoding: 'utf8' });
      expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(['15.0', '15.0', '15.0', '17.2']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

});
