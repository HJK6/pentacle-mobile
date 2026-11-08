# Focused native image gestures

`ImageViewerUITests.swift` uses XCUITest's two-touch `pinch(withScale:velocity:)`,
then actual pan, double-tap, fit-only paging, edge and single-tap-close gestures.
It checks the current image occurrence and its reported native zoom, retaining
screenshots in the result bundle. IDB single-touch actions do not prove pinch.
This focused journey supplements the unchanged certified nine-case gate.

The allocation owner must first supply an owned simulator, an installed Release
app with the existing diagnostic harness JS flavor and a disposable scripted
mock chat containing the three-image fixture (tall, wide, repeated tall). The
normal configured Release app's native/config identities and diagnostic
build differences must be recorded separately. No live daemon credential or
outbound message is required. This fixture never enrolls a phone.

Generate the project outside the checkout using the provisioned Ruby/xcodeproj:

```sh
PENTACLE_VIEWER_HARNESS_URL='<synthetic harness URL>' \
  ruby test/e2e/image_viewer/prepare.rb /absolute/owned/output <installed-app-id>
```

The URL arms the existing `autoaccept_biometric,disable_pentacle_auth,open_existing_chat`
actions and supplies `ws_url`, `host`, `provider`, `stream_id`, `scenario`,
`scenario_run_id` and a bounded `pre_open_wait_ms`. Keep real credentials out of
URLs, source and receipts. The helper only generates a simulator-only test
project; it does not build, install, boot, erase or close anything.

Within a named native window, bind the source/app/config hashes, runtime,
exact destination UUID and owned companion/mock process identities, then run:

```sh
xcodebuild -project /absolute/owned/output/ImageViewerGestures.xcodeproj \
  -scheme ImageViewerGestures -configuration Release \
  -destination id=<owned-simulator-uuid> \
  -derivedDataPath /absolute/owned/derived \
  -resultBundlePath /absolute/owned/result.xcresult \
  -parallel-testing-enabled NO test
```

Retain the actual result, screenshots and observed zoom/page sequence. A build
or source check is not native gesture proof. Classify test setup/injection
failures separately from product failures; do not change product behavior to
satisfy a broken driver. Shut down/delete only allocated resources and stop
only the owned test helpers at the end of the window.
