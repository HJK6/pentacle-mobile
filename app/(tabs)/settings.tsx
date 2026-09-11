import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Fonts,
  MACHINES,
  SCREEN_PAD,
  TOP_INSET,
  Tokens,
  type MachineName,
} from '@/constants/Colors';
import { getHostMachineName } from '../../src/config/local';
import ArcaneRingFrame from '../../src/components/ArcaneRingFrame';
import Starfield from '../../src/components/Starfield';
import { Bar, Spinner } from '../../src/components/ArcaneAtoms';
import usePentacleToken from '../../src/hooks/usePentacleToken';
import {
  usePentacleStreamActions,
  usePentacleStreamSelectorWhen,
} from '../../src/services/pentacleStream';
import {
  limitHealthText,
  selectMachineStatsTabs,
  type PentacleLimit,
  type PentacleLimitsHealth,
  type PentacleMachineStatsCard,
} from 'pentacle-chat-core';
import useLimits, { useLimitsHealth } from '../../src/hooks/useLimits';
import { useUserPreference } from '../../src/services/userPreferences';
import { logFocusedTab } from '../../src/services/mobileTabsTelemetry';
import { getAppIdentity } from '../../src/config/appIdentity';

const P = {
  bg: Tokens.palette.ink,
  panel: Tokens.palette.panel,
  border: Tokens.palette.line,
  text: Tokens.palette.text,
  dim: Tokens.palette.dim,
  muted: Tokens.palette.muted,
  green: Tokens.palette.green,
  amber: Tokens.palette.amber,
  red: Tokens.palette.red,
  offline: Tokens.palette.muted,
};

type DisplayMachineStatsCard = PentacleMachineStatsCard & {
  machineName: MachineName;
};

export function buildMachineTabs(machines: PentacleMachineStatsCard[]): DisplayMachineStatsCard[] {
  // Machine skins are presentation, never host identity. The selector already
  // supplies configured offline hosts; preserve every host and its actual data.
  return machines.map((machine) => ({
    ...machine,
    machineName: getHostMachineName(machine.host),
  }));
}

// A daemon-owned sample older than this is rendered stale (matches the desktop
// footer and docs/chat_protocol.md § Machine stats).
const MACHINE_STATS_STALE_MS = 90 * 1000;
// ONE render-only interval re-evaluates staleness so a card that ages past the
// threshold re-flags without a new frame. Render-only — it touches no data
// path (coordinator ruling 2026-09-04); no sampler, poll, or cache is added.
const MACHINE_STATS_STALE_REEVAL_MS = 30 * 1000;

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const { token, isReady, clearToken } = usePentacleToken();
  const [refreshing, setRefreshing] = useState(false);
  const [activeHost, setActiveHost] = useState<string>('');
  const [showToolActions, setShowToolActions] = useUserPreference('showToolActions');
  const [showTurnDuration, setShowTurnDuration] = useUserPreference('showTurnDuration');
  const actions = usePentacleStreamActions();
  const machines = usePentacleStreamSelectorWhen(isFocused, selectMachineStatsTabs, sameMachines);
  const limits = useLimits(isFocused);
  const limitsHealth = useLimitsHealth(isFocused);
  const appIdentity = useMemo(() => getAppIdentity(), []);
  const displayMachines = useMemo(() => buildMachineTabs(machines), [machines]);
  const activeMachine = useMemo(
    () => displayMachines.find((machine) => machine.host === activeHost) || displayMachines[0],
    [activeHost, displayMachines],
  );

  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), MACHINE_STATS_STALE_REEVAL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (isFocused) logFocusedTab('settings');
  }, [isFocused]);

  useEffect(() => {
    if (!displayMachines.length) return;
    const preferredHost = machines[0]?.host || displayMachines[0].host;
    if (!activeHost || !displayMachines.some((machine) => machine.host === activeHost)) {
      setActiveHost(preferredHost);
    }
  }, [activeHost, displayMachines, machines]);

  const handleRefresh = async () => {
    try {
      setRefreshing(true);
      actions.reconnect();
    } finally {
      setTimeout(() => setRefreshing(false), 700);
    }
  };

  if (!isReady) {
    return (
      <View style={[styles.center, styles.container]}>
        <Starfield />
        <Spinner size={38} color={P.green} />
      </View>
    );
  }

  if (!token) {
    return (
      <View style={styles.container}>
        <Starfield />
        <View style={[styles.center, styles.emptyState]}>
          <Text style={styles.emptyTitle}>Pentacle settings are unavailable until this device is enrolled.</Text>
          <Text style={styles.emptyBody}>
            Enroll this device from a Pentacle enrollment link. Once the stream token is stored behind Face ID, live machine status and stats will appear here.
          </Text>
          <AppVersionRow version={appIdentity.version} buildNumber={appIdentity.buildNumber} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Starfield />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: Math.max(insets.top, TOP_INSET), paddingBottom: Math.max(insets.bottom, 18) + 92 },
        ]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={P.green} />}
      >
        <LimitsSection limits={limits} health={limitsHealth} />

        <ChatSettingsSection
          showToolActions={showToolActions}
          showTurnDuration={showTurnDuration}
          onShowToolActionsChange={(next) => {
            void setShowToolActions(next);
          }}
          onShowTurnDurationChange={(next) => {
            void setShowTurnDuration(next);
          }}
        />

        <AppVersionRow version={appIdentity.version} buildNumber={appIdentity.buildNumber} />

        <Pressable
          testID="settings-sign-out"
          accessibilityRole="button"
          accessibilityLabel="Sign out of Pentacle"
          onPress={() => {
            void clearToken();
          }}
          style={({ pressed }) => [styles.signOutButton, pressed && styles.signOutButtonPressed]}
        >
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>

        <View style={styles.machineTabs} accessibilityRole="tablist">
          {displayMachines.map((machine) => {
            const active = machine.host === activeHost;
            const accent = MACHINES[machine.machineName].accent;
            return (
            <Pressable
              key={machine.host}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`${machine.title} ${machine.statusLabel}`}
              onPress={() => setActiveHost(machine.host)}
              style={({ pressed }) => [
                styles.machineTab,
                { borderColor: active ? accent : Tokens.palette.line, backgroundColor: active ? `${accent}14` : 'transparent' },
                pressed && styles.machineTabPressed,
              ]}
            >
              <ArcaneRingFrame machine={machine.machineName} size={34} sigilSize={20} />
              <Text style={[styles.machineTabText, active && styles.machineTabTextActive]} numberOfLines={1}>
                {machine.title}
              </Text>
              <View style={[styles.machineDot, { backgroundColor: machine.online ? accent : P.offline }]} />
            </Pressable>
          );})}
        </View>

        {activeMachine ? <MachineStatsPanel machine={activeMachine} now={nowTick} /> : null}
      </ScrollView>
    </View>
  );
}

