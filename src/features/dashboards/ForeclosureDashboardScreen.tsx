import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { Fonts, Tokens } from '../../../constants/Colors';
import { DashboardHeader, Panel, StageFlow, StalenessBadge, record, rows, text } from './DashboardUi';
import type { DashboardGate, DashboardGateMutation, DashboardGateResult, DashboardSnapshot } from './types';

type Props = {
  snapshot: DashboardSnapshot | null;
  onSelectBatch: (batch: string) => void;
  onMutateGate: (mutation: DashboardGateMutation) => Promise<DashboardGateResult>;
};

type OptimisticGate = { batch: string; gate: DashboardGate; expiresAt: number };

function gateFromSnapshot(snapshot: DashboardSnapshot | null): DashboardGate | null {
  const gate = record(snapshot?.pipeline_summary).skiptrace_gate;
  return gate === 'open' || gate === 'closed' ? gate : null;
}

function batchFromSnapshot(snapshot: DashboardSnapshot | null) {
  const summary = record(snapshot?.pipeline_summary);
  return text(summary.state_machine_batch || snapshot?.batch, '').trim();
}

export default function ForeclosureDashboardScreen({ snapshot, onSelectBatch, onMutateGate }: Props) {
  const batches = useMemo(
    () => Array.isArray(snapshot?.all_batches) ? snapshot.all_batches.map((value) => text(value, '')).filter(Boolean) : [],
    [snapshot?.all_batches],
  );
  const snapshotBatch = batchFromSnapshot(snapshot);
  const [selectedBatch, setSelectedBatch] = useState('');
  const [optimistic, setOptimistic] = useState<OptimisticGate | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!selectedBatch && snapshotBatch) setSelectedBatch(snapshotBatch);
  }, [selectedBatch, snapshotBatch]);

  const incomingGate = gateFromSnapshot(snapshot);
  useEffect(() => {
    if (optimistic && incomingGate === optimistic.gate && (!selectedBatch || optimistic.batch === selectedBatch)) {
      setOptimistic(null);
    }
  }, [incomingGate, optimistic, selectedBatch]);

  const currentBatch = selectedBatch || snapshotBatch;
  const batchReady = !!currentBatch && snapshotBatch === currentBatch && !snapshot?._missing_batch;
  const effectiveGate = batchReady
    ? optimistic && optimistic.batch === currentBatch && optimistic.expiresAt > Date.now()
      ? optimistic.gate
      : incomingGate
    : null;

  const chooseBatch = useCallback((batch: string) => {
    setSelectedBatch(batch);
    setOptimistic(null);
    setError('');
    onSelectBatch(batch);
  }, [onSelectBatch]);

  const submitGate = useCallback(async (gate: DashboardGate) => {
    if (!currentBatch || pending) return;
    setPending(true);
    setError('');
    const result = await onMutateGate({
      batch: currentBatch,
      gate,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOptimistic(result.changed
      ? { batch: result.batch, gate: result.gate, expiresAt: Date.now() + 30000 }
      : null);
  }, [currentBatch, onMutateGate, pending]);

  const changeGate = useCallback((open: boolean) => {
    const next: DashboardGate = open ? 'open' : 'closed';
    if (next === 'open' && effectiveGate === 'closed') {
      Alert.alert(
        'Reopen skip-trace gate?',
        `This releases qualified records for ${currentBatch}.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Reopen', onPress: () => void submitGate('open') },
        ],
      );
      return;
    }
    void submitGate(next);
  }, [currentBatch, effectiveGate, submitGate]);

  const summary = record(snapshot?.pipeline_summary);
  const stages = rows(snapshot?.pipeline_stages).map((stage) => ({ ...stage, label: stage.label || stage.stage }));

  return (
    <View testID="foreclosure-dashboard-screen">
      <DashboardHeader title="Foreclosure Pipeline" subtitle="Scraping, qualification, and skip-trace progression." />
      <StalenessBadge snapshot={snapshot} />
      <Panel title="Batch controls" testID="foreclosure-controls">
        <Text style={styles.controlLabel}>BATCH</Text>
        <ScrollView horizontal contentContainerStyle={styles.batchRow} testID="foreclosure-batch-selector">
          {(batches.length ? batches : currentBatch ? [currentBatch] : []).map((batch) => {
            const selected = batch === currentBatch;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected }}
                key={batch}
                onPress={() => chooseBatch(batch)}
                style={[styles.batchButton, selected && styles.batchButtonSelected]}
                testID={`foreclosure-batch-${batch.replace(/[^a-zA-Z0-9-]/g, '-')}`}
              >
                <Text style={[styles.batchText, selected && styles.batchTextSelected]}>{batch}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
        <Pressable
          accessibilityLabel="Skip-trace gate"
          accessibilityRole="switch"
          accessibilityState={{ checked: effectiveGate === 'open', disabled: !batchReady || !effectiveGate || pending }}
          disabled={!batchReady || !effectiveGate || pending}
          onPress={() => changeGate(effectiveGate !== 'open')}
          style={styles.gateRow}
          testID="foreclosure-gate-control"
        >
          <View style={styles.gateCopy}>
            <Text style={styles.gateTitle}>Skip-trace gate</Text>
            <Text
              accessibilityLabel={`Gate state ${pending ? 'updating' : effectiveGate || 'unknown'}`}
              style={styles.gateState}
              testID="foreclosure-gate-state"
            >
              {pending ? 'UPDATING' : effectiveGate ? effectiveGate.toUpperCase() : 'UNKNOWN'}
            </Text>
          </View>
          <Switch
            accessible={false}
            accessibilityState={{ disabled: !batchReady || !effectiveGate || pending }}
            disabled={!batchReady || !effectiveGate || pending}
            onValueChange={changeGate}
            pointerEvents="none"
            testID="foreclosure-gate-toggle"
            thumbColor={effectiveGate === 'open' ? Tokens.palette.green : Tokens.palette.muted}
            trackColor={{ false: Tokens.palette.line, true: 'rgba(61,255,102,0.35)' }}
            value={effectiveGate === 'open'}
          />
        </Pressable>
        {error ? <Text style={styles.error} testID="foreclosure-gate-error">{error}</Text> : null}
      </Panel>
      <Panel title="Pipeline summary">
        <View style={styles.summaryRow}>
          <Text style={styles.summaryPrimary} testID="foreclosure-summary-stage">{batchReady ? text(summary.current_stage, 'Waiting') : 'Switching batch…'}</Text>
          <Text style={styles.summarySecondary}>{batchReady ? text(summary.current_state, 'No state') : currentBatch}</Text>
        </View>
      </Panel>
      <Panel title="Stage flow" testID="foreclosure-stage-panel">
        <StageFlow stages={batchReady ? stages : []} />
      </Panel>
    </View>
  );
}

const styles = StyleSheet.create({
  controlLabel: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 9, letterSpacing: 0.8 },
  batchRow: { gap: 8, paddingBottom: 2 },
  batchButton: { backgroundColor: Tokens.palette.codePanel, borderColor: Tokens.palette.line, borderRadius: 999, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  batchButtonSelected: { borderColor: Tokens.palette.green },
  batchText: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 11 },
  batchTextSelected: { color: Tokens.palette.text, fontFamily: Fonts.jetBrainsMono.bold },
  gateRow: { alignItems: 'center', borderTopColor: Tokens.palette.line, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', paddingTop: 11 },
  gateCopy: { gap: 3 },
  gateTitle: { color: Tokens.palette.text, fontFamily: Fonts.rajdhani.medium, fontSize: 14 },
  gateState: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 9, letterSpacing: 0.8 },
  error: { color: Tokens.palette.red, fontFamily: Fonts.rajdhani.medium, fontSize: 12 },
  summaryRow: { alignItems: 'baseline', flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  summaryPrimary: { color: Tokens.palette.text, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 16 },
  summarySecondary: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 11 },
});
