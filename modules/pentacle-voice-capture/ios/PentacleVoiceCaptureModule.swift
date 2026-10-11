import AVFoundation
import AudioToolbox
import ExpoModulesCore
import Foundation
import UIKit

// This lock never protects session activation, snapshot reads, or queued work.
// Revocation therefore linearizes on the calling JS/observer thread. It spans
// the final admission check AND record call, with same-thread observer reentry.
private final class CaptureAdmissions {
  private let lock = NSRecursiveLock()
  private var generation = 0
  func read() -> Int { lock.lock(); defer { lock.unlock() }; return generation }
  @discardableResult func revoke() -> Int {
    lock.lock(); defer { lock.unlock() }; generation += 1; return generation
  }
  func atRecordPoint<T>(_ body: (Int) -> T) -> T {
    lock.lock(); defer { lock.unlock() }; return body(generation)
  }
}

private final class VoiceCaptureExecutor: NSObject, AVAudioRecorderDelegate {
  private var policy = VoiceCapturePolicy()
  private let admissions = CaptureAdmissions()
  private let snapshotLock = NSLock()
  private var snapshot: [String: Any] = [
    "state": "idle", "reason": NSNull(), "pauseEpoch": 0, "capturedMs": 0,
    "metering": NSNull(), "uri": NSNull(), "recordingId": NSNull()
  ]
  private var recorder: AVAudioRecorder?
  private var uri: URL?
  private var observers: [NSObjectProtocol] = []
  private var timer: DispatchSourceTimer?
  private var activeSession = false
  private var lastAudioClockMs = 0.0
  private var installed = false

  func getAdmission(_ id: String) -> Int { admissions.read() }
  func revokeAdmissions(_ id: String) { admissions.revoke() }
  // Must not synchronously enter the executor: poll happens before some JS fences.
  func getStatus() -> [String: Any] {
    snapshotLock.lock(); defer { snapshotLock.unlock() }; return snapshot
  }
  private func onMainSync(_ body: () -> Void) {
    if Thread.isMainThread { body() } else { DispatchQueue.main.sync(execute: body) }
  }
  private func audioClock() -> Double {
    if let recorder {
      let observed = recorder.currentTime * 1000
      if observed.isFinite { lastAudioClockMs = max(lastAudioClockMs, observed) }
    }
    return lastAudioClockMs
  }
  private func publish() {
    var level: Any = NSNull()
    if policy.state == .recording, let recorder {
      recorder.updateMeters()
      let db = Double(recorder.averagePower(forChannel: 0))
      if db.isFinite { level = db }
    }
    let value: [String: Any] = [
      "state": policy.state.rawValue, "reason": policy.reason.map { $0 as Any } ?? NSNull(),
      "pauseEpoch": policy.pauseEpoch, "capturedMs": min(300_000, max(0, policy.capturedMs)),
      "metering": level, "uri": uri.map { $0.absoluteString as Any } ?? NSNull(),
      "recordingId": policy.recordingId.map { $0 as Any } ?? NSNull()
    ]
    snapshotLock.lock(); snapshot = value; snapshotLock.unlock()
    updateTimer()
  }
  private func event(_ name: String, id: String? = nil, admission: Int? = nil, epoch: Int? = nil) -> VoiceCapturePolicy.Event {
    VoiceCapturePolicy.Event(name, nowMs: audioClock(), recordingId: id, admission: admission, pauseEpoch: epoch)
  }
  private func environment(_ event: inout VoiceCapturePolicy.Event, generation: Int) {
    event.foreground = UIApplication.shared.applicationState == .active
    event.protectedData = UIApplication.shared.isProtectedDataAvailable
    event.sessionActive = activeSession
    event.admissionGeneration = generation
  }