function AppVersionRow({ version, buildNumber }: { version: string; buildNumber: string }) {
  return (
    <View
      style={styles.versionCard}
      accessibilityLabel={`App version ${version}, build ${buildNumber}`}
    >
      <View style={styles.preferenceCopy}>
        <Text style={styles.preferenceTitle}>App version</Text>
        <Text style={styles.preferenceDescription}>Build {buildNumber}</Text>
      </View>
      <Text style={styles.versionValue} numberOfLines={1}>v{version}</Text>
    </View>
  );
}

function LimitsSection({
  limits,
  health,
}: {
  limits: PentacleLimit[];
  health: PentacleLimitsHealth | null;
}) {
  return (
    <View testID="limits-section" style={styles.usageCard}>
      <View style={styles.usageHeader}>
        <Text style={styles.usageTitle}>Limits</Text>
        <Text style={styles.usageMeta}>Weekly</Text>
      </View>
      {limits.map((limit) => (
        <LimitRow key={limit.id} limit={limit} health={health?.[limit.id] ?? null} />
      ))}
    </View>
  );
}

function LimitRow({
  limit,
  health,
}: {
  limit: PentacleLimit;
  health: PentacleLimitsHealth[PentacleLimit['id']];
}) {
  const pct = limit.pct ?? 0;
  const pctText = limit.pct === null ? '—' : `${limit.pct}%`;
  const resetText = limit.resets_text || 'Reset unavailable';
  const spokenPct = limit.pct === null ? 'unavailable' : `${limit.pct} percent used`;
  // Probe health is additive text; a row is never hidden on account of it.
  const healthText = limitHealthText(health);
  const a11y = healthText
    ? `${limit.label} weekly limit, ${spokenPct}, ${resetText}, ${healthText}`
    : `${limit.label} weekly limit, ${spokenPct}, ${resetText}`;
  return (
    <View
      testID={`limits-row-${limit.id}`}
      accessible
      accessibilityLabel={a11y}
      style={styles.usageRow}
    >
      <View style={styles.rowBetween}>
        <Text style={styles.usageLabel}>{limit.label}</Text>
        <Text style={styles.usagePct}>{pctText}</Text>
      </View>
      <Bar pct={pct} color={usageColor(pct)} />
      <Text style={styles.usageReset}>{resetText}</Text>
      {healthText ? (
        <Text testID={`limits-health-${limit.id}`} style={styles.usageHealth}>{healthText}</Text>
      ) : null}
    </View>
  );
}

