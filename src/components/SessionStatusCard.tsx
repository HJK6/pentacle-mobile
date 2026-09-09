import React, { memo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { Fonts, Tokens } from '../../constants/Colors';
import type { PentacleSpecStatusCapability, SessionSpecIssue, SessionStatusCard, SessionStatusCardStep } from 'pentacle-chat-core';
import Bevel from './Bevel';
import { Spinner } from './ArcaneAtoms';
import { modelDisplayName } from '../services/modelDisplay';

const SELECTABLE_TEXT = { selectable: false, selectionColor: Tokens.palette.green };

export type SessionStatusCardSource = {
  status_card?: SessionStatusCard | null;
  context_tokens?: number | null;
  model_context_window?: number | null;
  context_level?: string | null;
  spec_issues?: SessionSpecIssue[] | null;
};

export function formatStatusCardAge(updatedAtIso?: string, nowMs = Date.now()) {
  const stamp = Date.parse(String(updatedAtIso || ''));
  if (!Number.isFinite(stamp)) return '';
  const ageS = Math.max(0, (nowMs - stamp) / 1000);
  if (ageS < 60) return 'just now';
  if (ageS < 3600) return `${Math.floor(ageS / 60)}m ago`;
  if (ageS < 86400) return `${Math.floor(ageS / 3600)}h ago`;
  return `${Math.floor(ageS / 86400)}d ago`;
}

function normalizedText(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function statusCardStepLabel(plan?: SessionStatusCardStep[] | null) {
  if (!Array.isArray(plan) || plan.length === 0) return '';
  const total = plan.length;
  const doneCount = plan.filter((step) => step?.status === 'done').length;
  const active = plan.find((step) => step?.status === 'active');
  if (active) return `${Math.min(doneCount + 1, total)}/${total} · ${normalizedText(active.text)}`;
  return doneCount === total ? `${total}/${total} done` : `${doneCount}/${total}`;
}

function roundedTokenLabel(tokens: number) {
  return `${Math.round(tokens / 1000)}k`;
}

function ClockIcon() {
  return <Svg width={11} height={11} viewBox="0 0 24 24" accessibilityElementsHidden><Circle cx="12" cy="12" r="9" stroke={Tokens.palette.muted} strokeWidth={2.2} fill="none" /><Path d="M12 7.5v5l3 2" stroke={Tokens.palette.muted} strokeWidth={2.2} fill="none" strokeLinecap="round" strokeLinejoin="round" /></Svg>;
}

function contextBadgeTone(level?: string | null) {
  const normalized = String(level || '').toLowerCase();
  if (!normalized) return styles.badgePlain;
  if (normalized === 'critical' || normalized === 'error') return styles.badgeCritical;
  if (normalized === 'warning' || normalized === 'warn' || normalized === 'advisory') return styles.badgeWarning;
  return styles.badgeLevel;
}

export function hasSessionStatusCardContent(source?: SessionStatusCardSource | null) {
  if (!source) return false;
  const card = source.status_card && typeof source.status_card === 'object' ? source.status_card : null;
  return Boolean(card);
}

export const SessionStatusCardView = memo(function SessionStatusCardView({
  source,
  showIssueDetails = false,
  variant = 'row',
}: {
  source?: SessionStatusCardSource | null;
  showIssueDetails?: boolean;
  variant?: 'row' | 'header';
}) {
  if (!hasSessionStatusCardContent(source)) return null;

  const card = source?.status_card && typeof source.status_card === 'object' ? source.status_card : null;
  const goal = normalizedText(card?.goal);
  const step = statusCardStepLabel(card?.plan);
  const update = normalizedText(card?.update);
  const age = card ? formatStatusCardAge(card.updated_at) : '';
  const tokens = Number(source?.context_tokens);
  const windowTokens = Number(source?.model_context_window);
  const contextPct = Number.isFinite(tokens) && tokens > 0 && Number.isFinite(windowTokens) && windowTokens > 0
    ? `${Math.round((tokens / windowTokens) * 100)}%`
    : '';
  const specIssues = Array.isArray(source?.spec_issues) ? source.spec_issues.filter(Boolean) : [];
  const rootStyle = variant === 'header' ? [styles.card, styles.headerCard] : styles.card;

  return (
    <View testID="session-status-card" style={rootStyle}>
      {goal ? (
        <Text {...SELECTABLE_TEXT} style={styles.goalText}>
          {goal}
        </Text>
      ) : null}
      {step ? (
        <Text {...SELECTABLE_TEXT} style={styles.stepText}>
          {step}
        </Text>
      ) : null}
      {update ? (
        <Text {...SELECTABLE_TEXT} style={styles.updateText}>
          {update}
        </Text>
      ) : null}
      {(age || card?.handoff_planned === true || (Number.isFinite(tokens) && tokens > 0) || specIssues.length > 0) ? (
        <View style={styles.metaRow}>
          {age ? (
            <Text {...SELECTABLE_TEXT} style={styles.ageText}>
              {age}
            </Text>
          ) : null}
          {card?.handoff_planned === true ? (
            <View testID="session-status-card-handoff" style={[styles.badge, styles.badgeHandoff]}>
              <Text {...SELECTABLE_TEXT} style={styles.badgeText}>handoff planned</Text>
            </View>
          ) : null}
          {Number.isFinite(tokens) && tokens > 0 ? (
            <View testID="session-status-card-context" style={[styles.badge, contextBadgeTone(source?.context_level)]}>
              <Text {...SELECTABLE_TEXT} style={styles.badgeText}>
                {`${roundedTokenLabel(tokens)}${contextPct ? ` · ${contextPct}` : ''}`}
              </Text>
            </View>
          ) : null}
          {specIssues.length > 0 ? (
            <View testID="session-status-card-spec-issues" style={[styles.badge, styles.badgeSpecIssue]}>
              <Text {...SELECTABLE_TEXT} style={styles.badgeText}>
                {`${specIssues.length} spec issue${specIssues.length === 1 ? '' : 's'}`}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
      {showIssueDetails && specIssues.length > 0 ? (
        <View style={styles.issueList}>
          {specIssues.map((issue, index) => {
            const detail = normalizedText(issue.detail || issue.obligation_id || 'spec issue');
            return (
              <Text {...SELECTABLE_TEXT} key={`${issue.obligation_id || 'issue'}-${index}`} style={styles.issueText}>
                {detail}
              </Text>
            );
          })}
        </View>
      ) : null}
    </View>
  );
});

type StatusCardSession = SessionStatusCardSource & {
  stream_id?: string;
  streamId?: string;
  session_name?: string;
  provider?: string;
  status?: string;
  model?: string | null;
  effort?: string | null;
};

export function lifecycleTone(status: PentacleSpecStatusCapability | undefined) {
  const color = normalizedText(status?.color);
  const validColor = /^#[0-9a-f]{6}$/i.test(color) ? color : '';
  return {
    stroke: validColor || Tokens.palette.line,
    fill: validColor ? `${validColor}18` : 'rgba(255,255,255,0.025)',
  };
}

function planSummary(plan?: SessionStatusCardStep[] | null) {
  const steps = Array.isArray(plan) ? plan : [];
  const done = steps.filter((step) => step.status === 'done').length;
  return { steps, done, total: steps.length, active: steps.find((step) => step.status === 'active') };
}

function progressLabel(done: number, total: number) {
  return total ? `${Math.min(done + 1, total)}/${total}` : '';
}

function contextLabel(session: SessionStatusCardSource) {
  const tokens = Number(session.context_tokens);
  const windowTokens = Number(session.model_context_window);
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  const pct = Number.isFinite(windowTokens) && windowTokens > 0 ? ` · ${Math.round((tokens / windowTokens) * 100)}%` : '';
  return `${roundedTokenLabel(tokens)}${pct}`;
}

function ContextChip({ session, variant = 'mini' }: { session: SessionStatusCardSource; variant?: 'mini' | 'overlay' }) {
  const label = contextLabel(session);
  if (!label) return null;
  return (
    <View testID="status-card-context" style={[styles.badge, variant === 'mini' ? chipStyles.mini : chipStyles.overlay, contextBadgeTone(session.context_level)]} accessibilityLabel={label} accessibilityRole="text">
      <Text {...SELECTABLE_TEXT} style={[styles.badgeText, variant === 'mini' ? chipStyles.miniText : chipStyles.overlayText]}>{label}</Text>
    </View>
  );
}

function HandoffChip({ card, variant = 'mini' }: { card: SessionStatusCard; variant?: 'mini' | 'overlay' }) {
  if (!card.handoff_planned) return null;
  return <View testID="status-card-handoff" style={[styles.badge, variant === 'mini' ? chipStyles.mini : chipStyles.overlay, styles.badgeHandoff]}><Text {...SELECTABLE_TEXT} style={[styles.badgeText, variant === 'mini' ? chipStyles.miniText : chipStyles.overlayText]}>↗ handoff</Text></View>;
}

export const CardStatusMini = memo(function CardStatusMini({
  session,
  card,
  onOpen,
}: {
  session: StatusCardSession;
  card: SessionStatusCard;
  onOpen: (streamId: string) => void;
}) {
  const streamId = session.stream_id || session.streamId || '';
  const { done, total, active } = planSummary(card.plan);
  const goal = normalizedText(card.goal);
  const update = normalizedText(card.update);
  const age = formatStatusCardAge(card.updated_at);
  const progress = total ? `${done}/${total}` : '';
  if (!streamId || (!goal && !total && !update && !age && !contextLabel(session) && !card.handoff_planned)) return null;
  return (
    <Pressable
      testID={`card-status-mini-${streamId}`}
      style={miniStyles.root}
      onPress={() => onOpen(streamId)}
      accessibilityRole="button"
      accessibilityLabel={`Open session status${goal ? `: ${goal}` : ''}`}
    >
      {goal ? <Text {...SELECTABLE_TEXT} style={miniStyles.goal}>{goal}</Text> : null}
      {total ? <>
        <View style={miniStyles.planRow}><View style={miniStyles.track}><View style={[miniStyles.fill, { width: `${Math.round((done / total) * 100)}%` }]} /></View><Text {...SELECTABLE_TEXT} style={miniStyles.summary} accessibilityLabel={`${done} of ${total} plan steps complete`}>{progress}</Text></View>
        {active ? <View style={miniStyles.activeRow}><Spinner size={13} strokeWidth={2} /><Text {...SELECTABLE_TEXT} style={miniStyles.activeText}>{normalizedText(active.text)}</Text></View> : null}
      </> : null}
      {update ? <View style={miniStyles.updateBox}><Text {...SELECTABLE_TEXT} style={miniStyles.update}>{update}</Text></View> : null}
      {(age || contextLabel(session) || card.handoff_planned) ? <View style={miniStyles.meta}>{age ? <View style={miniStyles.ageWrap}><ClockIcon /><Text {...SELECTABLE_TEXT} style={miniStyles.age}>{age}</Text></View> : null}<ContextChip session={session} /><HandoffChip card={card} /></View> : null}
    </Pressable>
  );
});

export const StatusUpdateLog = memo(function StatusUpdateLog({ updates, onBack }: { updates: Array<{ ts: string; text: string }>; onBack: () => void }) {
  const scrollRef = React.useRef<ScrollView>(null);
  const isAtBottomRef = React.useRef(true);
  const previousContentKeyRef = React.useRef<string | null>(null);
  const latestUpdate = updates[updates.length - 1];
  const contentKey = `${updates.length}:${latestUpdate?.ts ?? ''}:${normalizedText(latestUpdate?.text)}`;
  React.useEffect(() => {
    const opening = previousContentKeyRef.current === null;
    const contentChanged = previousContentKeyRef.current !== contentKey;
    previousContentKeyRef.current = contentKey;
    if (!opening && (!contentChanged || !isAtBottomRef.current)) return;
    requestAnimationFrame(() => {
      if (opening || isAtBottomRef.current) scrollRef.current?.scrollToEnd({ animated: false });
    });
  }, [contentKey]);
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    isAtBottomRef.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 24;
  };
  return (
    <ScrollView ref={scrollRef} testID="status-update-log" contentContainerStyle={overlayStyles.updateLog} accessibilityLabel="Status update history" onScroll={onScroll} scrollEventThrottle={16}>
      <View style={overlayStyles.updateLogHeader}>
        <Pressable testID="status-update-log-back" onPress={onBack} accessibilityRole="button" accessibilityLabel="Back to status card"><Text style={overlayStyles.updateLogBack}>‹</Text></Pressable>
        <Text {...SELECTABLE_TEXT} style={overlayStyles.updateLogLabel}>UPDATE LOG</Text>
      </View>
      {updates.map((update, index) => {
        const latest = index === updates.length - 1;
        return <Bevel key={`${update.ts}-${index}`} cut={10} fill={latest ? `${Tokens.palette.green}0c` : 'rgba(255,255,255,0.015)'} stroke={latest ? `${Tokens.palette.green}55` : Tokens.palette.line} style={overlayStyles.updateEntry} contentStyle={overlayStyles.updateEntryContent}>
          <View style={overlayStyles.updateEntryMeta}><Text {...SELECTABLE_TEXT} style={[overlayStyles.updateTime, latest && overlayStyles.latestUpdateTime]}>{formatStatusCardAge(update.ts)}</Text>{latest ? <><View style={overlayStyles.updatePulse} /><Text {...SELECTABLE_TEXT} style={overlayStyles.latestUpdateLabel}>LATEST</Text></> : null}</View>
          <Text {...SELECTABLE_TEXT} style={overlayStyles.updateText}>{normalizedText(update.text)}</Text>
        </Bevel>;
      })}
    </ScrollView>
  );
});

export const StatusOverlay = memo(function StatusOverlay({
  session,
  card,
  initialView = 'card',
  onBackToChats,
  onClose,
  specStatuses = [],
  renderHeader,
  children,
}: {
  session: StatusCardSession;
  card: SessionStatusCard;
  initialView?: 'card' | 'updates';
  onBackToChats: () => void;
  onClose: () => void;
  specStatuses?: PentacleSpecStatusCapability[];
  renderHeader?: (props: { close: () => void; backToChats: () => void; viewingUpdates: boolean }) => React.ReactNode;
  children?: React.ReactNode;
}) {
  const [view, setView] = React.useState<'card' | 'updates'>(initialView);
  React.useEffect(() => setView(initialView), [initialView]);
  const { steps, done, total } = planSummary(card.plan);
  const updates = Array.isArray(card.updates) ? card.updates.filter((item) => normalizedText(item?.text)) : [];
  const specs = Array.isArray(card.specs) ? [...card.specs].sort((left, right) => Number(left.ok) - Number(right.ok)) : [];
  const issueCount = specs.filter((spec) => !spec.ok).length;
  const age = formatStatusCardAge(card.updated_at);
  const title = session.session_name || 'Session status';
  const modelEffort = [normalizedText(session.model) ? modelDisplayName(normalizedText(session.model)) : '', normalizedText(session.effort)].filter(Boolean).join(' · ');
  const statusesByName = new Map(specStatuses.map((status) => [normalizedText(status.name), status]));
  const close = () => view === 'updates' ? setView('card') : onClose();
  return (
    <View style={overlayStyles.backdrop} testID="status-overlay">
      {renderHeader ? renderHeader({ close, backToChats: onBackToChats, viewingUpdates: view === 'updates' }) : <View style={overlayStyles.header}>
        <Pressable testID="status-overlay-back" onPress={onBackToChats} accessibilityRole="button" accessibilityLabel="Back to chats"><Text style={overlayStyles.back}>‹</Text></Pressable>
        <View style={overlayStyles.headerCopy}><Text {...SELECTABLE_TEXT} style={overlayStyles.title} numberOfLines={1}>{title}</Text><Text {...SELECTABLE_TEXT} style={overlayStyles.subtitle}>{session.provider || 'session'} · {session.status || 'live'}</Text></View>
        <Pressable testID="status-overlay-close" onPress={close} accessibilityRole="button" accessibilityLabel={view === 'updates' ? 'Back to status card' : 'Close session status'}><Text style={overlayStyles.close}>✕</Text></Pressable>
      </View>}
      {view === 'updates' ? <StatusUpdateLog updates={updates} onBack={() => setView('card')} /> : <ScrollView contentContainerStyle={overlayStyles.content}>
        {modelEffort ? <Text {...SELECTABLE_TEXT} testID="status-overlay-model-effort" style={overlayStyles.modelEffort}>{modelEffort}</Text> : null}
        {normalizedText(card.goal) || age || contextLabel(session) || card.handoff_planned ? <View style={overlayStyles.section}><View style={overlayStyles.goalHeader}><Text {...SELECTABLE_TEXT} style={overlayStyles.label}>GOAL</Text>{age ? <Text {...SELECTABLE_TEXT} style={overlayStyles.age}>· {age}</Text> : null}<View style={overlayStyles.goalSpacer} /><ContextChip session={session} variant="overlay" /><HandoffChip card={card} variant="overlay" /></View>{normalizedText(card.goal) ? <Text {...SELECTABLE_TEXT} style={overlayStyles.goal}>{normalizedText(card.goal)}</Text> : null}</View> : null}
        {total ? <View style={overlayStyles.section}><View style={overlayStyles.planHeader}><Text {...SELECTABLE_TEXT} style={overlayStyles.label}>PLAN</Text><Text {...SELECTABLE_TEXT} style={overlayStyles.planSummary}>{progressLabel(done, total)}</Text></View><View style={overlayStyles.planTrack} accessibilityLabel={`${done} of ${total} plan steps complete`}><View style={[overlayStyles.planFill, { width: `${Math.round((done / total) * 100)}%` }]} /></View>{steps.map((step, index) => <View key={`${step.text}-${index}`} style={[overlayStyles.step, step.status === 'active' && overlayStyles.stepActive]} accessibilityLabel={`${step.status} plan step: ${step.text}`}><View style={overlayStyles.glyph}>{step.status === 'done' ? <Text style={overlayStyles.done}>✓</Text> : step.status === 'active' ? <Spinner size={15} strokeWidth={2} /> : <Text style={overlayStyles.pending}>○</Text>}</View><Text {...SELECTABLE_TEXT} style={[overlayStyles.stepText, step.status === 'active' && overlayStyles.stepTextActive]}>{normalizedText(step.text)}</Text></View>)}</View> : null}
        {normalizedText(card.update) ? <View style={overlayStyles.section}><View style={overlayStyles.updateHeader}><Text {...SELECTABLE_TEXT} style={overlayStyles.label}>LATEST UPDATE</Text><View style={overlayStyles.updatePulse} />{updates.length > 1 ? <Text {...SELECTABLE_TEXT} style={overlayStyles.updateCount}>{updates.length} updates</Text> : null}</View><Pressable disabled={!updates.length} onPress={() => setView('updates')} accessibilityRole={updates.length ? 'button' : 'text'} accessibilityLabel={updates.length ? `Open ${updates.length} status updates` : 'Latest status update'}><Bevel cut={12} fill="rgba(61,255,102,0.047)" stroke={`${Tokens.palette.green}55`} style={overlayStyles.updateBevel} contentStyle={overlayStyles.updateBevelContent}><Text {...SELECTABLE_TEXT} style={overlayStyles.overlayUpdateText}>{normalizedText(card.update)}</Text><Text style={overlayStyles.updateChevron}>›</Text></Bevel></Pressable></View> : null}
        {specs.length ? <View style={overlayStyles.section} testID="status-overlay-specs"><View style={overlayStyles.specHeading}><Text style={[overlayStyles.specIcon, { color: issueCount ? Tokens.palette.amber : Tokens.palette.green }]}>{issueCount ? '⚠' : '✓'}</Text><Text {...SELECTABLE_TEXT} style={[overlayStyles.label, { color: issueCount ? Tokens.palette.amber : Tokens.palette.green }]}>SPECS</Text><Text {...SELECTABLE_TEXT} style={overlayStyles.specCount}>· {issueCount ? `${issueCount} issue${issueCount === 1 ? '' : 's'}` : `${specs.length} ok`}</Text></View>{specs.map((spec) => {
          const lifecycle = statusesByName.get(normalizedText(spec.status));
          const lifecycleLabel = normalizedText(lifecycle?.display_label || spec.status);
          const tone = lifecycleTone(lifecycle);
          const accessibilityLabel = `${spec.ok ? 'OK' : 'Issue'} spec ${spec.label}${lifecycleLabel ? `, lifecycle ${lifecycleLabel}` : ''}`;
          return <View key={spec.id} accessible accessibilityLabel={accessibilityLabel}><Bevel cut={12} fill={lifecycle ? tone.fill : 'rgba(255,255,255,0.025)'} stroke={lifecycle ? tone.stroke : spec.ok ? `${Tokens.palette.green}66` : `${Tokens.palette.amber}88`} style={overlayStyles.spec} contentStyle={overlayStyles.specContent}><View style={overlayStyles.specRow}><Text style={[overlayStyles.specIcon, { color: spec.ok ? Tokens.palette.green : Tokens.palette.amber }]}>{spec.ok ? '✓' : '⚠'}</Text><Text {...SELECTABLE_TEXT} style={overlayStyles.specLabel}>{spec.label}</Text>{lifecycleLabel ? <Text {...SELECTABLE_TEXT} style={[overlayStyles.specLifecycle, lifecycle && { color: tone.stroke }]}>{lifecycleLabel}</Text> : null}{spec.updated ? <Text {...SELECTABLE_TEXT} style={overlayStyles.specMeta}>{spec.updated}</Text> : null}</View>{normalizedText(spec.note) ? <Text {...SELECTABLE_TEXT} style={overlayStyles.specNote}>{normalizedText(spec.note)}</Text> : null}</Bevel></View>;
        })}</View> : null}
        {children}
      </ScrollView>}
    </View>
  );
});

const miniStyles = StyleSheet.create({
  root: { marginTop: 12, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)', paddingTop: 13, gap: 12 },
  goal: { color: Tokens.palette.text, fontFamily: Fonts.rajdhani.semiBold, fontSize: 14.5, lineHeight: 20 },
  planRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  summary: { color: Tokens.palette.dim, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 10.5 },
  track: { flex: 1, height: 5, borderRadius: 999, backgroundColor: '#04100a', overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 999, backgroundColor: Tokens.palette.green },
  activeRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  activeText: { flex: 1, color: Tokens.palette.text, fontFamily: Fonts.rajdhani.semiBold, fontSize: 13.5, lineHeight: 18 },
  updateBox: { borderWidth: 1, borderColor: `${Tokens.palette.green}2e`, borderRadius: 4, backgroundColor: `${Tokens.palette.green}0c`, paddingVertical: 9, paddingHorizontal: 11 },
  update: { color: Tokens.palette.dim, fontFamily: Fonts.rajdhani.medium, fontSize: 13, lineHeight: 19 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 7 },
  ageWrap: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  age: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 10 },
});

const overlayStyles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, zIndex: 20, backgroundColor: Tokens.palette.ink },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 54, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: Tokens.palette.line, backgroundColor: Tokens.palette.panel },
  back: { color: Tokens.palette.text, fontSize: 32, lineHeight: 32 }, close: { color: Tokens.palette.dim, fontSize: 16 }, headerCopy: { flex: 1, minWidth: 0 }, title: { color: Tokens.palette.text, fontFamily: Fonts.rajdhani.semiBold, fontSize: 19 }, subtitle: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 10 },
  content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 28, gap: 18 }, section: { gap: 9 }, label: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 10, letterSpacing: 1.5 }, modelEffort: { color: Tokens.palette.dim, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 11 },
  goalHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 }, age: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 10.5 }, goalSpacer: { flex: 1 },
  goal: { color: Tokens.palette.text, fontFamily: Fonts.rajdhani.medium, fontSize: 17, lineHeight: 24 }, planHeader: { flexDirection: 'row', alignItems: 'baseline', gap: 12 }, planSummary: { marginLeft: 'auto', color: Tokens.palette.dim, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 10.5 }, planTrack: { height: 6, borderRadius: 999, backgroundColor: '#04100a', overflow: 'hidden' }, planFill: { height: '100%', borderRadius: 999, backgroundColor: Tokens.palette.green },
  step: { flexDirection: 'row', alignItems: 'center', gap: 11, borderWidth: 1, borderColor: 'transparent', borderRadius: 4, paddingVertical: 5, paddingHorizontal: 11 }, stepActive: { backgroundColor: `${Tokens.palette.green}18`, borderColor: `${Tokens.palette.green}55`, paddingVertical: 9 }, glyph: { width: 19, alignItems: 'center' }, done: { color: Tokens.palette.green, fontSize: 14 }, pending: { color: Tokens.palette.muted, fontSize: 17 }, stepText: { flex: 1, color: Tokens.palette.muted, fontFamily: Fonts.rajdhani.medium, fontSize: 14.5, lineHeight: 20 }, stepTextActive: { color: Tokens.palette.text, fontFamily: Fonts.rajdhani.semiBold },
  updateHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 }, updateCount: { marginLeft: 'auto', color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 10 }, updatePulse: { width: 6, height: 6, borderRadius: 3, backgroundColor: Tokens.palette.green }, updateBevel: { minHeight: 72 }, updateBevelContent: { minHeight: 72, paddingVertical: 12, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }, updateEntry: {}, updateEntryContent: { padding: 11, gap: 5 }, overlayUpdateText: { flex: 1, color: Tokens.palette.dim, fontFamily: Fonts.rajdhani.medium, fontSize: 14.5, lineHeight: 22 }, updateChevron: { color: Tokens.palette.green, fontSize: 24, lineHeight: 24 }, updateLog: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 28, gap: 14 }, updateLogHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 2 }, updateLogBack: { color: Tokens.palette.dim, fontSize: 26, lineHeight: 26 }, updateLogLabel: { color: Tokens.palette.green, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 11, letterSpacing: 1.5 }, updateEntryMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 }, updateTime: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 10 }, latestUpdateTime: { color: Tokens.palette.green }, latestUpdateLabel: { color: Tokens.palette.green, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 9, letterSpacing: 1 }, updateText: { color: Tokens.palette.dim, fontFamily: Fonts.rajdhani.medium, fontSize: 14.5, lineHeight: 22 }, spec: {}, specContent: { padding: 10, gap: 4 },
  specHeading: { flexDirection: 'row', alignItems: 'center', gap: 7 }, specCount: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 10.5 }, specRow: { flexDirection: 'row', alignItems: 'center', gap: 9 }, specIcon: { fontSize: 14 }, specLabel: { flex: 1, color: Tokens.palette.text, fontFamily: Fonts.rajdhani.semiBold, fontSize: 14.5, lineHeight: 19 }, specLifecycle: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 9.5 }, specMeta: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 9.5 }, specNote: { marginLeft: 24, color: Tokens.palette.dim, fontFamily: Fonts.rajdhani.medium, fontSize: 13 },
});

