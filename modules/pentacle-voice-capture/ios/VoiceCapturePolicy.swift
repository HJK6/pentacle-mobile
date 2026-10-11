// Intentionally no imports: the reducer uses only the Swift standard library.
// Every event is executed serially. nowMs is an injected clock; only recording
// intervals accrue time. The executor supplies the recorder's captured-audio clock.
public struct VoiceCapturePolicy {
  public static let maximumCapturedMs = 300_000.0
  /// Finalized AAC holds whole packets, so a capped file can end short of the limit. It is
  /// certified within the same 250 ms ceiling that bounds encoder padding.
  public static let capCertificationToleranceMs = 250.0

  public enum State: String, Codable { case idle, starting, recording, paused, stopped, discarded, interrupted, capped }
  public enum Action: String, Codable { case prepare, activateSession, record, pause, stop, releaseSession }

  public struct Event: Codable {
    public var type: String
    public var nowMs: Double
    public var recordingId: String?
    public var admission: Int?
    public var pauseEpoch: Int?
    public var foreground: Bool?
    public var protectedData: Bool?
    public var sessionActive: Bool?
    public var admissionGeneration: Int?
    public var shouldResume: Bool?
    public var capturedMs: Double?
    public var paddingMs: Double?
    public var success: Bool?
    public init(_ type: String, nowMs: Double = 0, recordingId: String? = nil,
                admission: Int? = nil, pauseEpoch: Int? = nil) {
      self.type = type; self.nowMs = nowMs; self.recordingId = recordingId
      self.admission = admission; self.pauseEpoch = pauseEpoch
    }
  }

  public struct Result {
    public var actions: [Action]
    public var error: String?
    public init(_ actions: [Action] = [], error: String? = nil) { self.actions = actions; self.error = error }
  }

  private struct Pending {
    let kind: String
    let recordingId: String
    let admission: Int
    let pauseEpoch: Int
  }

  public private(set) var state: State = .idle
  public private(set) var reason: String?
  public private(set) var recordingId: String?
  public private(set) var pauseEpoch = 0
  public private(set) var capturedMs = 0.0
  public private(set) var admissionGeneration = 0
  public private(set) var foreground = true
  public private(set) var protectedData = true
  public private(set) var sessionActive = false
  private var lastClockMs: Double?
  private var pending: Pending?

  public init() {}

  private var isLive: Bool { state == .starting || state == .recording || state == .paused }
  private mutating func advanceClock(_ nowMs: Double) -> [Action] {
    guard state == .recording, nowMs.isFinite else { return [] }
    if let last = lastClockMs {
      capturedMs = min(Self.maximumCapturedMs, capturedMs + max(0, nowMs - last))
    }
    lastClockMs = max(lastClockMs ?? nowMs, nowMs)
    if capturedMs >= Self.maximumCapturedMs { return finalizeCap() }
    return []
  }
  private mutating func finalizeCap() -> [Action] {
    capturedMs = Self.maximumCapturedMs; state = .capped; reason = "capped"
    pending = nil; lastClockMs = nil; sessionActive = false
    return [.stop, .releaseSession]
  }
  private mutating func makePaused(_ why: String, forceEpoch: Bool) -> [Action] {
    guard isLive else { return [] }
    if forceEpoch || state != .paused || pending != nil { pauseEpoch += 1 }
    state = .paused; reason = why; pending = nil; lastClockMs = nil; sessionActive = false
    return [.pause, .releaseSession]
  }
  private func refusal(for id: String?, admission: Int?, epoch: Int?, resuming: Bool) -> String? {
    guard id == recordingId else { return "cancelled" }
    if state == .interrupted { return "recorder_reset" }
    if state == .capped || capturedMs >= Self.maximumCapturedMs { return "capped" }
    if let admission, admission != admissionGeneration { return "cancelled" }
    if resuming {
      if state != .paused { return "not_paused" }
      if epoch != pauseEpoch { return "stale_epoch" }
    }
    if !foreground { return "not_foreground" }
    if !protectedData { return "locked" }
    return nil
  }

