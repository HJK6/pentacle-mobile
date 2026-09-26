import Security
import XCTest
@testable import ConsentPolicy

final class ConsentKeyPolicyTests: XCTestCase {
  func testPolicyRequiresCurrentBiometryAndPrivateKeyUse() {
    XCTAssertEqual(ConsentKeyPolicy.flags, [.biometryCurrentSet, .privateKeyUsage])
    XCTAssertFalse(ConsentKeyPolicy.flags.contains(.userPresence))
    XCTAssertFalse(ConsentKeyPolicy.flags.contains(.devicePasscode))
    XCTAssertFalse(ConsentKeyPolicy.flags.contains(.biometryAny))
  }
  func testDeviceOnlyAccessibilityAndECDSAAlgorithm() {
    XCTAssertEqual(ConsentKeyPolicy.accessibility as String, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly as String)
    XCTAssertEqual(ConsentKeyPolicy.algorithm, .ecdsaSignatureMessageX962SHA256)
  }
}
