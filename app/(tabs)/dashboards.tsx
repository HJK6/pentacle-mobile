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
  const [activeId, setActiveId] = useState<DashboardId>('foreclosure');
  const [foreclosureBatch, setForeclosureBatch] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const { client, connectionState, refresh } = useDashboardHub(isFocused);
  const definition = DASHBOARD_REGISTRY[activeId];
  const Renderer = definition.render;
  const snapshot = definition.resolve(
    client.getEnvelope(definition.hubKey),
    connectionState === 'connected',
    { batch: foreclosureBatch },
  );

  useEffect(() => {
    if (isFocused) logFocusedTab('dashboards');
  }, [isFocused]);

  useEffect(() => {
    if (isFocused) refresh(definition.hubKey);
  }, [definition.hubKey, isFocused, refresh]);

  const selectBatch = useCallback((batch: string) => {
    setForeclosureBatch(batch);
    refresh('hosta.foreclosure', { batch });
  }, [refresh]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    refresh(definition.hubKey);
    setTimeout(() => setRefreshing(false), 350);
  }, [definition.hubKey, refresh]);

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
          <Text style={styles.connection}>{connectionState.toUpperCase()}</Text>
        </View>
        <ScrollView horizontal contentContainerStyle={styles.selector} showsHorizontalScrollIndicator={false} testID="dashboard-selector">
          {selector}
        </ScrollView>
        <Renderer snapshot={snapshot} onSelectBatch={selectBatch} onMutateGate={mutateForeclosureGate} />
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
});