  public mutating func handle(_ event: Event) -> Result {
    let elapsedActions = (event.type == "settleCaptured" || event.type == "finished") ? [] : advanceClock(event.nowMs)
    if let value = event.foreground { foreground = value }
    if let value = event.protectedData { protectedData = value }
    if let value = event.sessionActive { sessionActive = value }
    if let generation = event.admissionGeneration { admissionGeneration = max(admissionGeneration, generation) }
    var result = Result(elapsedActions)
    // A time observation may cap before the requested transition is considered.
    func finished(_ actions: [Action] = [], _ error: String? = nil) -> Result {
      Result(result.actions + actions, error: error)
    }

    switch event.type {
    case "revoke":
      if event.admissionGeneration == nil { admissionGeneration += 1 }
    case "start":
      guard let id = event.recordingId, !id.isEmpty, let admission = event.admission,
            admission == admissionGeneration else { return finished([], "cancelled") }
      guard !isLive else { return finished([], "not_paused") }
      guard id != recordingId else { return finished([], "cancelled") }
      recordingId = id; capturedMs = 0; pauseEpoch = 0; state = .starting; reason = nil; lastClockMs = nil
      if let error = refusal(for: id, admission: admission, epoch: nil, resuming: false) {
        return finished(makePaused(error, forceEpoch: false), error)
      }
      pending = Pending(kind: "start", recordingId: id, admission: admission, pauseEpoch: 0)
      return finished([.prepare, .activateSession])
    case "resume":
      guard let admission = event.admission else { return finished([], "cancelled") }
      if let error = refusal(for: event.recordingId, admission: admission, epoch: event.pauseEpoch, resuming: true) {
        return finished([], error)
      }
      guard pending == nil, let id = recordingId else { return finished([], "cancelled") }
      pending = Pending(kind: "resume", recordingId: id, admission: admission, pauseEpoch: pauseEpoch)
      return finished([.activateSession])
    case "startReady", "resumeReady":
      let resuming = event.type == "resumeReady"
      guard let request = pending, request.kind == (resuming ? "resume" : "start"),
            request.recordingId == recordingId,
            event.recordingId == nil || event.recordingId == recordingId else {
        return finished([], state == .interrupted ? "recorder_reset" : state == .capped ? "capped" : "cancelled")
      }
      let error = refusal(for: request.recordingId, admission: request.admission, epoch: request.pauseEpoch, resuming: resuming)
        ?? (sessionActive ? nil : "session_failed")
      if let error { return finished(makePaused(error, forceEpoch: false), error) }
      guard resuming || state == .starting else { return finished([], "cancelled") }
      state = .recording; reason = nil; pending = nil; lastClockMs = event.nowMs
      return finished([.record])
    case "pause":
      if event.recordingId != nil && event.recordingId != recordingId { return finished([], "cancelled") }
      return finished(makePaused("user", forceEpoch: false))
    case "interruptionBegan", "resignActive", "background", "lock":
      if event.admissionGeneration == nil { admissionGeneration += 1 }
      if event.type == "resignActive" || event.type == "background" { foreground = false }
      if event.type == "lock" { protectedData = false }
      let why = event.type == "interruptionBegan" ? "interruption" : event.type == "lock" ? "locked" : event.type == "resignActive" ? "inactive" : "background"
      return finished(makePaused(why, forceEpoch: true))
    case "foreground":
      // willEnterForeground is not yet active and does not authorize capture.
      break
    case "becameActive": foreground = true
    case "unlock": protectedData = true
    case "interruptionEnded", "routeChanged": break // Never schedule record or activation.
    case "mediaReset":
      if event.admissionGeneration == nil { admissionGeneration += 1 }
      if isLive {
        state = .interrupted; reason = "recorder_reset"; pending = nil; lastClockMs = nil
        pauseEpoch += 1; sessionActive = false
        return finished([.stop, .releaseSession])
      }
    case "activationAborted":
      // Activation may return after a reentrant observer already paused/reset us.
      // Release the configuration again, without reviving or replacing that state.
      sessionActive = false
      return finished([.pause, .releaseSession])
    case "sessionFailed", "recordFailed":
      let error = event.type == "sessionFailed" ? "session_failed" : "resume_failed"
      return finished(makePaused(error, forceEpoch: false), error)
    case "stop":
      if event.recordingId != nil && event.recordingId != recordingId { return finished([], "cancelled") }
      if isLive {
        state = .stopped; reason = nil; pending = nil; lastClockMs = nil; sessionActive = false
        return finished([.stop, .releaseSession])
      }
      if state == .stopped || state == .capped || state == .interrupted { return finished([.releaseSession]) }
    case "discard":
      if event.recordingId != nil && event.recordingId != recordingId { return finished([], "cancelled") }
      if state != .discarded && state != .idle {
        state = .discarded; reason = nil; pending = nil; lastClockMs = nil; sessionActive = false
        return finished([.stop, .releaseSession])
      }
      if state == .discarded { return finished([.releaseSession]) }
    case "settleCaptured":
      if let captured = event.capturedMs, captured.isFinite, captured >= 0 {
        capturedMs = min(Self.maximumCapturedMs, max(capturedMs, captured))
        // A tick-driven cap stops after the clock crossed the limit; the finalized file, not this
        // approximate recorder clock, then certifies the cap or reports the overrun.
        if captured > Self.maximumCapturedMs && state != .discarded && state != .capped {
          if state == .interrupted && reason == "capture_limit_exceeded" { return finished() }
          state = .interrupted; reason = "capture_limit_exceeded"; pending = nil; lastClockMs = nil
          pauseEpoch += 1; sessionActive = false
          return finished([.stop, .releaseSession])
        }
        if capturedMs >= Self.maximumCapturedMs && isLive { return finished(finalizeCap()) }
      }
    case "finished":
      guard state == .recording || state == .capped else { return finished() }
      let alreadyStopped = state == .capped
      // Delivery time is irrelevant. Only finalized valid frames, excluding AAC
      // priming/remainder, can certify a cap. Never clamp an overrun into success.
      if let captured = event.capturedMs, captured.isFinite, captured >= 0 {
        capturedMs = min(Self.maximumCapturedMs, max(capturedMs, captured))
        if event.success == true, captured >= Self.maximumCapturedMs - Self.capCertificationToleranceMs,
           captured <= Self.maximumCapturedMs,
           let padding = event.paddingMs, padding.isFinite, padding >= 0, padding <= 250 {
          return alreadyStopped ? finished() : finished(finalizeCap())
        }
      }
      state = .interrupted
      reason = (event.capturedMs ?? 0) > Self.maximumCapturedMs ? "capture_limit_exceeded"
        : (event.paddingMs ?? 0) > 250 ? "encoder_padding_exceeded" : "recorder_reset"
      pending = nil; lastClockMs = nil; pauseEpoch += 1; sessionActive = false
      return finished(alreadyStopped ? [.releaseSession] : [.stop, .releaseSession])
    case "tick", "environment": break
    default: result.error = "cancelled"
    }
    return result
  }
}
