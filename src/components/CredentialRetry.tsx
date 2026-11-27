import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';

type Props = { onRetry: () => Promise<void> | void };

// Offered whenever the device credential is missing, so the screen is never a dead end.
export default function CredentialRetry({ onRetry }: Props) {
  const [busy, setBusy] = useState(false);
  const retry = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onRetry();
    } finally {
      setBusy(false);
    }
  }, [busy, onRetry]);
  return (
    <Pressable
      testID="credential-retry"
      accessibilityRole="button"
      accessibilityLabel="Try again"
      onPress={() => { void retry(); }}
      disabled={busy}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      {busy ? <ActivityIndicator color="#7ef0ba" /> : <Text style={styles.label}>Try again</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    marginTop: 16,
    minWidth: 140,
    minHeight: 44,
    paddingHorizontal: 20,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#28463a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.6 },
  label: { color: '#7ef0ba', fontSize: 15, fontWeight: '600' },
});
