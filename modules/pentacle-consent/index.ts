import { requireOptionalNativeModule } from 'expo-modules-core';

export type ConsentSigner = {
  createKey(): Promise<{ keyTag: string; spki: string }>;
  signConsent(keyTag: string, challengeBytesBase64: string): Promise<string>;
};

export function nativeConsentSigner(): ConsentSigner {
  const module = requireOptionalNativeModule<ConsentSigner>('PentacleConsent');
  if (!module) throw new Error('Face ID approvals require the signed iPhone app.');
  return module;
}
