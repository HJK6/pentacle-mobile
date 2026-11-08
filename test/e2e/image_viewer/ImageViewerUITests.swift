import XCTest

/// Focused native gesture proof, separate from the unchanged certified nine-case gate.
final class ImageViewerUITests: XCTestCase {
  private var app: XCUIApplication!
  private var image: XCUIElement { app.images["image-viewer-image"] }
  private var scroll: XCUIElement { app.scrollViews.containing(.image, identifier: "image-viewer-image").firstMatch }

  override func setUpWithError() throws {
    continueAfterFailure = false
    let environment = ProcessInfo.processInfo.environment
    guard let appID = environment["PENTACLE_VIEWER_APP_ID"],
          let url = environment["PENTACLE_VIEWER_HARNESS_URL"] else {
      throw NSError(domain: "ImageViewerFixture", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Missing owned synthetic app/launch URL"])
    }
    app = XCUIApplication(bundleIdentifier: appID)
    app.launchEnvironment["PENTACLE_ALLOW_HARNESS_LAUNCH_ARG"] = "1"
    app.launchArguments = ["-HarnessUrl", url]
    app.launch()
    let thumbnails = app.descendants(matching: .any).matching(identifier: "assistant-message-image-0-img")
    XCTAssertTrue(thumbnails.firstMatch.waitForExistence(timeout: 20))
    guard let middle = thumbnails.allElementsBoundByIndex.first(where: { $0.isHittable && $0.frame.height < 200 }) else {
      XCTFail("Expected the middle wide image in the synthetic three-image chat")
      return
    }
    middle.tap()
    XCTAssertTrue(image.waitForExistence(timeout: 5))
    XCTAssertEqual(image.label, "Chat image 2 of 3")
    XCTAssertTrue(waitForZoom { abs($0 - 1) < 0.02 })
  }

  private func waitForZoom(_ matches: @escaping (Double) -> Bool) -> Bool {
    var lastValue: String?
    let predicate = NSPredicate { [weak self] _, _ in
      guard let raw = self?.image.value as? String,
            let percentage = Double(raw.components(separatedBy: "%")[0]) else { return false }
      if lastValue != raw { print("Observed native viewer zoom: \(raw)"); lastValue = raw }
      return matches(percentage / 100)
    }
    return XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: image)], timeout: 6) == .completed
  }

  private func capture(_ name: String) {
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  func testRealPinchPanDoubleTapAndFitOnlyPaging() {
    capture("contain-fit")
    // XCTest synthesizes two simultaneous touches; IDB single-touch is not used.
    scroll.pinch(withScale: 2, velocity: 1)
    XCTAssertTrue(waitForZoom { $0 > 1.1 && $0 <= 4.01 })
    capture("two-finger-pinch")
    scroll.swipeLeft()
    XCTAssertTrue(image.exists)
    XCTAssertEqual(image.label, "Chat image 2 of 3", "Zoomed horizontal movement must pan")
    capture("zoomed-pan")
    image.doubleTap()
    XCTAssertTrue(waitForZoom { abs($0 - 1) < 0.02 })
    XCTAssertTrue(image.exists, "Double-tap must not also dismiss")
    scroll.swipeLeft()
    let lastImage = app.images.matching(NSPredicate(format: "identifier == %@ AND label == %@", "image-viewer-image", "Chat image 3 of 3")).firstMatch
    XCTAssertTrue(lastImage.waitForExistence(timeout: 5))
    XCTAssertTrue(waitForZoom { abs($0 - 1) < 0.02 })
    scroll.swipeLeft()
    XCTAssertEqual(image.label, "Chat image 3 of 3", "Last edge must not wrap")
    capture("new-page-at-fit")
    image.doubleTap()
    XCTAssertTrue(waitForZoom { abs($0 - 2) < 0.05 })
    // Drive beyond the boundary: synthesized finger travel need not equal scale exactly.
    scroll.pinch(withScale: 4, velocity: 1)
    XCTAssertTrue(waitForZoom { abs($0 - 4) < 0.02 })
    scroll.pinch(withScale: 1.3, velocity: 1)
    XCTAssertTrue(waitForZoom { abs($0 - 4) < 0.02 })
    scroll.swipeLeft()
    scroll.swipeUp()
    XCTAssertEqual(image.label, "Chat image 3 of 3")
    XCTAssertTrue(image.frame.intersects(scroll.frame), "Native pan must retain image bounds")
    capture("bounded-pan-at-four-times")
    scroll.pinch(withScale: 0.1, velocity: -2)
    XCTAssertTrue(waitForZoom { abs($0 - 1) < 0.02 })
    image.doubleTap()
    XCTAssertTrue(waitForZoom { abs($0 - 2) < 0.05 })
    image.doubleTap()
    XCTAssertTrue(waitForZoom { abs($0 - 1) < 0.02 })
    let close = app.buttons["image-viewer-close"]
    XCTAssertTrue(close.isHittable)
    XCTAssertGreaterThanOrEqual(close.frame.width, 44)
    XCTAssertGreaterThanOrEqual(close.frame.height, 44)
    image.tap()
    XCTAssertTrue(image.waitForNonExistence(timeout: 5), "Single tap keeps the established close behavior")
  }
}
