/**
 * Stub Expo Router screen for the `pentacle://harness?...` deep-link path.
 *
 * The launch URL is parsed in `app/_layout.tsx` BEFORE this route mounts,
 * which populates `harnessRuntime` state. By the time this screen renders,
 * arming is complete; we redirect to the normal entry point so the device
 * lands on the same screen it would have without a harness URL.
 *
 * The route file exists primarily so the deep-link does not navigate to
 * `+not-found`. It carries no UI.
 *
 * Spec: public_behavior_contract
 */
import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { View } from 'react-native';

export default function HarnessRoute() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/' as any);
  }, [router]);
  return <View />;
}

