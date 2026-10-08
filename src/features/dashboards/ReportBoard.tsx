import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { logTelemetry } from 'pentacle-chat-core';
import { MOBILE_TELEMETRY_EVENTS } from '../../services/mobileTelemetryEvents';
import { Fonts, Tokens } from '../../../constants/Colors';
import { ReportBlockBody } from '../../components/ReportViewerModal';
import { getReportByOwner, listReportsBySpec, parseReportBody, type ReportBody } from '../../services/pentacleAssets';
import { reportRequest, selectReports, type CatalogBoard, type ReportDescriptor } from './catalogLoader';
import { getParam } from '../../utils/harnessRuntime';

type Outcome = ReturnType<typeof selectReports>;
type Entry = NonNullable<Outcome['latestEntry']>;
type Props = { board: CatalogBoard; active?: boolean; refreshKey?: number };
type Viewer = { entry: Entry; body: ReportBody | null; error?: string; loading: boolean; request: number };

function reason(error: unknown): string {
  if (error && typeof error === 'object') {
    const value = error as { message?: unknown; code?: unknown };
    return String(value.message || value.code || 'unknown error');
  }
  return String(error || 'unknown error');
}

function titleFor(descriptor: ReportDescriptor, entry: Entry): string {
  return (descriptor.title_template ?? '{key} r{rev}').replace(/\{(key|rev)\}/g, (_, key: 'key' | 'rev') => String(entry[key]));
}

function recordGet(board: CatalogBoard, descriptor: ReportDescriptor, entry: Entry, status: 'ok' | 'error', error?: unknown) {
  if (process.env.EXPO_PUBLIC_HARNESS !== '1') return;
  try {
    logTelemetry(MOBILE_TELEMETRY_EVENTS.HARNESS_UI_TRACE as Parameters<typeof logTelemetry>[0], {
      kind: 'dashboard_report_asset_get',
      scenario_run_id: getParam('scenario_run_id') ?? null,
      board_id: board.id, asset_id: entry.row.asset_id, spec_id: descriptor.spec_id,
      listed_stream_id: entry.row.stream_id, request_stream_id: entry.row.stream_id, status,
      ...(status === 'error' ? { error_code: reason(error) } : {}),
    });
  } catch { /* Evidence collection must not alter report behaviour. */ }
}

// A malformed body must remain inside this board, even if a shared block renderer throws.
class BodyBoundary extends React.Component<{ children: React.ReactNode; onError: (error: unknown) => void }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) { return { error: reason(error) }; }
  componentDidCatch(error: unknown) { this.props.onError(error); }
  render() {
    return this.state.error
      ? <Text style={styles.error} testID="dashboard-board-error">Board failed to load: {this.state.error}</Text>
      : this.props.children;
  }
}

function Body({ body }: { body: ReportBody }) {
  return <>
    {body.sections.map((section, index) => (
      <View key={`${section.id}-${index}`} style={styles.section}>
        <Text style={styles.sectionTitle}>{section.title}</Text>
        {section.blocks.map((block, blockIndex) => (
          <ReportBlockBody key={`${block.id}-${blockIndex}`} block={block} />
        ))}
      </View>
    ))}
  </>;
}

