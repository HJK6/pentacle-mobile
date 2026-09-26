import ExpoModulesCore
import LocalAuthentication
import Security

public class PentacleConsentModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PentacleConsent")
    AsyncFunction("createKey") { () throws -> [String: String] in
      let context = try self.faceIDContext()
      var error: Unmanaged<CFError>?
      guard let access = SecAccessControlCreateWithFlags(nil, ConsentKeyPolicy.accessibility,
                                                        ConsentKeyPolicy.flags, &error) else {
        throw self.failure("key_creation_failed")
      }
      let tag = "pentacle-consent-" + UUID().uuidString
      let attributes: [String: Any] = [
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits as String: 256,
        kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
        kSecPrivateKeyAttrs as String: [
          kSecAttrIsPermanent as String: true,
          kSecAttrApplicationTag as String: Data(tag.utf8),
          kSecAttrAccessControl as String: access,
          kSecUseAuthenticationContext as String: context
        ]
      ]
      guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error),
            let publicKey = SecKeyCopyPublicKey(key),
            let raw = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
        throw self.failure("key_creation_failed")
      }
      // RFC 5480 SubjectPublicKeyInfo: id-ecPublicKey + prime256v1 + uncompressed point.
      let prefix: [UInt8] = [0x30,0x59,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,
                            0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x03,0x42,0x00]
      guard raw.count == 65 else { throw self.failure("key_creation_failed") }
      return ["keyTag": tag, "spki": (Data(prefix) + raw).base64EncodedString()]
    }
    AsyncFunction("signConsent") { (tag: String, bytesBase64: String) throws -> String in
      guard tag.hasPrefix("pentacle-consent-"), let bytes = Data(base64Encoded: bytesBase64) else {
        throw self.failure("invalid_input")
      }
      let context = try self.faceIDContext()
      context.localizedReason = "Approve this Pentacle action"
      var result: CFTypeRef?
      let status = SecItemCopyMatching([
        kSecClass: kSecClassKey, kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrApplicationTag: Data(tag.utf8), kSecReturnRef: true,
        kSecUseAuthenticationContext: context
      ] as CFDictionary, &result)
      if status == errSecUserCanceled { throw self.failure("cancelled") }
      guard status == errSecSuccess, let result else { throw self.failure("key_invalidated") }
      let key = result as! SecKey
      var error: Unmanaged<CFError>?
      guard let signature = SecKeyCreateSignature(key, ConsentKeyPolicy.algorithm, bytes as CFData, &error) else {
        if let error = error?.takeRetainedValue(), CFErrorGetCode(error) == Int(errSecUserCanceled) {
          throw self.failure("cancelled")
        }
        throw self.failure("signing_failed")
      }
      return (signature as Data).base64EncodedString()
    }
  }

  private func faceIDContext() throws -> LAContext {
    let context = LAContext()
    context.localizedFallbackTitle = ""
    context.touchIDAuthenticationAllowableReuseDuration = 0
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
      if error?.code == LAError.biometryLockout.rawValue { throw failure("biometry_lockout") }
      throw failure("biometry_unavailable")
    }
    guard context.biometryType == .faceID else { throw failure("face_id_required") }
    return context
  }

  private func failure(_ code: String) -> NSError {
    NSError(domain: "PentacleConsent", code: 1, userInfo: [NSLocalizedDescriptionKey: code])
  }
}
