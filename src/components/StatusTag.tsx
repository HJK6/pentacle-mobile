import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { Colors, Fonts, STATUS, Tokens, type WorkStatus } from '@/constants/Colors';
import { Spinner } from './ArcaneAtoms';
import SendingIndicator from './SendingIndicator';

type Props = {
  status: WorkStatus | string;
  color?: string;
  elapsedSeconds?: number | null;
  sendingDelayMs?: number;
  label?: string;
  onVisibleStatusCommit?: (status: 'sending' | 'working') => void;
};

// Memoized: one per all-chats row; for idle rows its inputs are stable, so it
// skips re-render when a row's preview text updates (working/sending rows still
// re-render on their ticking elapsedSeconds/status). Cuts per-row burst commit
// cost (spec tap_shell_layout_regression_build_1155 slice 2b).
function StatusTag({ status, elapsedSeconds, sendingDelayMs = 0, label, onVisibleStatusCommit }: Props) {
  const normalizedStatus = String(status).toLowerCase();
  const unresponsive = normalizedStatus === 'unresponsive';
  const working = normalizedStatus === 'working';
  const sending = normalizedStatus === 'sending';
  const [showSending, setShowSending] = React.useState(() => sending && sendingDelayMs <= 0);
  const displayStatus = unresponsive ? 'unresponsive' : working ? 'working' : sending ? 'sending' : 'idle';
  const accent = unresponsive ? Colors.error : working || sending ? STATUS.working : STATUS.idle;
  const elapsed = working && elapsedSeconds !== null && elapsedSeconds !== undefined
    ? formatElapsedSeconds(elapsedSeconds)
    : null;

  React.useEffect(() => {
    if (!sending) {
      setShowSending(false);
      return;
    }
    if (sendingDelayMs <= 0) {
      setShowSending(true);
      return;
    }
    setShowSending(false);
    const timer = setTimeout(() => setShowSending(true), sendingDelayMs);
    return () => clearTimeout(timer);
  }, [sending, sendingDelayMs]);

  const committedVisibleStatus = working ? 'working' : sending && showSending ? 'sending' : null;
  React.useEffect(() => {
    if (committedVisibleStatus) onVisibleStatusCommit?.(committedVisibleStatus);
  }, [committedVisibleStatus, onVisibleStatusCommit]);

  return (
    <View
      accessible
      accessibilityLabel={unresponsive ? (label || 'Unresponsive') : working ? 'Working' : sending ? 'Sending' : 'Idle'}
      accessibilityRole="image"
      style={styles.root}
      testID={`status-tag-${displayStatus}`}
    >
      {unresponsive ? (
        <Text testID="status-tag-label" style={[styles.label, { color: accent }]}>{label || 'Unresponsive'}</Text>
      ) : working ? (
        <Spinner size={13} color={accent} strokeWidth={2} />
      ) : sending && showSending ? (
        <SendingIndicator color={accent} />
      ) : (
        <Svg width={12} height={12} viewBox="0 0 12 12">
          <Circle cx="6" cy="6" r="5" fill="none" stroke={accent} strokeWidth={1.6} opacity={1} />
        </Svg>
      )}
      {elapsed ? (
        <Text testID="status-tag-elapsed" style={[styles.timer, { color: accent }]}>
          {elapsed}
        </Text>
      ) : null}
    </View>
  );
}

export default React.memo(StatusTag);

function formatElapsedSeconds(totalSeconds: number) {
  const safeTotal = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeTotal / 60);
  const seconds = safeTotal % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  timer: {
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: Tokens.type.label,
    fontVariant: ['tabular-nums'],
  },
  label: {
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: Tokens.type.label,
  },
});
