// swift-tools-version: 5.9
import PackageDescription

let package = Package(name: "VoiceCapturePolicy", platforms: [.macOS(.v13), .iOS(.v15)], targets: [
  .target(name: "VoiceCapturePolicy", path: "ios", exclude: ["PentacleVoiceCaptureModule.swift", "PentacleVoiceCapture.podspec"], sources: ["VoiceCapturePolicy.swift"]),
  .testTarget(name: "VoiceCapturePolicyTests", dependencies: ["VoiceCapturePolicy"], path: "tests")
])
