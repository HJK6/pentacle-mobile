// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "ConsentPolicy", platforms: [.macOS(.v13), .iOS(.v15)], targets: [
  .target(name: "ConsentPolicy", path: "ios", exclude: ["PentacleConsentModule.swift", "PentacleConsent.podspec"], sources: ["ConsentKeyPolicy.swift"]),
  .testTarget(name: "ConsentPolicyTests", dependencies: ["ConsentPolicy"], path: "tests")
])
