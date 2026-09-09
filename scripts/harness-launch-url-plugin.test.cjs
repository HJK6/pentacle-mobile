const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { patchAppDelegate, patchBundleScript, patchXcodeProject } = require('../plugins/withHarnessLaunchUrl');

const fixture = `import Expo

class AppDelegate: ExpoAppDelegate {
  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}`;

test('AppDelegate patch admits one simulator-only, environment-gated harness URL', () => {
  const patched = patchAppDelegate(fixture);
  assert.match(patched, /#if targetEnvironment\(simulator\)/);
  assert.match(patched, /[A-Z]+_ALLOW_HARNESS_LAUNCH_ARG/);
  assert.match(patched, /markers\.count == 1/);
  assert.match(patched, /url\.scheme == "[a-z-]+"/);
  assert.match(patched, /url\.host == "harness"/);
  assert.equal((patched.match(/effectiveLaunchOptions/g) || []).length, 3);
  assert.equal(patchAppDelegate(patched), patched);
});

test('AppDelegate patch admits the simulator-only, gated example device-token injection', () => {
  const patched = patchAppDelegate(fixture);
  // The synthetic device credential is accepted only by the simulator harness
  // branch, so it cannot affect a normal device build.
  assert.match(patched, /arguments\[\$0\] == "-[A-Za-z]+DeviceToken"/);
  assert.match(patched, /name: "install_[a-z_]+"/);
  assert.match(patched, /URLComponents\(url: url, resolvingAgainstBaseURL: false\)/);
  assert.equal(patchAppDelegate(patched), patched);
});

test('AppDelegate patch fails closed on an unknown native template', () => {
  assert.throws(() => patchAppDelegate('class AppDelegate {}'), /expected one AppDelegate launch signature/);
});

test('AppDelegate patch preserves tracked embedded-bundle semantics exactly', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'ios', 'Pentacle', 'AppDelegate.swift'), 'utf8');
  const patched = patchAppDelegate(source);
  assert.equal((patched.match(/[A-Z]+_E2E_EMBEDDED_BUNDLE/g) || []).length, 2);
  assert.equal((patched.match(/launchOptionsWithHarnessURL/g) || []).length, 2);
  assert.equal(patchAppDelegate(patched), patched);
});

const bundleScriptFixture = [
  '"if [[ \\"$CONFIGURATION\\" = *Debug* ]]; then',
  '  export SKIP_BUNDLING=1',
  'fi\\n"',
].join('\\n');

test('Xcode bundle phase keeps embedded-Debug bundling after a clean prebuild', () => {
  const patched = patchBundleScript(bundleScriptFixture);
  assert.match(patched, /[A-Z]+_E2E_EMBEDDED_DEBUG/);
  assert.match(patched, /unset SKIP_BUNDLING/);
  assert.match(patched, /export FORCE_BUNDLING=1/);
  assert.equal(patchBundleScript(patched), patched);

  const project = {
    hash: {
      project: {
        objects: {
          PBXShellScriptBuildPhase: {
            phase: { name: '"Bundle React Native code and images"', shellScript: bundleScriptFixture },
            phase_comment: 'Bundle React Native code and images',
          },
        },
      },
    },
  };
  assert.equal(patchXcodeProject(project), project);
  assert.equal(project.hash.project.objects.PBXShellScriptBuildPhase.phase.shellScript, patched);
});

test('Xcode bundle phase patch fails closed when the template phase is absent', () => {
  assert.throws(() => patchXcodeProject({ hash: { project: { objects: { PBXShellScriptBuildPhase: {} } } } }), /expected one/);
});
