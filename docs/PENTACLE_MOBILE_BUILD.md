# Native builds

Install Node dependencies with npm ci, then copy
pentacle.config.example.ts to pentacle.config.local.ts. Set a reachable
daemon websocket URL and your own app identifiers there. Never commit that file.

Run npm run test:unit and npm run validate before building. On macOS with
Xcode installed, run npx expo prebuild -p ios --clean, then npm run ios
to build and launch a simulator. Prebuild regenerates the native project;
keep intentional native changes in config plugins before using --clean.

For an iPhone, set your own bundle identifier and signing team in Xcode, enable
Developer Mode on the paired device, then run
npx expo run:ios --configuration Release --device.
For production builds set PENTACLE_PROD_BUILD=1 and a positive
PENTACLE_BUILD_NUMBER; see [Versioning](VERSIONING.md).

After installing, verify the installed bundle identifier and build version match
the signed app, launch it, open a chat, send a message, and confirm the assistant
reply renders. A successful build or launch alone does not prove connectivity.

## Production host-sigil preflight

`npm run ios:device`, `npm run ios:release`, and the certified full gate refuse a production build
when any configured host lacks an explicit `djinni | sun | mage | flower | ibis` sigil. The full gate runs
the guard inside its existing `ios-export` stage, before Expo starts, so positional host attribution
cannot reach a release artifact while the release receipt keeps its established stage inventory. The
guard names each offending host id; coverage is the frozen
`tests/fixtures/hostSigilGuard.fixture.json` fixture.

## iOS scene lifecycle on SDK 54

Apps linked with the iOS 27 SDK must adopt scenes to launch on iOS 27.
This app declares one `PentacleSceneDelegate` through `withSceneLifecycle`.
The app delegate still creates and binds the public `ExpoReactNativeFactory`;
the scene creates its window and starts module `main`. The window is also
available on the app delegate for React Native 0.81 and Expo module compatibility.
A scene reconnection reuses the existing root instead of starting another engine.

Cold URLs and browsing activities become React Native launch options; scene
URL/activity callbacks use the existing Expo/RCTLinkingManager overrides.
Scene foreground/background callbacks reach Expo's app delegate subscribers.
Notification responses remain on the existing UN notification center delegate,
which queues cold responses for Expo's notification emitter. The scene must not
dispatch that response a second time. SecureStore options and signing entitlements
are independent of this adapter and remain unchanged.

The lock resolves Expo 54.0.37 from the declared `~54.0.33` range. SDK 54 has no
`ExpoAppSceneDelegate` or `enableSceneSupport` setting; this local plugin uses its
public factory API and follows Expo's window and link migration. When upgrading
Expo, replace the adapter with the SDK's built-in integration. See
[Expo's scene lifecycle guide](https://github.com/expo/fyi/blob/main/ios-scene-lifecycle.md)
and [the SDK 57 scene backport](https://github.com/expo/expo/pull/50191).

`tests/sceneLifecycle.test.ts` checks plugin composition, repeated generation,
manifest safety and unsupported templates. On macOS it also runs
`node scripts/test-scene-lifecycle-native.cjs`: executable generated Swift plus
the locked Expo notification manager/emitter, with explicit platform, factory,
module DSL and serialization stubs. This proves cold response replay once;
actual UIKit compilation and JavaScript AppState background/active delivery
require a Release simulator build. A disposable diagnostic JS subscriber may
capture AppState without changing the shipped entry or certified runner; retain
its bundle provenance and the candidate native executable hash separately.

Use only synthetic config for these rehearsals, and remove the owned ignored
`pentacle.config.local.ts` stand-in afterward. Simulator checks do not prove
physical Face ID, existing protected-token access or APNs delivery.