  func install() {
    dispatchPrecondition(condition: .onQueue(.main))
    guard !installed else { return }; installed = true
    let center = NotificationCenter.default
    func observe(_ name: Notification.Name, _ type: String, revokes: Bool) {
      observers.append(center.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
        self?.observed(type, revokes: revokes)
      })
    }
    observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] note in
      guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
      // shouldResume is deliberately ignored, including a begin/end within one poll.
      self?.observed(type == .began ? "interruptionBegan" : "interruptionEnded", revokes: type == .began)
    })
    observe(UIApplication.willResignActiveNotification, "resignActive", revokes: true)
    observe(UIApplication.didEnterBackgroundNotification, "background", revokes: true)
    // Scene-based apps have distinct lifecycle notifications; do not rely on a
    // scene delegate forwarding methods to also post UIApplication notifications.
    observe(UIScene.willDeactivateNotification, "resignActive", revokes: true)
    observe(UIScene.didEnterBackgroundNotification, "background", revokes: true)
    observe(UIApplication.protectedDataWillBecomeUnavailableNotification, "lock", revokes: true)
    observe(UIApplication.didBecomeActiveNotification, "becameActive", revokes: false)
    observe(UIApplication.willEnterForegroundNotification, "foreground", revokes: false)
    observe(UIScene.didActivateNotification, "becameActive", revokes: false)
    observe(UIScene.willEnterForegroundNotification, "foreground", revokes: false)
    observe(UIApplication.protectedDataDidBecomeAvailableNotification, "unlock", revokes: false)
    observe(AVAudioSession.routeChangeNotification, "routeChanged", revokes: false)
    observe(AVAudioSession.mediaServicesWereResetNotification, "mediaReset", revokes: true)
    publish()
  }

  private func updateTimer() {
    if policy.state != .recording { timer?.cancel(); timer = nil; return }
    guard timer == nil else { return }
    let source = DispatchSource.makeTimerSource(queue: .main)
    source.schedule(deadline: .now(), repeating: .milliseconds(20), leeway: .milliseconds(2))
    source.setEventHandler { [weak self] in
      guard let self, self.policy.state == .recording else { return }
      _ = self.apply(self.event("tick")); self.publish()
    }
    timer = source; source.resume()
  }

  private func settlePausedClock() {
    recorder?.pause()
    var settled = event("settleCaptured")
    settled.capturedMs = audioClock()
    let result = policy.handle(settled)
    _ = execute(result.actions)
  }

  private func finalizedFrames() -> (capturedMs: Double, paddingMs: Double)? {
    guard let uri else { return nil }
    var file: AudioFileID?
    guard AudioFileOpenURL(uri as CFURL, .readPermission, 0, &file) == noErr,
          let file else { return nil }
    defer { AudioFileClose(file) }
    var format = AudioStreamBasicDescription()
    var formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    guard AudioFileGetProperty(file, kAudioFilePropertyDataFormat, &formatSize, &format) == noErr,
          formatSize == UInt32(MemoryLayout<AudioStreamBasicDescription>.size),
          format.mSampleRate == 16_000, format.mChannelsPerFrame == 1,
          format.mFormatID == kAudioFormatMPEG4AAC, format.mFramesPerPacket > 0 else { return nil }
    var table = AudioFilePacketTableInfo()
    var tableSize = UInt32(MemoryLayout<AudioFilePacketTableInfo>.size)
    guard AudioFileGetProperty(file, kAudioFilePropertyPacketTableInfo, &tableSize, &table) == noErr,
          tableSize == UInt32(MemoryLayout<AudioFilePacketTableInfo>.size),
          table.mNumberValidFrames >= 0, table.mPrimingFrames >= 0, table.mRemainderFrames >= 0 else { return nil }
    var packets: UInt64 = 0
    var packetsSize = UInt32(MemoryLayout<UInt64>.size)
    guard AudioFileGetProperty(file, kAudioFilePropertyAudioDataPacketCount, &packetsSize, &packets) == noErr,
          packetsSize == UInt32(MemoryLayout<UInt64>.size),
          packets <= UInt64(Int64.max) / UInt64(format.mFramesPerPacket) else { return nil }
    let totalFrames = Int64(packets) * Int64(format.mFramesPerPacket)
    guard table.mNumberValidFrames <= totalFrames,
          totalFrames - table.mNumberValidFrames == Int64(table.mPrimingFrames) + Int64(table.mRemainderFrames) else { return nil }
    return (Double(table.mNumberValidFrames) * 1000 / format.mSampleRate,
            (Double(table.mPrimingFrames) + Double(table.mRemainderFrames)) * 1000 / format.mSampleRate)
  }

  private func observed(_ type: String, revokes: Bool) {
    let generation = revokes ? admissions.revoke() : admissions.read()
    // Apple delivers interruption notifications on main; UIKit lifecycle is main.
    // No main->executor->main cycle: main IS the sole policy/executor queue.
    let update = { [self] in
      var input = event(type); input.admissionGeneration = generation
      if type == "interruptionBegan" || type == "mediaReset" { activeSession = false }
      _ = apply(input); publish()
    }
    if revokes || Thread.isMainThread { onMainSync(update) }
    else { DispatchQueue.main.async(execute: update) }
  }

  private func releaseSession() -> String? {
    activeSession = false
    var failed = false
    let session = AVAudioSession.sharedInstance()
    do { try session.setActive(false, options: [.notifyOthersOnDeactivation]) } catch { failed = true }
    // A paused recorder must not leave the shared session configured to record.
    do { try session.setCategory(.playback, mode: .default, options: []) } catch { failed = true }
    return failed ? "session_failed" : nil
  }

  private func apply(_ input: VoiceCapturePolicy.Event) -> String? {
    let result = policy.handle(input)
    let executorError = execute(result.actions)
    if let executorError, result.actions.contains(.activateSession) || result.actions.contains(.prepare) || result.actions.contains(.record) {
      let failure = policy.handle(event(executorError == "session_failed" ? "sessionFailed" : "recordFailed"))
      _ = execute(failure.actions)
    }
    publish()
    return result.error ?? executorError
  }
  private func execute(_ actions: [VoiceCapturePolicy.Action]) -> String? {
    var firstError: String?
    for action in actions {
      switch action {
      case .prepare:
        // A failed new allocation must never expose the previous take's recorder/URI.
        recorder = nil; uri = nil; lastAudioClockMs = 0
        // A fresh UUID path is independent of durable take identity and never reused.
        do {
          let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
          let url = directory.appendingPathComponent("pentacle-voice-\(UUID().uuidString).m4a")
          let fresh = try AVAudioRecorder(url: url, settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 32_000,
            AVEncoderAudioQualityKey: AVAudioQuality.max.rawValue
          ])
          fresh.isMeteringEnabled = true; fresh.delegate = self
          recorder = fresh; uri = url; lastAudioClockMs = 0
        } catch { firstError = firstError ?? "session_failed" }
      case .activateSession:
        if firstError != nil { continue }
        do {
          let session = AVAudioSession.sharedInstance()
          try session.setCategory(.record, mode: .default, options: [])
          try session.setActive(true)
          activeSession = true
        } catch { firstError = firstError ?? "session_failed"; activeSession = false }
      case .record:
        // Only start/resume completion calls execute(record), inside atRecordPoint.
        guard let recorder else { firstError = firstError ?? "resume_failed"; continue }
        let remaining = (VoiceCapturePolicy.maximumCapturedMs - policy.capturedMs) / 1000
        guard remaining > 0 else { firstError = firstError ?? "capped"; continue }
        if !recorder.record(forDuration: remaining) || !recorder.isRecording {
          firstError = firstError ?? "resume_failed"
        }
      case .pause:
        settlePausedClock()
      case .stop:
        // Freeze the actual capture boundary before stop resets currentTime to 0.
        settlePausedClock(); recorder?.stop()
        if policy.state == .capped {
          let frames = finalizedFrames()
          var finalized = event("finished")
          finalized.success = true; finalized.capturedMs = frames?.capturedMs; finalized.paddingMs = frames?.paddingMs
          _ = execute(policy.handle(finalized).actions)
        }
      case .releaseSession:
        if let error = releaseSession() { firstError = firstError ?? error }

      }
    }
    return firstError
  }

  func begin(_ kind: String, id: String, admission: Int, epoch: Int?, promise: Promise) {
    install()
    var input = event(kind, id: id, admission: admission, epoch: epoch)
    environment(&input, generation: admissions.read())
    if let error = apply(input) {
      promise.reject(error, error); return
    }
    // Activation can synchronously deliver lifecycle notifications or block while
    // JS revokes. Recheck every condition, then keep this lock THROUGH record().
    let failure: String? = admissions.atRecordPoint { generation in
      var ready = event(kind == "start" ? "startReady" : "resumeReady", id: id)
      environment(&ready, generation: generation)
      if let error = apply(ready) { return error }
      // A synchronous observer inside AVFoundation may have revoked/reentered.
      guard admissions.read() == admission, policy.state == .recording,
            UIApplication.shared.applicationState == .active,
            UIApplication.shared.isProtectedDataAvailable, activeSession else {
        _ = apply(event("pause", id: id)); return "cancelled"
      }
      return nil
    }
    if let failure {
      _ = apply(event("activationAborted"))
      promise.reject(failure, failure)
    } else { promise.resolve(getStatus()) }
  }

  func command(_ kind: String, id: String, promise: Promise) {
    install()
    if let error = apply(event(kind, id: id)) { promise.reject(error, error) }
    else { promise.resolve(kind == "discard" ? nil : getStatus()) }
  }

  func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
    onMainSync {
      guard self.recorder === recorder, policy.state == .recording else { return }
      let generation = admissions.revoke()
      let frames = finalizedFrames()
      var input = event("finished")
      input.admissionGeneration = generation; input.success = flag
      input.capturedMs = frames?.capturedMs; input.paddingMs = frames?.paddingMs
      _ = apply(input)
      publish()
    }
  }
  func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
    onMainSync {
      guard self.recorder === recorder else { return }
      observed("mediaReset", revokes: true)
    }
  }
  func shutdown() {
    admissions.revoke()
    DispatchQueue.main.async {
      _ = self.apply(self.event("stop"))
      self.observers.forEach { NotificationCenter.default.removeObserver($0) }
      self.observers.removeAll(); self.timer?.cancel(); self.timer = nil; self.installed = false
    }
  }
}

