import Expo
import React
import ReactAppDependencyProvider

@UIApplicationMain
public class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  private func launchOptionsWithHarnessURL(
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

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let effectiveLaunchOptions = launchOptionsWithHarnessURL(launchOptions)
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory
    bindReactNativeFactory(factory)

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: effectiveLaunchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: effectiveLaunchOptions)
  }

  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }

  // Universal Links
  public override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
    return super.application(application, continue: userActivity, restorationHandler: restorationHandler) || result
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  // Extension point for config-plugins

  override func sourceURL(for bridge: RCTBridge) -> URL? {
#if PENTACLE_E2E_EMBEDDED_BUNDLE
    bundleURL()
#elseif DEBUG
    // needed to return the correct URL for expo-dev-client.
    bridge.bundleURL ?? bundleURL()
#else
    bundleURL()
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
  }
}