const chipStyles = StyleSheet.create({
  mini: { minHeight: 0, paddingVertical: 3, paddingHorizontal: 7, borderRadius: 999 },
  miniText: { fontSize: 9.5, lineHeight: 12, letterSpacing: 0.3 },
  overlay: { minHeight: 0, paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999 },
  overlayText: { fontSize: 10.5, lineHeight: 13, letterSpacing: 0.3 },
});

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: Tokens.palette.line,
    borderRadius: 6,
    backgroundColor: 'rgba(4,16,10,0.58)',
    paddingHorizontal: 10,
    paddingVertical: 9,
    gap: 6,
  },
  headerCard: {
    alignSelf: 'stretch',
    marginTop: 6,
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  goalText: {
    color: Tokens.palette.text,
    fontFamily: Fonts.rajdhani.semiBold,
    fontSize: 13,
    lineHeight: 17,
    letterSpacing: 0,
  },
  stepText: {
    color: Tokens.palette.green,
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 10.5,
    lineHeight: 14,
    letterSpacing: 0,
  },
  updateText: {
    color: Tokens.palette.dim,
    fontFamily: Fonts.rajdhani.medium,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0,
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  },
  ageText: {
    color: Tokens.palette.muted,
    fontFamily: Fonts.jetBrainsMono.regular,
    fontSize: 9.5,
    lineHeight: 13,
    letterSpacing: 0,
  },
  badge: {
    minHeight: 18,
    paddingHorizontal: 6,
    borderRadius: 4,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: Tokens.palette.text,
    fontFamily: Fonts.jetBrainsMono.bold,
    fontSize: 9,
    lineHeight: 11,
    letterSpacing: 0,
  },
  badgePlain: {
    borderColor: Tokens.palette.line,
    backgroundColor: 'rgba(255,255,255,0.035)',
  },
  badgeLevel: {
    borderColor: `${Tokens.palette.green}66`,
    backgroundColor: `${Tokens.palette.green}1c`,
  },
  badgeWarning: {
    borderColor: `${Tokens.palette.amber}72`,
    backgroundColor: `${Tokens.palette.amber}1f`,
  },
  badgeCritical: {
    borderColor: `${Tokens.palette.red}72`,
    backgroundColor: `${Tokens.palette.red}1f`,
  },
  badgeHandoff: {
    borderColor: `${Tokens.palette.green}66`,
    backgroundColor: `${Tokens.palette.green}1c`,
  },
  badgeSpecIssue: {
    borderColor: `${Tokens.palette.amber}72`,
    backgroundColor: `${Tokens.palette.amber}1f`,
  },
  issueList: {
    borderTopWidth: 1,
    borderTopColor: Tokens.palette.line,
    paddingTop: 6,
    gap: 4,
  },
  issueText: {
    color: Tokens.palette.amber,
    fontFamily: Fonts.rajdhani.medium,
    fontSize: 11.5,
    lineHeight: 15,
    letterSpacing: 0,
  },
});
