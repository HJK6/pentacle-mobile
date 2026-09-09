import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Fonts, SEV, Tokens } from '@/constants/Colors';
import SevTag from './SevTag';
import { resolveNotification } from '../services/pentacleStream';
import { logTelemetry, TELEMETRY_EVENTS } from 'pentacle-chat-core';
import type {
  NotificationActionKind,
  NotificationSeverity,
  PentacleNotification,
  PentacleNotificationAction,
} from 'pentacle-chat-core';

type Props = {
  notification: PentacleNotification;
  informational?: boolean;
};

function severityColor(severity: NotificationSeverity): string {
  return SEV[severity] ?? Tokens.palette.green;
}

function formatRelativeTime(iso: string): string {
  const ts = Date.parse(iso || '');
  if (!Number.isFinite(ts)) return '';
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString();
}

// Per-kind default button text when an action carries no explicit `label`.
function defaultLabel(kind: NotificationActionKind, choice?: boolean): string {
  switch (kind) {
    case 'ack':
      return 'Acknowledge';
    case 'yes_no':
      return choice ? 'Yes' : 'No';
    case 'spawn_worker':
      return 'Spawn investigator';
    case 'run_command':
      return 'Run';
    default:
      return 'Resolve';
  }
}

function trimTail(text: unknown): string {
  return typeof text === 'string' ? text.replace(/\s+$/, '') : '';
}

