import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Fonts, MACHINE_ORDER, MACHINES, Tokens, type MachineName, type ProviderName } from '@/constants/Colors';
import ArcaneRingFrame from './ArcaneRingFrame';
import ProviderTag from './ProviderTag';
import { modelDisplayName } from '../services/modelDisplay';
import type { SpawnCatalog, SpawnProvider } from '../services/pentacleStream';
import { getHostMachineName } from '../config/local';

export type SummonMachine = {
  host: string;
  title: string;
  online: boolean;
};

type Props = {
  visible: boolean;
  machines: SummonMachine[];
  catalog: SpawnCatalog | null;
  catalogLoading: boolean;
  catalogError: string | null;
  submitting: boolean;
  submitError: string | null;
  onClose: () => void;
  onRetryCatalog: () => void;
  // Resolves when the parent's attempt has settled, which is what releases the sheet's own
  // pending state — inferring that from prop changes is unreliable when the parent batches
  // `submitting` true and false into one commit, and a missed release wedges the button.
  onPick: (host: string, selection: {
    provider: SpawnProvider;
    model: string;
    effort: string;
    resolutionSource: 'profile_default' | 'explicit_override';
  }) => void | Promise<void>;
};

export default function SummonModal({
  visible,
  machines,
  catalog,
  catalogLoading,
  catalogError,
  submitting,
  submitError,
  onClose,
  onRetryCatalog,
  onPick,
}: Props) {
  const [selected, setSelected] = useState<SummonMachine | null>(null);
  const [provider, setProvider] = useState<SpawnProvider>('codex');
  const [byProvider, setByProvider] = useState<Partial<Record<SpawnProvider, { model: string; effort: string }>>>({});
  // The sheet owns its own pending state. Routing the pending paint through the parent's
  // `submitting` prop means it lands only after the chats screen commits, and that commit is slow
  // enough on a loaded list to read as a freeze — the dead window in which the operator's extra
  // taps each queued another chat. The ref blocks the queued taps in the same frame; the state
  // repaints this small subtree without waiting on the parent.
  // public_behavior_spec.
  const submittedRef = useRef(false);
  const [localSubmitting, setLocalSubmitting] = useState(false);
  const pending = submitting || localSubmitting;

  const releasePending = () => {
    submittedRef.current = false;
    setLocalSubmitting(false);
  };

  useEffect(() => {
    if (!visible) {
      setSelected(null);
      setProvider('codex');
      setByProvider({});
      releasePending();
    }
  }, [visible]);

  // The parent finished the attempt (success closes the sheet; failure surfaces submitError and
  // must leave the button retryable).
  useEffect(() => {
    if (!submitting) releasePending();
  }, [submitting]);

  useEffect(() => {
    if (!visible || !catalog) return;
    const profile = catalog.profiles.desktop_manual || {};
    setByProvider((current) => Object.keys(current).length > 0 ? current : ({
      ...(profile.claude ? { claude: { model: profile.claude[0], effort: profile.claude[1] } } : {}),
      ...(profile.codex ? { codex: { model: profile.codex[0], effort: profile.codex[1] } } : {}),
    }));
    setProvider(profile.codex ? 'codex' : 'claude');
  }, [catalog, visible]);

  const grid = useMemo(
    () =>
      machines.map((machine) => {
        const name = getHostMachineName(machine.host);
        return { name, machine, meta: MACHINES[name] };
      }),
    [machines],
  );

  const selectedName = selected ? getHostMachineName(selected.host) : undefined;
  const selectedMeta = selectedName ? MACHINES[selectedName] : MACHINES[MACHINE_ORDER[0]];
  const profileDefault = catalog?.profiles.desktop_manual?.[provider];
  const selection = byProvider[provider] || (profileDefault ? { model: profileDefault[0], effort: profileDefault[1] } : null);
  const models = catalog ? Object.entries(catalog.models[provider] || {}) : [];
  const efforts = selection ? (catalog?.models[provider]?.[selection.model]?.efforts || []) : [];
  const canSubmit = Boolean(
    selected &&
    selection &&
    !pending &&
    !catalogLoading &&
    catalog &&
    !catalogError &&
    models.some(([model]) => model === selection.model) &&
    efforts.includes(selection.effort),
  );

  const chooseModel = (model: string) => {
    const allowed = catalog?.models[provider]?.[model]?.efforts || [];
    const fallback = catalog?.profiles.desktop_manual?.[provider]?.[1] || allowed[0] || '';
    setByProvider((current) => ({
      ...current,
      [provider]: { model, effort: allowed.includes(selection?.effort || '') ? selection!.effort : fallback },
    }));
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(event) => event?.stopPropagation?.()}>
          <View style={styles.handle} />
          <Text style={styles.title}>{selected ? 'Configure agent' : 'Summon'}</Text>

          {!selected ? (
            <View style={styles.grid}>
              {grid.map(({ name, machine, meta }) => {
                const enabled = Boolean(machine?.online);
                return (
                  <Pressable
                    key={machine.host}
                    testID={`summon-machine-${machine.host}`}
                    disabled={!enabled}
                    onPress={() => machine && setSelected(machine)}
                    style={[
                      styles.machineCard,
                      {
                        borderColor: `${meta.accent}${enabled ? '55' : '22'}`,
                        backgroundColor: `${meta.accent}${enabled ? '12' : '08'}`,
                        opacity: enabled ? 1 : 0.42,
                      },
                    ]}
                  >
                    <ArcaneRingFrame machine={name} size={58} sigilSize={36} />
                    <Text style={styles.machineName}>{machine.title}</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.providerStack}>
              <Text style={styles.sectionLabel}>Provider</Text>
              <View style={styles.choiceRow}>
              {(['claude', 'codex'] as const).map((candidate) => (
                <Pressable
                  key={candidate}
                  testID={`summon-provider-${candidate}`}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: provider === candidate, disabled: pending }}
                  disabled={pending}
                  style={[styles.providerRow, provider === candidate && styles.choiceSelected]}
                  onPress={() => setProvider(candidate)}
                >
                  <ProviderTag provider={candidate as Extract<ProviderName, 'claude' | 'codex'>} color={Tokens.palette.green} />
                  <Text style={styles.providerName}>{candidate === 'claude' ? 'Claude' : 'Codex'}</Text>
                </Pressable>
              ))}
              </View>

              {catalogLoading ? <ActivityIndicator testID="summon-catalog-loading" color={Tokens.palette.green} /> : null}
              {catalogError ? (
                <View style={styles.errorBox}>
                  <Text testID="summon-catalog-error" style={styles.errorText}>{catalogError}</Text>
                  <Pressable testID="summon-catalog-retry" onPress={onRetryCatalog}><Text style={styles.retryText}>Retry catalog</Text></Pressable>
                </View>
              ) : null}

              {catalog && selection ? (
                <>
                  <Text style={styles.sectionLabel}>Model</Text>
                  <View style={styles.choiceWrap}>
                    {models.map(([model]) => (
                      <Pressable
                        key={model}
                        testID={`summon-model-${model}`}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: selection.model === model, disabled: pending }}
                        disabled={pending}
                        onPress={() => chooseModel(model)}
                        style={[styles.choiceChip, selection.model === model && styles.choiceSelected]}
                      ><Text style={styles.choiceText}>{modelDisplayName(model)}</Text></Pressable>
                    ))}
                  </View>
                  <Text style={styles.sectionLabel}>Effort</Text>
                  <View style={styles.choiceWrap}>
                    {efforts.map((effort) => (
                      <Pressable
                        key={effort}
                        testID={`summon-effort-${effort}`}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: selection.effort === effort, disabled: pending }}
                        disabled={pending}
                        onPress={() => setByProvider((current) => ({
                          ...current,
                          [provider]: { ...(current[provider] || selection), effort },
                        }))}
                        style={[styles.choiceChip, selection.effort === effort && styles.choiceSelected]}
                      ><Text style={styles.choiceText}>{effort.toUpperCase()}</Text></Pressable>
                    ))}
                  </View>
                </>
              ) : null}

              {submitError ? <Text testID="summon-submit-error" style={styles.errorText}>{submitError}</Text> : null}
              <Pressable
                testID="summon-submit"
                accessibilityRole="button"
                accessibilityState={{ disabled: !canSubmit }}
                disabled={!canSubmit}
                style={[styles.submitButton, !canSubmit && styles.submitDisabled]}
                onPress={() => {
                  if (submittedRef.current || !selection) return;
                  submittedRef.current = true;
                  setLocalSubmitting(true);
                  void Promise.resolve(onPick(selected.host, {
                    provider,
                    model: selection.model,
                    effort: selection.effort,
                    resolutionSource: profileDefault && profileDefault[0] === selection.model && profileDefault[1] === selection.effort
                      ? 'profile_default'
                      : 'explicit_override',
                  })).catch(() => undefined).then(releasePending);
                }}
              ><Text style={styles.submitText}>{pending ? 'Starting…' : 'Start agent'}</Text></Pressable>
              <Pressable style={styles.backButton} disabled={pending} onPress={() => { releasePending(); setSelected(null); }}>
                <Text style={[styles.backText, { color: selectedMeta.accent }]}>‹ back</Text>
              </Pressable>
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: Tokens.palette.backdrop,
  },
  sheet: {
    width: '100%',
    backgroundColor: Tokens.palette.panel,
    borderTopWidth: 1,
    borderTopColor: Tokens.palette.line,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 32,
  },
  handle: {
    width: 42,
    height: 4,
    borderRadius: 999,
    backgroundColor: Tokens.palette.line,
    alignSelf: 'center',
    marginBottom: 16,
  },
  title: {
    fontFamily: Fonts.cinzel.semiBold,
    fontSize: 19,
    color: Tokens.palette.text,
    textAlign: 'center',
    marginBottom: 18,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  machineCard: {
    width: '47.8%',
    alignItems: 'center',
    gap: 9,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 16,
    paddingHorizontal: 8,
  },
  machineName: {
    fontFamily: Fonts.rajdhani.bold,
    fontSize: 15,
    color: Tokens.palette.text,
  },
  providerStack: {
    gap: 12,
  },
  sectionLabel: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.medium, fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase' },
  choiceRow: { flexDirection: 'row', gap: 10 },
  choiceWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 },
  providerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderRadius: 8,
    backgroundColor: `${Tokens.palette.green}12`,
    padding: 16,
    flex: 1,
  },
  providerName: {
    fontFamily: Fonts.rajdhani.bold,
    fontSize: 17,
    color: Tokens.palette.text,
  },
  choiceChip: { borderWidth: 1, borderColor: Tokens.palette.line, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  choiceSelected: { borderColor: Tokens.palette.green, backgroundColor: `${Tokens.palette.green}18` },
  choiceText: { color: Tokens.palette.text, fontFamily: Fonts.rajdhani.semiBold, fontSize: 14 },
  submitButton: { alignItems: 'center', borderRadius: 8, backgroundColor: Tokens.palette.green, paddingVertical: 13 },
  submitDisabled: { opacity: 0.42 },
  submitText: { color: Tokens.palette.ink, fontFamily: Fonts.rajdhani.bold, fontSize: 16 },
  errorBox: { gap: 8 },
  errorText: { color: Tokens.palette.amber, fontFamily: Fonts.rajdhani.medium, fontSize: 14 },
  retryText: { color: Tokens.palette.green, fontFamily: Fonts.jetBrainsMono.medium, fontSize: 11 },
  backButton: {
    alignItems: 'center',
    marginTop: 2,
    paddingVertical: 4,
  },
  backText: {
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 12,
  },
});