function ChatSettingsSection({
  showToolActions,
  showTurnDuration,
  onShowToolActionsChange,
  onShowTurnDurationChange,
}: {
  showToolActions: boolean;
  showTurnDuration: boolean;
  onShowToolActionsChange: (value: boolean) => void;
  onShowTurnDurationChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.settingsSection}>
      <View style={styles.preferenceRow}>
        <View style={styles.preferenceCopy}>
          <Text style={styles.preferenceTitle}>Show tool actions</Text>
          <Text style={styles.preferenceDescription}>
            Show "Explored", "Read file", and other tool events in chats.
          </Text>
        </View>
        <Switch
          accessibilityLabel="Show tool actions"
          value={showToolActions}
          onValueChange={onShowToolActionsChange}
          trackColor={{ false: 'rgba(127,168,150,0.26)', true: P.green }}
          thumbColor={showToolActions ? P.bg : P.muted}
          ios_backgroundColor={P.border}
        />
      </View>
      <View style={styles.preferenceRow}>
        <View style={styles.preferenceCopy}>
          <Text style={styles.preferenceTitle}>Show turn duration</Text>
          <Text style={styles.preferenceDescription}>
            Show "Worked for" divider rows after completed agent turns.
          </Text>
        </View>
        <Switch
          accessibilityLabel="Show turn duration"
          value={showTurnDuration}
          onValueChange={onShowTurnDurationChange}
          trackColor={{ false: 'rgba(127,168,150,0.26)', true: P.green }}
          thumbColor={showTurnDuration ? P.bg : P.muted}
          ios_backgroundColor={P.border}
        />
      </View>
    </View>
  );
}

function MachineStatsPanel({ machine, now }: { machine: DisplayMachineStatsCard; now: number }) {
  const stats = machine.stats;
  const accent = MACHINES[machine.machineName].accent;
  const stale = stats ? machineStatsIsStale(stats, now) : false;
  const memPct = stats ? usagePct(stats.memory_used_bytes, stats.memory_total_bytes) : null;
  const diskPct = stats ? usagePct(stats.disk_used_bytes, stats.disk_total_bytes) : null;
  const badge = !stats ? 'OFFLINE' : stale ? 'STALE' : 'LIVE';
  useEffect(() => {
    if (process.env.EXPO_PUBLIC_HARNESS !== '1') return;
    const runtime = require('../../src/utils/harnessRuntime') as typeof import('../../src/utils/harnessRuntime');
    if (!runtime.isArmed()) return;
    const { logTelemetry } = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
    const { MOBILE_TELEMETRY_EVENTS } = require('../../src/services/mobileTelemetryEvents') as typeof import('../../src/services/mobileTelemetryEvents');
    logTelemetry(MOBILE_TELEMETRY_EVENTS.HARNESS_UI_TRACE as Parameters<typeof logTelemetry>[0], {
      kind: 'machine_stats_rendered', host: machine.host, stats, badge,
      timestamp_emitter_wall: Date.now(),
      ram: formatPct(memPct), disk: formatPct(diskPct),
      load: stats ? formatLoad(stats.cpu_load_1m) : '--',
      uptime: stats ? formatUptime(stats.uptime_seconds) : '--',
    });
  }, [machine.host, stats, badge, memPct, diskPct]);

  return (
    <View testID={`machine-stats-${machine.host}`} style={[styles.statsPanel, { borderColor: `${accent}44`, backgroundColor: `${accent}0c` }]}>
      <View style={styles.statsHeader}>
        <View style={styles.machineTitleRow}>
          <ArcaneRingFrame machine={machine.machineName} size={34} sigilSize={20} />
          <Text style={styles.statsTitle}>{machine.title}</Text>
        </View>
        <Text style={[styles.statsState, !stats ? undefined : stale ? styles.statsStateStale : styles.statsStateOnline]}>
          {badge}
        </Text>
      </View>

      {stats ? (
        <View style={styles.statsBody}>
          <StatMeter label="RAM" value={memPct} detail={bytesDetail(stats.memory_used_bytes, stats.memory_total_bytes)} />
          <StatMeter label="Storage" value={diskPct} detail={bytesDetail(stats.disk_used_bytes, stats.disk_total_bytes)} />
          <View style={styles.statGrid}>
            <StatPill label="Load 1m" value={formatLoad(stats.cpu_load_1m)} />
            <StatPill label="Uptime" value={formatUptime(stats.uptime_seconds)} />
          </View>
        </View>
      ) : (
        <Text style={styles.statsNote}>No stats available</Text>
      )}
    </View>
  );
}

