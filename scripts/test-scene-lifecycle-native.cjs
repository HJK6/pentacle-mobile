#!/usr/bin/env node
'use strict';

// Executes the generated scene adapter and the lock-resolved Expo notification
// manager/emitter. UIKit, the factory, module DSL and serializer are test
// boundaries; actual UIKit linkage is separately tested by the iOS simulator.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { SCENE_DELEGATE } = require('../plugins/withSceneLifecycle');
if (process.platform !== 'darwin') throw new Error('This Swift execution check requires macOS/Xcode');
const project = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pentacle-scene-test-'));
function write(name, text) { fs.writeFileSync(path.join(temporary, name), text); }
function run(command, args) {
  const result = spawnSync(command, args, { cwd: temporary, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, DYLD_LIBRARY_PATH: temporary } });
  if (result.error || result.status !== 0) throw new Error(`${command}: ${result.error || result.stderr || result.stdout}`);
  return result.stdout;
}
try {
  write('UserNotifications.swift', `
import Foundation
public class UNNotificationContent: NSObject { public var userInfo: [AnyHashable: Any] = [:] }
public class UNNotificationRequest: NSObject { public let content = UNNotificationContent() }
public class UNNotification: NSObject { public let request = UNNotificationRequest() }
public class UNNotificationResponse: NSObject { public let notification = UNNotification() }
public struct UNNotificationPresentationOptions: OptionSet {
  public let rawValue: Int
  public init(rawValue: Int) { self.rawValue = rawValue }
}
public protocol UNUserNotificationCenterDelegate: AnyObject {}
public class UNUserNotificationCenter: NSObject {
  public static let instance = UNUserNotificationCenter()
  public weak var delegate: UNUserNotificationCenterDelegate?
  public static func current() -> UNUserNotificationCenter { instance }
}
`);
  write('UIKit.swift', `
@_exported import Foundation
@_exported import UserNotifications
open class UIResponder: NSObject {}
public protocol UIWindowSceneDelegate: AnyObject {}
public enum UIBackgroundFetchResult { case noData }
public class UIApplication: NSObject {
  public static let shared = UIApplication()
  public var delegate: AnyObject?
  public struct LaunchOptionsKey: Hashable { public let rawValue: String; public init(rawValue: String) { self.rawValue = rawValue } }
  public struct OpenURLOptionsKey: Hashable {
    public let rawValue: String
    public static let openInPlace = Self(rawValue: "openInPlace")
    public static let sourceApplication = Self(rawValue: "sourceApplication")
    public static let annotation = Self(rawValue: "annotation")
  }
}
public class UIScene: NSObject {
  public class OpenURLOptions: NSObject { public var openInPlace = false; public var sourceApplication: String?; public var annotation: Any? }
  public class ConnectionOptions: NSObject {
    public var urlContexts = Set<UIOpenURLContext>()
    public var userActivities = Set<NSUserActivity>()
    public var notificationResponse: UNNotificationResponse?
  }
}
public class UIWindowScene: UIScene {}
public class UISceneSession: NSObject {}
public class UIUserActivityRestoring: NSObject {}
public class UIViewController: NSObject {}
public class UIWindow: NSObject {
  public let windowScene: UIWindowScene
  public var rootViewController: UIViewController?
  public var visible = false
  public init(windowScene: UIWindowScene) { self.windowScene = windowScene }
  public func makeKeyAndVisible() { visible = true }
}
public class UIOpenURLContext: NSObject {
  public let url: URL
  public let options = UIScene.OpenURLOptions()
  public init(_ url: URL) { self.url = url }
}
`);
  write('ExpoModulesCore.swift', `
@_exported import UIKit
public struct ModuleDefinition {}
@resultBuilder public struct ModuleDefinitionBuilder {
  public static func buildBlock(_ items: Void...) -> ModuleDefinition { ModuleDefinition() }
}
public protocol AnyModule: AnyObject {
  @ModuleDefinitionBuilder func definition() -> ModuleDefinition
}
open class BaseModule: NSObject {
  public var sentEvents: [(String, [String: Any])] = []
  public func sendEvent(_ name: String, _ payload: [String: Any]) { sentEvents.append((name, payload)) }
}
public typealias Module = AnyModule & BaseModule
public func Name(_ value: String) {}
public func Events(_ value: [String]) {}
public func OnCreate(_ body: () -> Void) { body() }
public func OnDestroy(_ body: () -> Void) {}
public func Function<T>(_ name: String, _ body: () -> T) {}
`);
  for (const module of ['UserNotifications', 'UIKit', 'ExpoModulesCore']) {
    run('xcrun', ['swiftc', '-emit-module', '-emit-library', '-module-name', module,
      `${module}.swift`, '-I', temporary, '-L', temporary,
      ...(module === 'UserNotifications' ? [] : ['-lUserNotifications']),
      ...(module === 'ExpoModulesCore' ? ['-lUIKit'] : []), '-o', `lib${module}.dylib`]);
  }
  const files = [
    'node_modules/expo-notifications/ios/EXNotifications/Notifications/NotificationCenterManager.swift',
    'node_modules/expo-notifications/ios/EXNotifications/Notifications/Emitter/EmitterModule.swift',
  ];
  const provenance = {};
  for (const file of files) {
    const contents = fs.readFileSync(path.join(project, file));
    provenance[file] = crypto.createHash('sha256').update(contents).digest('hex');
    write(path.basename(file), contents);
  }
  write('SceneDelegate.swift', 'import UIKit\n' + SCENE_DELEGATE);
  write('Support.swift', `
import UIKit
import ExpoModulesCore
class Factory {
  var starts = 0
  var options: [UIApplication.LaunchOptionsKey: Any]?
  func startReactNative(withModuleName: String, in window: UIWindow?, launchOptions: [UIApplication.LaunchOptionsKey: Any]?) {
    precondition(withModuleName == "main"); starts += 1; options = launchOptions
    window?.rootViewController = UIViewController()
  }
}
class AppDelegate: NSObject {
  var window: UIWindow?
  var reactNativeFactory: Factory? = Factory()
  var sceneLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?
  var links: [URL] = []
  var activities: [NSUserActivity] = []
  var callbacks: [String] = []
  func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any]) -> Bool {
    links.append(url); precondition(options[.openInPlace] as? Bool == true); return true
  }
  func application(_ app: UIApplication, continue activity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
    activities.append(activity); return true
  }
  func applicationDidBecomeActive(_ app: UIApplication) { callbacks.append("active") }
  func applicationWillResignActive(_ app: UIApplication) { callbacks.append("inactive") }
  func applicationDidEnterBackground(_ app: UIApplication) { callbacks.append("background") }
  func applicationWillEnterForeground(_ app: UIApplication) { callbacks.append("foreground") }
}
class EXNotificationSerializer {
  static func serializedNotification(_ notification: UNNotification) -> [String: Any] { ["data": notification.request.content.userInfo] }
  static func serializedNotificationResponse(_ response: UNNotificationResponse) -> [String: Any] { serializedNotification(response.notification) }
}
`);
  write('main.swift', `
import UIKit
import ExpoModulesCore
let app = AppDelegate()
UIApplication.shared.delegate = app
let delegate = PentacleSceneDelegate()
let scene = UIWindowScene()
let session = UISceneSession()
let options = UIScene.ConnectionOptions()
let url = URL(string: "pentacle://enroll")!
let context = UIOpenURLContext(url); context.options.openInPlace = true
options.urlContexts.insert(context)
let activity = NSUserActivity(activityType: NSUserActivityTypeBrowsingWeb)
activity.webpageURL = URL(string: "https://example.com/enroll")!
options.userActivities.insert(activity)
let response = UNNotificationResponse()
response.notification.request.content.userInfo = ["incident_nonce": "synthetic-cold-response"]
options.notificationResponse = response
let originalKey = UIApplication.LaunchOptionsKey(rawValue: "original")
app.sceneLaunchOptions = [originalKey: "retained"]
// Real SDK manager is installed before the scene, like its app subscriber.
let manager = NotificationCenterManager.shared
precondition(UNUserNotificationCenter.current().delegate === manager)
delegate.scene(scene, willConnectTo: session, options: options)
precondition(app.reactNativeFactory!.starts == 1)
precondition(delegate.window === app.window && app.window?.windowScene === scene && app.window!.visible)
let launches = app.reactNativeFactory!.options!
precondition(launches[originalKey] as? String == "retained")
precondition(launches[UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsURLKey")] as? URL == url)
let dictionary = launches[UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsUserActivityDictionaryKey")] as! [String: Any]
precondition(dictionary["UIApplicationLaunchOptionsUserActivityKey"] as? NSUserActivity === activity)
let data = launches[UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsRemoteNotificationKey")] as! [AnyHashable: Any]
precondition(data["incident_nonce"] as? String == "synthetic-cold-response")
precondition(app.links == [url] && app.activities == [activity])
// Scene did not inject a duplicate response. UIKit's delegate callback queues
// this cold response until the real Expo emitter is created.
precondition(manager.pendingResponses.isEmpty)
var completions = 0
manager.userNotificationCenter(UNUserNotificationCenter.current(), didReceive: response) { completions += 1 }
precondition(manager.pendingResponses.count == 1 && completions == 1)
let emitter = EmitterModule(); _ = emitter.definition()
precondition(manager.pendingResponses.isEmpty && emitter.sentEvents.count == 1)
precondition(emitter.sentEvents[0].0 == onDidReceiveNotificationResponse)
let eventData = emitter.sentEvents[0].1["data"] as! [AnyHashable: Any]
precondition(eventData["incident_nonce"] as? String == "synthetic-cold-response")
let anotherConsumer = EmitterModule(); _ = anotherConsumer.definition()
precondition(anotherConsumer.sentEvents.isEmpty && emitter.sentEvents.count == 1)
delegate.scene(scene, openURLContexts: [context]); delegate.scene(scene, continue: activity)
precondition(app.links == [url, url] && app.activities == [activity, activity])
delegate.sceneWillResignActive(scene); delegate.sceneDidEnterBackground(scene)
delegate.sceneWillEnterForeground(scene); delegate.sceneDidBecomeActive(scene)
precondition(app.callbacks == ["inactive", "background", "foreground", "active"])
let originalRoot = app.window!.rootViewController!
delegate.sceneDidDisconnect(scene)
precondition(delegate.window == nil)
let reconnect = UIWindowScene()
delegate.scene(reconnect, willConnectTo: session, options: UIScene.ConnectionOptions())
precondition(app.reactNativeFactory!.starts == 1 && app.window!.rootViewController === originalRoot)
precondition(app.window!.windowScene === reconnect)
precondition(PentacleSceneDelegate.launchOptions(nil, UIScene.ConnectionOptions()) == nil)
print("SCENE_NATIVE_PASS: factory/window, cold+warm links, resume callbacks, queued Expo response once")
`);
  run('xcrun', ['swiftc', 'SceneDelegate.swift', 'Support.swift', 'NotificationCenterManager.swift', 'EmitterModule.swift', 'main.swift',
    '-I', temporary, '-L', temporary, '-lUIKit', '-lUserNotifications', '-lExpoModulesCore', '-o', 'scene-test']);
  process.stdout.write(run(path.join(temporary, 'scene-test'), []));
  process.stdout.write(JSON.stringify({ expo: require('expo/package.json').version, notificationSources: provenance,
    generatedSceneSha256: crypto.createHash('sha256').update(SCENE_DELEGATE).digest('hex'),
    boundaries: ['UIKit/UserNotifications', 'React Native factory', 'Expo module DSL', 'notification serializer'] }) + '\n');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
