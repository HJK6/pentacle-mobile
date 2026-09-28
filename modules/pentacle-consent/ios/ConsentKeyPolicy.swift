import Security

public enum ConsentKeyPolicy {
  public static let flags: SecAccessControlCreateFlags = [.privateKeyUsage, .biometryCurrentSet]
  public static let accessibility = kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly
  public static let algorithm = SecKeyAlgorithm.ecdsaSignatureMessageX962SHA256
}