public class PentacleVoiceCaptureModule: Module {
  private let capture = VoiceCaptureExecutor()
  public func definition() -> ModuleDefinition {
    Name("PentacleVoiceCapture")
    Function("getCaptureContract") { () -> [String: Any] in
      ["contract": "pentacle-voice-capture", "revision": 1,
       "nativeBuild": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""]
    }
    Function("getStatus") { self.capture.getStatus() }
    Function("getAdmission") { (id: String) in self.capture.getAdmission(id) }
    Function("revokeAdmissions") { (id: String) in self.capture.revokeAdmissions(id) }
    AsyncFunction("getPermission") { () -> [String: Bool] in
      let permission = AVAudioSession.sharedInstance().recordPermission
      return ["granted": permission == .granted, "canAskAgain": permission == .undetermined]
    }.runOnQueue(.main)
    AsyncFunction("requestPermission") { (promise: Promise) in
      AVAudioSession.sharedInstance().requestRecordPermission { granted in
        promise.resolve(["granted": granted, "canAskAgain": false])
      }
    }.runOnQueue(.main)
    AsyncFunction("start") { (id: String, admission: Int, promise: Promise) in
      self.capture.begin("start", id: id, admission: admission, epoch: nil, promise: promise)
    }.runOnQueue(.main)
    AsyncFunction("resume") { (id: String, epoch: Int, admission: Int, promise: Promise) in
      self.capture.begin("resume", id: id, admission: admission, epoch: epoch, promise: promise)
    }.runOnQueue(.main)
    AsyncFunction("pause") { (id: String, promise: Promise) in self.capture.command("pause", id: id, promise: promise) }.runOnQueue(.main)
    AsyncFunction("stop") { (id: String, promise: Promise) in self.capture.command("stop", id: id, promise: promise) }.runOnQueue(.main)
    AsyncFunction("discard") { (id: String, promise: Promise) in self.capture.command("discard", id: id, promise: promise) }.runOnQueue(.main)
    OnDestroy { self.capture.shutdown() }
  }
}