function StatMeter({ label, value, detail }: { label: string; value: number | null; detail?: string }) {
  const pct = Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Number(value))) : 0;
  return (
    <View style={styles.statMeter}>
      <View style={styles.rowBetween}>
        <Text style={styles.statLabel}>{label}</Text>
        <Text style={styles.statValue}>{formatPct(value)}{detail ? ` · ${detail}` : ''}</Text>
      </View>
      <Bar pct={pct} color={usageColor(pct)} />
    </View>
  );
}

function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statPill}>
      <Text style={styles.statPillLabel}>{label}</Text>
      <Text style={styles.statPillValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function usageColor(pct: number) {
  if (pct >= 85) return P.red;
  if (pct >= 60) return P.amber;
  return P.green;
}

function formatPct(value?: number | null) {
  return value !== null && value !== undefined && Number.isFinite(Number(value)) ? `${Math.round(Number(value))}%` : '--';
}

function usagePct(used: number, total: number): number | null {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, (used / total) * 100));
}

function fmtBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '--';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits).replace(/\.0+$/, '')} ${units[unit]}`;
}

function bytesDetail(used: number, total: number): string {
  return `${fmtBytes(used)} / ${fmtBytes(total)}`;
}

function formatLoad(value: number): string {
  return Number.isFinite(value) ? String(Number(value)) : '--';
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  let rest = Math.floor(seconds);
  const days = Math.floor(rest / 86400);
  rest %= 86400;
  const hours = Math.floor(rest / 3600);
  rest %= 3600;
  const minutes = Math.floor(rest / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// Stale when the daemon-owned sample is older than the threshold, or its
// timestamp is unparseable. The client never invents an offline row.
function machineStatsIsStale(stats: { sampled_at: string }, now: number): boolean {
  const sampledAt = Date.parse(String(stats.sampled_at || ''));
  return !Number.isFinite(sampledAt) || now - sampledAt > MACHINE_STATS_STALE_MS;
}

function sameMachines(a: PentacleMachineStatsCard[], b: PentacleMachineStatsCard[]) {
  return (
    a.length === b.length &&
    a.every((item, index) => {
      const other = b[index];
      return (
        item.host === other.host &&
        item.title === other.title &&
        item.online === other.online &&
        item.sessionCount === other.sessionCount &&
        item.statusLabel === other.statusLabel &&
        item.error === other.error &&
        item.stats === other.stats
      );
    })
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: P.bg,
    position: 'relative',
  },
  center: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  content: {
    paddingHorizontal: SCREEN_PAD,
    gap: 12,
  },
  usageCard: {
    borderRadius: 4,
    borderWidth: 1,
    borderColor: P.border,
    backgroundColor: P.panel,
    padding: 14,
    gap: 10,
  },
  usageHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  usageTitle: {
    color: P.text,
    fontFamily: Fonts.rajdhani.bold,
    fontSize: 16,
    lineHeight: 20,
  },
  usageMeta: {
    color: P.muted,
    fontFamily: Fonts.jetBrainsMono.regular,
    fontSize: 11,
    lineHeight: 14,
    textTransform: 'uppercase',
  },
  usageRow: {
    gap: 5,
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  usageLabel: {
    color: P.text,
    fontFamily: Fonts.rajdhani.bold,
    fontSize: 13,
    lineHeight: 16,
  },
  usagePct: {
    color: P.muted,
    fontFamily: Fonts.jetBrainsMono.regular,
    fontSize: 11,
    lineHeight: 14,
  },
  usageReset: {
    color: P.muted,
    fontFamily: Fonts.jetBrainsMono.regular,
    fontSize: 10,
    lineHeight: 13,
  },
  usageHealth: {
    color: P.amber,
    fontFamily: Fonts.jetBrainsMono.regular,
    fontSize: 10,
    lineHeight: 13,
    marginTop: 2,
  },
  settingsSection: {
    borderRadius: 4,
    borderWidth: 1,
    borderColor: P.border,
    backgroundColor: P.panel,
    padding: 14,
    gap: 0,
  },
  versionCard: {
    alignSelf: 'stretch',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: P.border,
    backgroundColor: P.panel,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  versionValue: {
    color: P.green,
    fontFamily: Fonts.jetBrainsMono.bold,
    fontSize: 13,
    lineHeight: 17,
    flexShrink: 0,
  },
  signOutButton: {
    alignSelf: 'stretch',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: `${P.red}88`,
    backgroundColor: `${P.red}10`,
    paddingHorizontal: 14,
    paddingVertical: 12,
    alignItems: 'center',
  },
  signOutButtonPressed: {
    opacity: 0.68,
  },
  signOutText: {
    color: P.red,
    fontFamily: Fonts.rajdhani.bold,
    fontSize: 15,
    lineHeight: 19,
  },
  sectionTitle: {
    color: P.text,
    fontSize: 15,
    fontWeight: '800',
  },
  preferenceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  preferenceCopy: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  preferenceTitle: {
    color: P.text,
    fontFamily: Fonts.rajdhani.bold,
    fontSize: 15,
    lineHeight: 19,
  },
  preferenceDescription: {
    color: P.muted,
    fontFamily: Fonts.rajdhani.medium,
    fontSize: 13,
    lineHeight: 18,
  },
  machineTabs: {
    flexDirection: 'row',
    gap: 8,
  },
  machineTab: {
    flex: 1,
    minWidth: 0,
    borderRadius: 4,
    borderWidth: 1,
    alignItems: 'center',
    paddingHorizontal: 4,
    paddingVertical: 10,
    gap: 5,
  },
  machineTabPressed: {
    opacity: 0.68,
  },
  machineDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
  },
  machineTabText: {
    color: P.muted,
    fontFamily: Fonts.rajdhani.bold,
    fontSize: 12,
    lineHeight: 15,
    textAlign: 'center',
  },
  machineTabTextActive: {
    color: P.text,
  },
  machineTabStatus: {
    color: P.muted,
    fontSize: 10,
    fontWeight: '700',
  },
  statsPanel: {
    borderRadius: 4,
    padding: 14,
    backgroundColor: P.panel,
    borderWidth: 1,
    borderColor: P.border,
    gap: 12,
  },
  statsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  machineTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    flex: 1,
    minWidth: 0,
  },
  machineDotLarge: {
    width: 9,
    height: 9,
    borderRadius: 999,
  },
  statsTitle: {
    color: P.text,
    fontSize: 16,
    lineHeight: 20,
    fontFamily: Fonts.rajdhani.bold,
  },
  statsState: {
    color: P.offline,
    fontSize: 10,
    lineHeight: 13,
    fontFamily: Fonts.jetBrainsMono.bold,
    letterSpacing: 1,
  },
  statsStateOnline: {
    color: P.green,
  },
  statsStateStale: {
    color: P.amber,
  },
  statsBody: {
    gap: 10,
  },
  statMeter: {
    gap: 5,
  },
  statLabel: {
    color: P.text,
    fontFamily: Fonts.rajdhani.bold,
    fontSize: 13,
    lineHeight: 16,
  },
  statValue: {
    color: P.muted,
    fontFamily: Fonts.jetBrainsMono.regular,
    fontSize: 11,
    lineHeight: 14,
    flexShrink: 1,
    textAlign: 'right',
  },
  statGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  statPill: {
    width: '48%',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: P.border,
    paddingHorizontal: 10,
    paddingVertical: 9,
    backgroundColor: 'rgba(61,255,102,0.06)',
    gap: 3,
  },
  statPillLabel: {
    color: P.muted,
    fontSize: 10,
    lineHeight: 13,
    fontFamily: Fonts.jetBrainsMono.bold,
    textTransform: 'uppercase',
  },
  statPillValue: {
    color: P.text,
    fontSize: 12,
    lineHeight: 15,
    fontFamily: Fonts.jetBrainsMono.medium,
  },
  statsNote: {
    color: P.muted,
    fontFamily: Fonts.rajdhani.medium,
    fontSize: 14,
    lineHeight: 20,
  },
  emptyState: {
    flex: 1,
    gap: 12,
  },
  emptyTitle: {
    color: P.text,
    fontSize: 18,
    fontFamily: Fonts.rajdhani.bold,
    textAlign: 'center',
  },
  emptyBody: {
    color: P.muted,
    fontSize: 14,
    lineHeight: 20,
    fontFamily: Fonts.rajdhani.medium,
    textAlign: 'center',
  },
});
