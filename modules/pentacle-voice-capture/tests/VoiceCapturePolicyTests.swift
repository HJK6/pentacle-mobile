import Foundation
import XCTest
@testable import VoiceCapturePolicy

final class VoiceCapturePolicyTests: XCTestCase {
  struct Contract: Decodable {
    let contract: String
    let revision: Int
    let maxCapturedMs: Double
    let vectors: [Vector]
  }
  struct Vector: Decodable { let name: String; let steps: [Step] }
  struct Step: Decodable { let event: VoiceCapturePolicy.Event; let expect: Expected }
  struct Expected: Decodable {
    let state: VoiceCapturePolicy.State
    let reason: String?
    let pauseEpoch: Int
    let capturedMs: Double
    let actions: [VoiceCapturePolicy.Action]
    let error: String?
  }
  func vectors() throws -> Contract {
    let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    return try JSONDecoder().decode(Contract.self, from: Data(contentsOf: package.appendingPathComponent("contract/capture-contract-v1.json")))
  }
  func testSharedContractVectors() throws {
    let contract = try vectors()
    XCTAssertEqual(contract.contract, "pentacle-voice-capture")
    XCTAssertEqual(contract.revision, 1)
    XCTAssertEqual(contract.maxCapturedMs, VoiceCapturePolicy.maximumCapturedMs)
    XCTAssertGreaterThanOrEqual(contract.vectors.count, 30)
    for vector in contract.vectors {
      var policy = VoiceCapturePolicy()
      var request: (kind: String, admission: Int, epoch: Int)?
      var prepares: [String: Int] = [:]
      for (index, step) in vector.steps.enumerated() {
        let context = "\(vector.name), step \(index): \(step.event.type)"
        let previousState = policy.state
        let previousEpoch = policy.pauseEpoch
        let result = policy.handle(step.event)
        XCTAssertEqual(policy.state, step.expect.state, context)
        XCTAssertEqual(policy.reason, step.expect.reason, context)
        XCTAssertEqual(policy.pauseEpoch, step.expect.pauseEpoch, context)
        XCTAssertEqual(policy.capturedMs, step.expect.capturedMs, accuracy: 0.000001, context)
        XCTAssertEqual(result.actions, step.expect.actions, context)
        XCTAssertEqual(result.error, step.expect.error, context)
        XCTAssertGreaterThanOrEqual(policy.capturedMs, 0, context)
        XCTAssertLessThanOrEqual(policy.capturedMs, 300_000, context)
        if result.actions.contains(.activateSession), result.error == nil {
          XCTAssertTrue(step.event.type == "start" || step.event.type == "resume", context)
          request = (step.event.type, try XCTUnwrap(step.event.admission), step.event.pauseEpoch ?? 0)
        }
        if result.actions.contains(.prepare) {
          let id = try XCTUnwrap(step.event.recordingId)
          prepares[id, default: 0] += 1
          XCTAssertEqual(prepares[id], 1, "One prepare per capture identity: \(context)")
        }
        if result.actions.contains(.record) {
          let admitted = try XCTUnwrap(request, context)
          XCTAssertEqual(step.event.type, admitted.kind == "start" ? "startReady" : "resumeReady", context)
          XCTAssertEqual(admitted.admission, policy.admissionGeneration, context)
          XCTAssertTrue(policy.foreground && policy.protectedData && policy.sessionActive, context)
          XCTAssertEqual(result.error, nil, context)
          if admitted.kind == "resume" {
            XCTAssertEqual(previousState, .paused, context)
            XCTAssertEqual(admitted.epoch, previousEpoch, context)
            XCTAssertFalse(result.actions.contains(.prepare), context)
          }
          request = nil
        }
      }
    }
  }
  func testRecordCannotAppearWithoutExplicitPendingCommand() {
    for type in ["startReady", "resumeReady", "interruptionEnded", "becameActive", "foreground", "unlock", "routeChanged", "tick", "capReached"] {
      var policy = VoiceCapturePolicy()
      var input = VoiceCapturePolicy.Event(type, nowMs: 999_999)
      input.sessionActive = true; input.foreground = true; input.protectedData = true
      XCTAssertFalse(policy.handle(input).actions.contains(.record), type)
    }
  }
  func testObserverGenerationIsNotAdvancedTwice() {
    var policy = VoiceCapturePolicy()
    var background = VoiceCapturePolicy.Event("background")
    background.admissionGeneration = 7
    _ = policy.handle(background)
    XCTAssertEqual(policy.admissionGeneration, 7)
    var start = VoiceCapturePolicy.Event("start", recordingId: "capture-b", admission: 7)
    start.foreground = true; start.protectedData = true
    XCTAssertNil(policy.handle(start).error)
  }
  func testNonFiniteOrRegressingClockCannotAddCapturedTime() {
    var policy = VoiceCapturePolicy()
    _ = policy.handle(.init("start", recordingId: "capture-a", admission: 0))
    var ready = VoiceCapturePolicy.Event("startReady"); ready.sessionActive = true
    _ = policy.handle(ready)
    _ = policy.handle(.init("tick", nowMs: 10))
    _ = policy.handle(.init("tick", nowMs: .infinity))
    _ = policy.handle(.init("tick", nowMs: 5))
    XCTAssertEqual(policy.capturedMs, 10)
    _ = policy.handle(.init("tick", nowMs: 15))
    XCTAssertEqual(policy.capturedMs, 15)
  }
  func testSuppliedGenerationNeverGoesBackwards() {
    var policy = VoiceCapturePolicy()
    for type in ["revoke", "interruptionBegan", "resignActive", "background", "lock", "mediaReset"] {
      var current = VoiceCapturePolicy.Event("environment"); current.admissionGeneration = 10
      _ = policy.handle(current)
      var stale = VoiceCapturePolicy.Event(type); stale.admissionGeneration = 3
      _ = policy.handle(stale)
      XCTAssertEqual(policy.admissionGeneration, 10, type)
    }
  }
  func testFinalFileEvidenceCanInvalidateTentativeCap() {
    for (captured, padding, reason) in [(299_999.0, 100.0, "recorder_reset"),
                                      (300_000.0625, 100.0, "capture_limit_exceeded"),
                                      (300_000.0, 250.0625, "encoder_padding_exceeded")] {
      var policy = VoiceCapturePolicy()
      _ = policy.handle(.init("start", recordingId: "capture-a", admission: 0))
      var ready = VoiceCapturePolicy.Event("startReady"); ready.sessionActive = true
      _ = policy.handle(ready)
      _ = policy.handle(.init("tick", nowMs: 300_000))
      var finalized = VoiceCapturePolicy.Event("finished", nowMs: 900_000)
      finalized.success = true; finalized.capturedMs = captured; finalized.paddingMs = padding
      let result = policy.handle(finalized)
      XCTAssertEqual(policy.state, .interrupted)
      XCTAssertEqual(policy.reason, reason)
      XCTAssertEqual(result.actions, [.releaseSession])
    }
  }
  func testNonFiniteFinalEvidenceCannotCertifyCap() {
    for value in [Double.nan, Double.infinity, -Double.infinity] {
      var policy = VoiceCapturePolicy()
      _ = policy.handle(.init("start", recordingId: "capture-a", admission: 0))
      var ready = VoiceCapturePolicy.Event("startReady"); ready.sessionActive = true
      _ = policy.handle(ready)
      var finalized = VoiceCapturePolicy.Event("finished", nowMs: 900_000)
      finalized.success = true; finalized.capturedMs = value; finalized.paddingMs = 100
      _ = policy.handle(finalized)
      XCTAssertEqual(policy.state, .interrupted)
      XCTAssertEqual(policy.capturedMs, 0)
    }
  }

}
