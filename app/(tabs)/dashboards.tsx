import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Fonts, TOP_INSET, Tokens } from '../../constants/Colors';
import Starfield from '../../src/components/Starfield';
import { mutateForeclosureGate } from '../../src/features/dashboards/dashboardHubControl';
import { DASHBOARD_ORDER, DASHBOARD_REGISTRY, type DashboardId } from '../../src/features/dashboards/dashboardRegistry';
import { useDashboardHub } from '../../src/features/dashboards/useDashboardHub';
import { logFocusedTab } from '../../src/services/mobileTabsTelemetry';

export default function DashboardsScreen() {
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const [activeId, setActiveId] = useState<DashboardId | null>(DASHBOARD_ORDER[0] ?? null);
  const [foreclosureBatch, setForeclosureBatch] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const hasBoards = DASHBOARD_ORDER.length > 0;
  // With no boards the tab never connects to (or polls) the dashboard hub.
  const { client, connectionState, refresh } = useDashboardHub(isFocused && hasBoards);
  const definition = activeId ? DASHBOARD_REGISTRY[activeId] ?? null : null;
  const Renderer = definition?.render;
  const snapshot = definition
    ? definition.resolve(client.getEnvelope(definition.hubKey), connectionState === 'connected', { batch: foreclosureBatch })
    : null;

  useEffect(() => {
    if (isFocused) logFocusedTab('dashboards');
  }, [isFocused]);

  useEffect(() => {
    if (isFocused && definition) refresh(definition.hubKey);
  }, [definition, isFocused, refresh]);

  const selectBatch = useCallback((batch: string) => {
    setForeclosureBatch(batch);
    refresh('hosta.foreclosure', { batch });
  }, [refresh]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    if (definition) refresh(definition.hubKey);
    setTimeout(() => setRefreshing(false), 350);
  }, [definition, refresh]);

  const selector = useMemo(() => DASHBOARD_ORDER.map((id) => {
    const item = DASHBOARD_REGISTRY[id];
    const selected = activeId === id;
    return (
      <Pressable
        accessibilityRole="tab"
        accessibilityState={{ selected }}
        key={id}
        onPress={() => setActiveId(id)}
        style={[styles.selectorButton, selected && styles.selectorButtonActive]}
        testID={`dashboard-selector-${id}`}
      >
        <Text style={[styles.selectorText, selected && styles.selectorTextActive]}>{item.label}</Text>
      </Pressable>
    );
  }), [activeId]);

  return (
    <View style={styles.container} testID="dashboards-tab-screen">
      <Starfield />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: Math.max(insets.top, TOP_INSET), paddingBottom: Math.max(insets.bottom, 18) + 92 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={Tokens.palette.green} testID="dashboards-refresh-control" />}
        testID="dashboards-scroll"
      >
        <View style={styles.topRow}>
          <Text style={styles.screenTitle}>DASHBOARDS</Text>
          {hasBoards ? <Text style={styles.connection}>{connectionState.toUpperCase()}</Text> : null}
        </View>
        {hasBoards ? (
          <ScrollView horizontal contentContainerStyle={styles.selector} showsHorizontalScrollIndicator={false} testID="dashboard-selector">
            {selector}
          </ScrollView>
        ) : (
          <View style={styles.empty} testID="dashboards-empty">
            <Text style={styles.emptyTitle}>No dashboards yet</Text>
            <Text style={styles.emptyBody}>New dashboards will appear here when they are ready.</Text>
          </View>
        )}
        {Renderer ? <Renderer snapshot={snapshot} onSelectBatch={selectBatch} onMutateGate={mutateForeclosureGate} /> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: Tokens.palette.ink, flex: 1 },
  content: { paddingHorizontal: 14 },
  topRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
  screenTitle: { color: Tokens.palette.text, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 12, letterSpacing: 1.7 },
  connection: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 9 },
  selector: { gap: 8, paddingBottom: 14 },
  selectorButton: { backgroundColor: Tokens.palette.panel, borderColor: Tokens.palette.line, borderRadius: 8, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 9 },
  selectorButtonActive: { borderColor: Tokens.palette.green },
  selectorText: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase' },
  selectorTextActive: { color: Tokens.palette.text },
  empty: { alignItems: 'center', borderColor: Tokens.palette.line, borderRadius: 8, borderStyle: 'dashed', borderWidth: 1, gap: 6, marginTop: 24, paddingHorizontal: 16, paddingVertical: 28 },
  emptyTitle: { color: Tokens.palette.muted, fontFamily: Fonts.rajdhani.medium, fontSize: 17 },
  emptyBody: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 10, letterSpacing: 0.4, textAlign: 'center' },
});