export default function ReportBoard({ board, active = true, refreshKey = 0 }: Props) {
  const descriptor = board.kind === 'report' ? board.report : undefined;
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState('');
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const viewerRequest = useRef(0);

  const openReport = useCallback(async (entry: Entry, expectedGeneration: number) => {
    if (!active || !descriptor || generation.current !== expectedGeneration) return;
    const request = ++viewerRequest.current;
    const current = () => generation.current === expectedGeneration && viewerRequest.current === request;
    setViewer({ entry, body: null, loading: true, request });
    try {
      const row = entry.row;
      if (typeof row.stream_id !== 'string' || !row.stream_id) throw new Error('report is missing its owner stream_id');
      let report;
      try {
        report = await getReportByOwner(row.stream_id, row.asset_id, descriptor.spec_id);
        recordGet(board, descriptor, entry, 'ok');
      } catch (cause) {
        recordGet(board, descriptor, entry, 'error', cause);
        throw cause;
      }
      if (!current()) return;
      const body = parseReportBody(report);
      setViewer({ entry, body, loading: false, request });
    } catch (cause) {
      if (current()) setViewer({ entry, body: null, error: reason(cause), loading: false, request });
    }
  }, [active, board, descriptor]);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    ++viewerRequest.current;
    if (!active || !descriptor) return;
    setLoading(true);
    setError(null);
    setOutcome(null);
    setViewer(null);
    void (async () => {
      try {
        const request = reportRequest(descriptor);
        const rows = await listReportsBySpec(request.spec_id, {
          assetIdPrefix: request.asset_id_prefix,
          ...(request.producer === undefined ? {} : { producer: request.producer }),
          sort: request.sort,
          limit: request.limit,
        });
        if (generation.current !== currentGeneration) return;
        const selected = selectReports(descriptor, rows);
        setLastChecked(new Date().toISOString());
        setOutcome(selected);
        setLoading(false);
        if (selected.latestEntry) await openReport(selected.latestEntry, currentGeneration);
      } catch (cause) {
        if (generation.current !== currentGeneration) return;
        setError(reason(cause));
        setLoading(false);
      }
    })();
    return () => { ++generation.current; ++viewerRequest.current; };
  }, [active, descriptor, openReport, refreshKey]);

  const failed = Boolean(error || viewer?.error || outcome?.state === 'error');
  const state = failed ? 'error' : loading ? 'loading' : outcome?.state === 'partial' ? 'partial'
    : outcome?.state === 'empty' ? 'empty' : viewer?.loading ? 'loading' : 'ready';
  const reportError = useCallback((cause: unknown) => {
    setViewer((current) => current ? { ...current, body: null, error: reason(cause) } : current);
  }, []);

  return (
    <View style={styles.card} testID={`dashboard-board-${board.id}`} accessibilityValue={{ text: state }}>
      <Text style={styles.title}>{board.name}</Text>
      {board.description ? <Text style={styles.muted}>{board.description}</Text> : null}
      {loading ? <Text style={styles.muted}>Loading reports…</Text> : null}
      {error ? <Text style={styles.error} testID="dashboard-board-error">Board failed to load: {error}</Text> : null}
      {outcome?.state === 'error' ? <Text style={styles.error} testID="dashboard-board-error">{outcome.notice}</Text> : null}
      {outcome?.state === 'empty' ? <Text style={styles.muted} testID="dashboard-report-empty">No {board.name} yet (last checked {lastChecked})</Text> : null}
      {descriptor && outcome?.latestEntry ? <>
        <Text style={styles.muted}>{outcome.header}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={`${titleFor(descriptor, outcome.latestEntry)} ${outcome.latestEntry.row.asset_id}`} testID="dashboard-report-latest" onPress={() => void openReport(outcome.latestEntry!, generation.current)} style={styles.item}>
          <Text style={styles.itemTitle}>{titleFor(descriptor, outcome.latestEntry)}</Text>
          <Text style={styles.assetId}>{outcome.latestEntry.row.asset_id}</Text>
        </Pressable>
        {descriptor.list ? <View style={styles.history} testID="dashboard-report-list">
          {outcome.entries?.map((entry) => (
            <Pressable
              key={entry.key}
              accessibilityRole="button"
              accessibilityLabel={titleFor(descriptor, entry)}
              accessibilityState={{ selected: viewer?.entry.row.asset_id === entry.row.asset_id }}
              onPress={() => void openReport(entry, generation.current)}
              style={styles.item}
              testID={`dashboard-report-item-${entry.row.asset_id}`}
            >
              <Text style={styles.itemTitle}>{titleFor(descriptor, entry)}</Text>
            </Pressable>
          ))}
        </View> : null}
        {outcome.truncated ? <Text style={styles.muted} testID="dashboard-report-truncated">{outcome.notice}</Text> : null}
        {viewer ? <View style={styles.viewer} testID="dashboard-report-viewer">
          <Text style={styles.sectionTitle}>{titleFor(descriptor, viewer.entry)}</Text>
          {viewer.loading ? <Text style={styles.muted}>Loading report…</Text> : null}
          {viewer.error ? <Text style={styles.error} testID="dashboard-board-error">Board failed to load: {viewer.error}</Text> : null}
          {viewer.body ? <BodyBoundary key={viewer.request} onError={reportError}><Body body={viewer.body} /></BodyBoundary> : null}
        </View> : null}
      </> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: Tokens.palette.panel, borderColor: Tokens.palette.line, borderRadius: 8, borderWidth: 1, gap: 12, padding: 16 },
  title: { color: Tokens.palette.text, fontFamily: Fonts.rajdhani.semiBold, fontSize: 22 },
  muted: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 11 },
  error: { color: '#ff8b7c', fontFamily: Fonts.jetBrainsMono.regular, fontSize: 12 },
  item: { borderColor: Tokens.palette.line, borderRadius: 6, borderWidth: 1, gap: 6, padding: 10 },
  itemTitle: { color: Tokens.palette.text, fontFamily: Fonts.rajdhani.semiBold, fontSize: 17 },
  assetId: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 10 },
  history: { gap: 6 },
  viewer: { borderColor: Tokens.palette.line, borderTopWidth: 1, gap: 12, paddingTop: 12 },
  section: { gap: 10 },
  sectionTitle: { color: Tokens.palette.text, fontFamily: Fonts.rajdhani.semiBold, fontSize: 18 },
});
