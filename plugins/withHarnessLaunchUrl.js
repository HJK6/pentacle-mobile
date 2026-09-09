const HELPER_NAME = 'launchOptionsWithHarnessURL';
const BUNDLE_PHASE_NAME = 'Bundle React Native code and images';
const DEFAULT_DEBUG_BUNDLE = [
  'if [[ \\"$CONFIGURATION\\" = *Debug* ]]; then',
  '  export SKIP_BUNDLING=1',
  'fi',
].join('\\n');
const EMBEDDED_DEBUG_BUNDLE = [
  'if [[ \\"$CONFIGURATION\\" = *Debug* ]]; then',
  '  if [[ \\"$PENTACLE_E2E_EMBEDDED_DEBUG\\" = \\"1\\" ]]; then',
  '    unset SKIP_BUNDLING',
  '    export FORCE_BUNDLING=1',
  '  else',
  '    export SKIP_BUNDLING=1',
  '  fi',
  'fi',
].join('\\n');

function replaceExactlyOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`withHarnessLaunchUrl expected one ${label}`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + needle.length)}`;
}

function patchAppDelegate(source) {
  const signature = `  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()`;
  const helper = `  private func ${HELPER_NAME}(
    _ launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> [UIApplication.LaunchOptionsKey: Any]? {
#if targetEnvironment(simulator)
    let environment = ProcessInfo.processInfo.environment
    let arguments = ProcessInfo.processInfo.arguments
    let markers = arguments.indices.filter { arguments[$0] == "-HarnessUrl" }
    if environment["PENTACLE_ALLOW_HARNESS_LAUNCH_ARG"] == "1",
       markers.count == 1,
       arguments.indices.contains(markers[0] + 1),
       let url = URL(string: arguments[markers[0] + 1]),
       url.scheme == "pentacle",
       url.host == "harness" {
      var effective = launchOptions ?? [:]
      var effectiveURL = url
      let tokenMarkers = arguments.indices.filter { arguments[$0] == "-PentacleDeviceToken" }
      if tokenMarkers.count == 1,
         arguments.indices.contains(tokenMarkers[0] + 1),
         var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
        var items = components.queryItems ?? []
        items.append(URLQueryItem(name: "install_device_token", value: arguments[tokenMarkers[0] + 1]))
        components.queryItems = items
        if let merged = components.url { effectiveURL = merged }
      }
      effective[.url] = effectiveURL
      return effective
    }
#endif
    return launchOptions
  }

${signature.replace(
    '    let delegate = ReactNativeDelegate()',
    `    let effectiveLaunchOptions = ${HELPER_NAME}(launchOptions)\n    let delegate = ReactNativeDelegate()`
  )}`;

  let patched = source;
  if (!patched.includes(`private func ${HELPER_NAME}(`)) {
    patched = replaceExactlyOnce(patched, signature, helper, 'AppDelegate launch signature');
    patched = replaceExactlyOnce(
      patched,
      '      launchOptions: launchOptions)',
      '      launchOptions: effectiveLaunchOptions)',
      'React Native launch-options handoff'
    );
    patched = replaceExactlyOnce(
      patched,
      '    return super.application(application, didFinishLaunchingWithOptions: launchOptions)',
      '    return super.application(application, didFinishLaunchingWithOptions: effectiveLaunchOptions)',
      'UIApplicationDelegate launch-options handoff'
    );
  }
  return patchReadinessObserver(patchEmbeddedBundleSource(patched));
}

function patchReadinessObserver(source) {
  if (source.includes('PENTACLE_GATE_READY_NONCE')) return source;
  const anchor = '    let delegate = ReactNativeDelegate()';
  const observer = `#if targetEnvironment(simulator)
    if let nonce = ProcessInfo.processInfo.environment["PENTACLE_GATE_READY_NONCE"], !nonce.isEmpty {
      NotificationCenter.default.addObserver(forName: NSNotification.Name("RCTContentDidAppearNotification"), object: nil, queue: .main) { _ in
        let receipt: [String: Any] = ["nonce": nonce, "bundle_id": Bundle.main.bundleIdentifier ?? "", "pid": ProcessInfo.processInfo.processIdentifier, "created_at": Date().timeIntervalSince1970 * 1000]
        if let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
           let data = try? JSONSerialization.data(withJSONObject: receipt) {
          try? data.write(to: directory.appendingPathComponent(".pentacle-gate-ready.json"), options: .atomic)
        }
      }
    }
#endif
${anchor}`;
  return replaceExactlyOnce(source, anchor, observer, 'native-content readiness observer');
}

function patchEmbeddedBundleSource(source) {
  if (source.includes('#if PENTACLE_E2E_EMBEDDED_BUNDLE')) return source;
  if (!source.includes('override func sourceURL(for bridge: RCTBridge)')
    && !source.includes('override func bundleURL()')) return source;
  const unpatched = `  override func sourceURL(for bridge: RCTBridge) -> URL? {
    // needed to return the correct URL for expo-dev-client.
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }`;
  const patched = `  override func sourceURL(for bridge: RCTBridge) -> URL? {
#if PENTACLE_E2E_EMBEDDED_BUNDLE
    bundleURL()
#else
    bridge.bundleURL ?? bundleURL()
#endif
  }

  override func bundleURL() -> URL? {
#if PENTACLE_E2E_EMBEDDED_BUNDLE
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#elseif DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }`;
  return replaceExactlyOnce(source, unpatched, patched, 'React Native bundle source');
}

function unquote(value) {
  return typeof value === 'string' ? value.replace(/^"|"$/g, '') : value;
}

function patchBundleScript(source) {
  if (source.includes('PENTACLE_E2E_EMBEDDED_DEBUG')) return source;
  return replaceExactlyOnce(source, DEFAULT_DEBUG_BUNDLE, EMBEDDED_DEBUG_BUNDLE, 'Debug bundle phase');
}

function patchXcodeProject(project) {
  const phases = project.hash?.project?.objects?.PBXShellScriptBuildPhase;
  const matches = Object.entries(phases || {}).filter(
    ([key, phase]) => !key.endsWith('_comment') && unquote(phase?.name) === BUNDLE_PHASE_NAME,
  );
  if (matches.length !== 1) {
    throw new Error(`withHarnessLaunchUrl expected one ${BUNDLE_PHASE_NAME} phase`);
  }
  matches[0][1].shellScript = patchBundleScript(matches[0][1].shellScript);
  return project;
}

function withHarnessLaunchUrl(config) {
  const { withAppDelegate, withXcodeProject } = require('@expo/config-plugins');
  const withDelegate = withAppDelegate(config, (mod) => {
    if (mod.modResults.language !== 'swift') {
      throw new Error('withHarnessLaunchUrl requires a Swift AppDelegate');
    }
    mod.modResults.contents = patchAppDelegate(mod.modResults.contents);
    return mod;
  });
  return withXcodeProject(withDelegate, (mod) => {
    patchXcodeProject(mod.modResults);
    return mod;
  });
}

module.exports = withHarnessLaunchUrl;
module.exports.patchAppDelegate = patchAppDelegate;
module.exports.patchEmbeddedBundleSource = patchEmbeddedBundleSource;
module.exports.patchBundleScript = patchBundleScript;
module.exports.patchXcodeProject = patchXcodeProject;
