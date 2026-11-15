import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import Svg, { Path } from 'react-native-svg';
import { Fonts, Tokens } from '@/constants/Colors';
import SendingIndicator from './SendingIndicator';

// One send-status grammar for text and voice messages (operator option B, 2026-11-15):
// Sending, or "!" Failed sending with a borderless retry symbol and a borderless X.
const NON_SELECTABLE = { selectable: false } as const;

export function SendingRow({ testID, label = 'Sending' }: { testID: string; label?: 'Sending' | 'Uploading' }) {
  return (
    <View style={styles.row} testID={testID}>
      <SendingIndicator />
      <Text {...NON_SELECTABLE} style={styles.sending}>{label}</Text>
    </View>
  );
}

export function SendFailedRow({
  testID,
  retryTestID,
  discardTestID,
  onRetry,
  onDiscard,
  retryDisabled = false,
  accent = Tokens.palette.green,
}: {
  testID: string;
  retryTestID: string;
  discardTestID: string;
  onRetry?: () => void;
  onDiscard?: () => void;
  retryDisabled?: boolean;
  accent?: string;
}) {
  return (
    <View style={styles.row} testID={testID}>
      <FontAwesome name="exclamation-circle" size={10} color={Tokens.palette.amber} />
      <Text {...NON_SELECTABLE} style={styles.failed}>Failed sending</Text>
      {onRetry ? (
        <Pressable
          testID={retryTestID}
          accessibilityRole="button"
          accessibilityLabel="Retry sending"
          accessibilityState={{ disabled: retryDisabled }}
          disabled={retryDisabled}
          hitSlop={10}
          onPress={onRetry}
          style={styles.retry}
        >
          <Svg width={12} height={12} viewBox="0 0 24 24">
            <Path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" fill="none" stroke={accent} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
        </Pressable>
      ) : null}
      {onDiscard ? (
        <Pressable
          testID={discardTestID}
          accessibilityRole="button"
          accessibilityLabel="Cancel and delete"
          hitSlop={10}
          onPress={onDiscard}
          style={styles.discard}
        >
          <Svg width={12} height={12} viewBox="0 0 24 24">
            <Path d="M6 6l12 12M18 6L6 18" fill="none" stroke={Tokens.palette.muted} strokeWidth={2.4} strokeLinecap="round" />
          </Svg>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3, paddingHorizontal: 2 },
  sending: { color: Tokens.palette.muted, fontSize: 10, lineHeight: 14, fontFamily: Fonts.jetBrainsMono.regular },
  failed: { color: Tokens.palette.amber, fontSize: 10, lineHeight: 14, fontFamily: Fonts.jetBrainsMono.regular },
  retry: { width: 14, height: 14, marginLeft: 6, alignItems: 'center', justifyContent: 'center' },
  discard: { width: 14, height: 14, marginLeft: 10, alignItems: 'center', justifyContent: 'center' },
});
