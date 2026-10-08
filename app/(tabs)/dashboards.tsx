import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { logTelemetry } from 'pentacle-chat-core';
import { MOBILE_TELEMETRY_EVENTS } from '../../src/services/mobileTelemetryEvents';
import { Fonts, TOP_INSET, Tokens } from '../../constants/Colors';
import Starfield from '../../src/components/Starfield';
import { mutateForeclosureGate } from '../../src/features/dashboards/dashboardHubControl';
import { DASHBOARD_ORDER, DASHBOARD_REGISTRY, mergeCatalogBoards, type DashboardId } from '../../src/features/dashboards/dashboardRegistry';
import { useDashboardHub } from '../../src/features/dashboards/useDashboardHub';
import { logFocusedTab } from '../../src/services/mobileTabsTelemetry';
import { createCatalogLoader, getCatalogSpecId } from '../../src/features/dashboards/catalogLoader';
import { getParam, useHarnessReady } from '../../src/utils/harnessRuntime';

type CatalogResult = Awaited<ReturnType<ReturnType<typeof createCatalogLoader>['refresh']>>;

function cacheAge(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

export default function DashboardsScreen() {
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const [activeId, setActiveId] = useState<DashboardId | null>(DASHBOARD_ORDER[0] ?? null);
  const [foreclosureBatch, setForeclosureBatch] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogReadyForFocus, setCatalogReadyForFocus] = useState(false);
  const [catalogResult, setCatalogResult] = useState<CatalogResult>({ status: 'unset', catalog: null, cached: false });
  const [refreshKey, setRefreshKey] = useState(0);
  const catalogLoader = useRef<ReturnType<typeof createCatalogLoader> | null>(null);
  const catalogGeneration = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const harnessReady = useHarnessReady();
  const ready = process.env.EXPO_PUBLIC_HARNESS !== '1' || harnessReady;
  const { registry, order } = useMemo(() => catalogResult.catalog
    ? mergeCatalogBoards(catalogResult.catalog)
    : { registry: DASHBOARD_REGISTRY, order: DASHBOARD_ORDER }, [catalogResult.catalog]);
  const hasBoards = order.length > 0;
  // Only actual static boards can use the old hub. Catalog boards never activate it.
  const { client, connectionState, refresh } = useDashboardHub(isFocused && DASHBOARD_ORDER.length > 0);
  const selectedId = activeId && Object.prototype.hasOwnProperty.call(registry, activeId) ? activeId : order[0] ?? null;
  const definition = selectedId ? registry[selectedId] ?? null : null;
  const Renderer = definition?.render;
  const snapshot = definition && !definition.catalogBoard
    ? definition.resolve(client.getEnvelope(definition.hubKey), connectionState === 'connected', { batch: foreclosureBatch })
    : null;

  useEffect(() => {
    if (isFocused) logFocusedTab('dashboards');
  }, [isFocused]);

  useEffect(() => {
    if (isFocused && definition && !definition.catalogBoard) refresh(definition.hubKey);
  }, [definition, isFocused, refresh]);

  const refreshCatalog = useCallback(async () => {
    const generation = ++catalogGeneration.current;
    try {
      const spec = getCatalogSpecId();
      if (!spec) {
        catalogLoader.current?.cancel();
        setCatalogResult((previous) => previous.status === 'unset' ? previous : { status: 'unset', catalog: null, cached: false });
        setCatalogBusy(false);
        return;
      }
      setCatalogBusy(true);
      setCatalogReadyForFocus(false);
      if (!catalogLoader.current) {
        const { listReportsBySpec, getReportByOwner } = require('../../src/services/pentacleAssets') as typeof import('../../src/services/pentacleAssets');
        catalogLoader.current = createCatalogLoader({
          listReportsBySpec: (specId, options) => {
            if (process.env.EXPO_PUBLIC_HARNESS === '1') {
              try {
                logTelemetry(MOBILE_TELEMETRY_EVENTS.HARNESS_UI_TRACE as Parameters<typeof logTelemetry>[0], {
                kind: 'dashboard_catalog_asset_list',
                  scenario_run_id: getParam('scenario_run_id') ?? null, spec_id: specId,
                });
              } catch { /* Evidence collection must not alter catalog behaviour. */ }
            }
            return listReportsBySpec(specId, options);
          },
          getReportByOwner: async (streamId, assetId, specId) => {
          const record = (status: 'ok' | 'error', error?: unknown) => {
            if (process.env.EXPO_PUBLIC_HARNESS !== '1') return;
            try {
              logTelemetry(MOBILE_TELEMETRY_EVENTS.HARNESS_UI_TRACE as Parameters<typeof logTelemetry>[0], {
                kind: 'dashboard_catalog_asset_get', scenario_run_id: getParam('scenario_run_id') ?? null,
                asset_id: assetId, spec_id: specId, listed_stream_id: streamId, request_stream_id: streamId, status,
                ...(status === 'error' ? { error_code: error instanceof Error ? error.message : String(error) } : {}),
              });
            } catch { /* Evidence collection must not alter catalog behaviour. */ }
          };
          try { const asset = await getReportByOwner(streamId, assetId, specId); record('ok'); return asset; }
          catch (error) { record('error', error); throw error; }
        },
        });
      }
      const result = await catalogLoader.current.refresh(spec);
      if (generation !== catalogGeneration.current || result.status === 'superseded') return;
      setCatalogResult(result);
      setRefreshKey((value) => value + 1);
      setCatalogReadyForFocus(true);
    } catch (error) {
      if (generation !== catalogGeneration.current) return;
      const message = error instanceof Error ? error.message : String(error);
      setCatalogResult({ status: 'unavailable', catalog: null, cached: false, message: `Dashboard catalog unavailable: ${message}` });
    } finally {
      if (generation === catalogGeneration.current) setCatalogBusy(false);
    }
  }, []);

  useEffect(() => {
    if (isFocused && ready) void refreshCatalog();
    return () => {
      ++catalogGeneration.current;
      catalogLoader.current?.cancel();
      setCatalogReadyForFocus(false);
      setCatalogBusy(false);
      setRefreshing(false);
      if (refreshTimer.current) { clearTimeout(refreshTimer.current); refreshTimer.current = null; }
    };
  }, [isFocused, ready, refreshCatalog]);

  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);

  useEffect(() => {
    if (activeId !== selectedId) setActiveId(selectedId);
  }, [activeId, selectedId]);

  const selectBatch = useCallback((batch: string) => {
    setForeclosureBatch(batch);
    refresh('hosta.foreclosure', { batch });
  }, [refresh]);

  const handleRefresh = useCallback(() => {
    if (!ready) return;
    setRefreshing(true);
    if (definition && !definition.catalogBoard) refresh(definition.hubKey);
    if (getCatalogSpecId() && ready) {
      const generation = catalogGeneration.current + 1;
      void refreshCatalog().finally(() => {
        if (catalogGeneration.current === generation) setRefreshing(false);
      });
    } else {
      void refreshCatalog();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => setRefreshing(false), 350);
    }
  }, [definition, ready, refresh, refreshCatalog]);

  const selector = useMemo(() => order.map((id) => {
    const item = registry[id];
    const selected = selectedId === id;
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
  }), [order, registry, selectedId]);

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
          {DASHBOARD_ORDER.length ? <Text style={styles.connection}>{connectionState.toUpperCase()}</Text> : null}
        </View>
        {catalogResult.message ? <View style={styles.statusCard} testID={catalogResult.status === 'unavailable' ? 'dashboard-catalog-unavailable' : 'dashboard-catalog-error'}>
          <Text style={styles.statusText}>{catalogResult.message}</Text>
        </View> : null}
        {catalogResult.catalog ? <View accessible accessibilityLabel={catalogResult.catalog.catalog_version} testID="dashboard-catalog-version">
          <Text style={styles.catalogVersion}>{catalogResult.catalog.catalog_version}</Text>
        </View> : null}
        {catalogResult.cached ? <Text style={styles.catalogVersion} testID="dashboard-catalog-cached">catalog cached {cacheAge(catalogResult.age ?? 0)}</Text> : null}
        {catalogBusy ? <Text style={styles.catalogVersion}>Loading dashboard catalog…</Text> : null}
        {hasBoards ? (
          <ScrollView horizontal contentContainerStyle={styles.selector} showsHorizontalScrollIndicator={false} testID="dashboard-selector">
            {selector}
          </ScrollView>
        ) : (
          <View style={styles.empty} testID="dashboards-empty">
            <View accessible accessibilityLabel="No dashboards yet" testID="dashboards-empty-state">
              <Text style={styles.emptyTitle}>No dashboards yet</Text>
            </View>
            <Text style={styles.emptyBody}>New dashboards will appear here when they are ready.</Text>
          </View>
        )}
        {Renderer ? <Renderer key={selectedId} snapshot={snapshot} onSelectBatch={selectBatch} onMutateGate={mutateForeclosureGate} active={isFocused && !catalogBusy && catalogReadyForFocus} refreshKey={refreshKey} /> : null}
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
  statusCard: { backgroundColor: Tokens.palette.panel, borderColor: Tokens.palette.line, borderRadius: 8, borderWidth: 1, padding: 12, marginBottom: 12 },
  statusText: { color: '#ff8b7c', fontFamily: Fonts.jetBrainsMono.regular, fontSize: 12 },
  catalogVersion: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 10, marginBottom: 12 },
  selector: { gap: 8, paddingBottom: 14 },
  selectorButton: { backgroundColor: Tokens.palette.panel, borderColor: Tokens.palette.line, borderRadius: 8, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 9 },
  selectorButtonActive: { borderColor: Tokens.palette.green },
  selectorText: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase' },
  selectorTextActive: { color: Tokens.palette.text },
  empty: { alignItems: 'center', borderColor: Tokens.palette.line, borderRadius: 8, borderStyle: 'dashed', borderWidth: 1, gap: 6, marginTop: 24, paddingHorizontal: 16, paddingVertical: 28 },
  emptyTitle: { color: Tokens.palette.muted, fontFamily: Fonts.rajdhani.medium, fontSize: 17 },
  emptyBody: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 10, letterSpacing: 0.4, textAlign: 'center' },
});