export default function NotificationCard({ notification, informational = false }: Props) {
  // B1: track the EXACT action being submitted (by action_id) rather than a
  // global flag, so a card with multiple buttons only disables/labels the
  // tapped one. A run_command shows "Running…", others show "Working…".
  const [submittingActionId, setSubmittingActionId] = useState<string | null>(null);
  // For a yes_no action both buttons share one action_id; remember which choice
  // was tapped so only that button shows the working label.
  const [submittingChoice, setSubmittingChoice] = useState<boolean | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [freeText, setFreeText] = useState('');
  const clientResolutionError = (notification as PentacleNotification & {
    client_resolution_pending?: boolean;
    client_resolution_error?: string;
  }).client_resolution_error;
  const clientResolutionPending = (notification as PentacleNotification & {
    client_resolution_pending?: boolean;
  }).client_resolution_pending === true;

  const isOpen = notification.state === 'open';
  const freeTextQuestion = String(notification.question?.response_mode || '') === 'free_text' ? notification.question : null;
  // The card is interactive while OPEN and not mid-submit. `running` is a live
  // (broadcast-driven) terminal-progress state: buttons are gone, the inline
  // "Running…" annotation drives the lifecycle until done|failed arrives.
  const accent = severityColor(notification.severity);
  const showSeverity = !(informational && String(notification.severity).toLowerCase() === 'info');

  // Always-on domain telemetry: fire once per (id, state) so a live state
  // transition (open -> running/answered/done/failed/...) re-emits, but a plain
  // re-render does not. Keyed on the id+state pair per spec
  // spec_pentacle_mobile_notifications_l3_coverage.
  useEffect(() => {
    logTelemetry(TELEMETRY_EVENTS.NOTIFICATION_CARD_RENDERED, {
      notification_id: notification.notification_id,
      state: notification.state,
    });
  }, [notification.notification_id, notification.state]);

  // A live broadcast that moves the card off `open` settles any in-flight
  // submit (the optimistic Working…/Running… label hands off to the
  // broadcast-driven lifecycle / terminal annotation). A surfaced
  // client_resolution_error settles it too: a queued offline resolve that later
  // fails (daemon restart / replay-window expiry) resolves handleResolve
  // optimistically, so its catch never fires — without this the button would stay
  // disabled behind an un-actionable error. Re-enabling here makes the card retryable.
  const resolutionError = (notification as { client_resolution_error?: string }).client_resolution_error;
  useEffect(() => {
    if (notification.state !== 'open' || resolutionError) {
      setSubmittingActionId(null);
      setSubmittingChoice(null);
    }
  }, [notification.state, resolutionError]);

  useEffect(() => {
    setFreeText('');
  }, [notification.notification_id]);

  const handleResolve = useCallback(
    async (action: PentacleNotificationAction, choice?: boolean) => {
      if (submittingActionId) return;
      if (freeTextQuestion && !freeText.trim()) {
        setActionError('Enter an answer before submitting.');
        return;
      }
      setSubmittingActionId(action.action_id);
      setSubmittingChoice(typeof choice === 'boolean' ? choice : null);
      setActionError(null);
      try {
        await resolveNotification({
          notification_id: notification.notification_id,
          action_kind: action.kind,
          ...(freeTextQuestion?.question_id ? { question_id: freeTextQuestion.question_id } : {}),
          ...(action.action_id ? { action_id: action.action_id } : {}),
          ...(typeof choice === 'boolean' ? { choice } : {}),
          ...(freeTextQuestion ? { text: freeText } : {}),
        });
      } catch (error) {
        setActionError(error instanceof Error ? error.message : 'Action failed');
        // Re-enable the button so the operator can retry on a transient failure.
        setSubmittingActionId(null);
        setSubmittingChoice(null);
      }
    },
    [freeText, freeTextQuestion, notification.notification_id, submittingActionId],
  );

  // One Pressable per action. Tapping shows immediate Working…/Running… on the
  // tapped button and disables every action until the submit settles (success
  // hands off to the broadcast lifecycle; failure re-enables).
  const renderActionButton = (action: PentacleNotificationAction, index: number) => {
    const busy = submittingActionId !== null;
    const disabled = busy || Boolean(freeTextQuestion && !freeText.trim());
    const isThisSubmitting = submittingActionId === action.action_id;
    const workingLabel = action.kind === 'run_command' ? 'Running…' : 'Working…';

    if (action.kind === 'yes_no') {
      return (
        <React.Fragment key={action.action_id || `yes_no-${index}`}>
          <Pressable
            testID="notification-action-yes"
            disabled={disabled}
            style={({ pressed }) => [styles.button, styles.buttonPrimary, pressed && styles.buttonPressed]}
            onPress={() => handleResolve(action, true)}
          >
            <Text style={[styles.buttonText, styles.buttonTextPrimary]}>
              {isThisSubmitting && submittingChoice === true ? workingLabel : action.label || defaultLabel('yes_no', true)}
            </Text>
          </Pressable>
          {/* A publisher's single `action.label` names the affirmative pole only;
              the "No" pole always uses the default label. */}
          <Pressable
            testID="notification-action-no"
            disabled={disabled}
            style={({ pressed }) => [styles.button, styles.buttonNeutral, pressed && styles.buttonPressed]}
            onPress={() => handleResolve(action, false)}
          >
            <Text style={styles.buttonText}>
              {isThisSubmitting && submittingChoice === false ? workingLabel : defaultLabel('yes_no', false)}
            </Text>
          </Pressable>
        </React.Fragment>
      );
    }

    const primary = action.kind === 'spawn_worker' || action.kind === 'run_command';
    return (
      <Pressable
        key={action.action_id || `${action.kind}-${index}`}
        testID={`notification-action-${action.kind}`}
        disabled={disabled}
        style={({ pressed }) => [
          styles.button,
          primary ? styles.buttonPrimary : styles.buttonNeutral,
          styles.buttonNoWrap,
          pressed && styles.buttonPressed,
        ]}
        onPress={() => handleResolve(action)}
      >
        <Text style={[styles.buttonText, primary && styles.buttonTextPrimary]}>
          {isThisSubmitting ? workingLabel : action.label || defaultLabel(action.kind)}
        </Text>
      </Pressable>
    );
  };

  const renderActionButtons = () => {
    const actions = notification.actions || [];
    if (actions.length === 0) return null;
    return (
      <View style={styles.actions}>
        {actions.map((action, index) => renderActionButton(action, index))}
      </View>
    );
  };

  // In-place decision annotation for terminal/non-open states: the card stays
  // visible (dimmed) and shows the decision/outcome of the resolved action.
  const renderDecision = () => {
    const resolution = notification.resolution;
    const state = notification.state;

    if (state === 'running') {
      return (
        <View testID="notification-decision" style={styles.decision}>
          <Text style={styles.decisionRunning}>Running…</Text>
        </View>
      );
    }

    // `state` is the authoritative terminal signal (the daemon sets
    // acked/answered/spawned/done/failed for the specific action kinds and the
    // generic `resolved`/`expired` otherwise). The resolution.action_kind
    // fallback only fires for a generic terminal state, so it can't shadow an
    // explicit `resolved`/`expired`.
    if (state === 'resolved' || state === 'expired') {
      return (
        <View testID="notification-decision" style={styles.decision}>
          <Text style={styles.decisionText}>{state === 'expired' ? 'Expired' : 'Resolved'}</Text>
        </View>
      );
    }

    const kind = resolution?.action_kind;

    if (state === 'answered' || kind === 'yes_no') {
      const choice = resolution?.choice;
      const answer = typeof choice === 'boolean' ? (choice ? 'Yes' : 'No') : '—';
      return (
        <View testID="notification-decision" style={styles.decision}>
          <Text style={styles.decisionText}>Answered: {answer}</Text>
        </View>
      );
    }

    if (state === 'acked' || kind === 'ack') {
      return (
        <View testID="notification-decision" style={styles.decision}>
          <Text style={styles.decisionText}>Acknowledged</Text>
        </View>
      );
    }

    if (state === 'spawned' || kind === 'spawn_worker') {
      const streamId = resolution?.spawned_stream_id;
      return (
        <View testID="notification-decision" style={styles.decision}>
          <Text style={styles.decisionText}>Spawned{streamId ? ` ${streamId}` : ''}</Text>
        </View>
      );
    }

    if (state === 'done' || state === 'failed' || kind === 'run_command') {
      const result = resolution?.result;
      const exitCode = result?.exit_code;
      const stdout = trimTail(result?.stdout_tail);
      const stderr = trimTail(result?.stderr_tail);
      const ok = state === 'done';
      const timedOut = result?.timed_out === true;
      return (
        <View testID="notification-decision" style={styles.decision}>
          <Text style={[styles.decisionText, ok ? styles.decisionOk : styles.decisionFail]}>
            {ok ? '✓ done' : '✗ failed'}
            {typeof exitCode === 'number' ? ` (exit ${exitCode})` : ''}
            {timedOut ? ' · timed out' : ''}
          </Text>
          {ok && stdout ? (
            <Text testID="notification-decision-stdout" selectable numberOfLines={6} style={styles.decisionMono}>
              {stdout}
            </Text>
          ) : null}
          {!ok && stderr ? (
            <Text testID="notification-decision-stderr" selectable numberOfLines={6} style={styles.decisionMono}>
              {stderr}
            </Text>
          ) : null}
        </View>
      );
    }

    // Any other resolved record without a richer kind-specific annotation.
    if (resolution) {
      return (
        <View testID="notification-decision" style={styles.decision}>
          <Text style={styles.decisionText}>Resolved</Text>
        </View>
      );
    }
    return null;
  };

  return (
    <View style={[styles.card, !isOpen && styles.cardTerminal]} testID="notification-card">
      <View style={[styles.accent, { backgroundColor: accent }]} />
      <View style={[styles.content, { backgroundColor: `${accent}0c` }]}>
        <View style={styles.header}>
          {showSeverity ? <SevTag severity={notification.severity} /> : null}
          <Text style={styles.time} numberOfLines={1}>
            {[notification.producer, formatRelativeTime(notification.created_at)].filter(Boolean).join(' · ')}
          </Text>
        </View>
        <Text style={[styles.title, !isOpen && styles.dimmed]} numberOfLines={2}>
          {notification.title}
        </Text>
        {notification.body ? (
          <Text selectable style={[styles.body, !isOpen && styles.dimmed]}>
            {notification.body}
          </Text>
        ) : null}
        {isOpen && !informational && freeTextQuestion ? (
          <TextInput
            testID="notification-free-text-input"
            value={freeText}
            onChangeText={setFreeText}
            placeholder="Answer"
            placeholderTextColor={Tokens.palette.muted}
            multiline
            style={[styles.freeTextInput, { borderColor: `${accent}66` }]}
          />
        ) : null}
        {clientResolutionPending ? (
          <View testID="notification-resolution-pending" style={styles.decision}>
            <Text style={styles.decisionRunning}>Resolving…</Text>
          </View>
        ) : isOpen && !informational ? renderActionButtons() : !isOpen ? renderDecision() : null}
        {actionError || clientResolutionError ? (
          <Text testID="notification-action-error" style={styles.errorText}>
            {actionError || clientResolutionError}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginVertical: 5,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: Tokens.palette.line,
    backgroundColor: Tokens.palette.panel,
    overflow: 'hidden',
  },
  cardTerminal: {
    opacity: 0.6,
  },
  accent: {
    width: 3,
    backgroundColor: Tokens.palette.green,
  },
  content: {
    flex: 1,
    padding: 12,
    gap: 5,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  time: {
    flexShrink: 1,
    color: Tokens.palette.muted,
    fontFamily: Fonts.jetBrainsMono.regular,
    fontSize: 10,
    lineHeight: 13,
  },
  title: {
    color: Tokens.palette.text,
    fontFamily: Fonts.rajdhani.bold,
    fontSize: 16,
    lineHeight: 19,
  },
  body: {
    color: Tokens.palette.dim,
    fontFamily: Fonts.rajdhani.medium,
    fontSize: 13.5,
    lineHeight: 19,
  },
  dimmed: {
    color: Tokens.palette.muted,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 3,
  },
  freeTextInput: {
    minHeight: 74,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 4,
    borderWidth: 1,
    color: Tokens.palette.text,
    backgroundColor: 'rgba(255,255,255,0.035)',
    fontFamily: Fonts.rajdhani.medium,
    fontSize: 14,
    lineHeight: 18,
    textAlignVertical: 'top',
  },
  button: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: Tokens.palette.line,
  },
  buttonNoWrap: {
    minWidth: 0,
  },
  buttonPrimary: {
    backgroundColor: `${Tokens.palette.green}1c`,
    borderColor: Tokens.palette.green,
  },
  buttonNeutral: {
    backgroundColor: 'transparent',
  },
  buttonPressed: {
    opacity: 0.68,
  },
  buttonText: {
    color: Tokens.palette.text,
    fontFamily: Fonts.rajdhani.bold,
    fontSize: 14,
    lineHeight: 17,
  },
  buttonTextPrimary: {
    color: Tokens.palette.green,
  },
  decision: {
    marginTop: 4,
    gap: 4,
  },
  decisionText: {
    color: Tokens.palette.dim,
    fontFamily: Fonts.rajdhani.bold,
    fontSize: 13,
    lineHeight: 17,
  },
  decisionRunning: {
    color: Tokens.palette.amber,
    fontFamily: Fonts.rajdhani.bold,
    fontSize: 13,
    lineHeight: 17,
  },
  decisionOk: {
    color: Tokens.palette.green,
  },
  decisionFail: {
    color: Tokens.palette.red,
  },
  decisionMono: {
    color: Tokens.palette.muted,
    fontFamily: Fonts.jetBrainsMono.regular,
    fontSize: 11,
    lineHeight: 15,
  },
  errorText: {
    color: Tokens.palette.red,
    fontFamily: Fonts.rajdhani.medium,
    fontSize: 13,
    marginTop: 8,
  },
});
