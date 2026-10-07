// README § 9 list detail (`ListDetail2`): priority-then-order rows, 5 s check/undo, ✕ removes now,
// add row. Every row is a Cosmo list item; nothing is stored here.
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Fonts } from '../../../constants/Colors';
import { CHECK_WINDOW_MS, useHouseholdStore } from '../../services/household/householdStore';
import { LIST_META, itemTags, showItemLamp, sortItems } from '../../services/household/selectors';
import type { ListId } from '../../services/household/types';
import { CheckBox, ItemTags, P, StatusLines, styles as base, useHouseholdRefresh } from './parts';

/** Re-render while checks are pending so the countdown and progress bar move. */
function useTicker(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setTick((n) => n + 1), 200);
    return () => clearInterval(id);
  }, [active]);
}

export default function ListDetail({ listId }: { listId: ListId }) {
  const insets = useSafeAreaInsets();
  const { snapshot, pending, hiddenItems, checkItem, removeItem, addItem } = useHouseholdStore();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  useHouseholdRefresh();

  const meta = LIST_META[listId];
  const items = snapshot ? sortItems(snapshot.lists[listId] ?? []).filter((item) => !hiddenItems[item.id]) : [];
  const anyPending = items.some((item) => pending[item.id] !== undefined);
  useTicker(anyPending);
  const open = items.filter((item) => pending[item.id] === undefined).length;

  const submit = async () => {
    if (busy || !draft.trim()) return;
    setBusy(true);
    const outcome = await addItem(listId, draft);
    setBusy(false);
    if (outcome === 'ok' || outcome === 'saved') setDraft('');
  };

  return (
    <View style={base.screen}>
      <View style={[styles.header, { paddingTop: insets.top + 4 }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Lists" onPress={() => router.back()} hitSlop={8}>
          <Text style={styles.back}>‹</Text>
        </Pressable>
        <Text style={styles.name}>{meta.name}</Text>
        <Text style={styles.openCount}>{`${open} OPEN`}</Text>
      </View>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <StatusLines />
        {snapshot && items.length === 0 ? <Text style={styles.empty}>All clear</Text> : null}
        {snapshot
          ? items.map((item) => {
              const deadline = pending[item.id];
              const isPending = deadline !== undefined;
              const left = isPending ? Math.max(0, deadline - Date.now()) : 0;
              return (
                <View key={item.id} testID="list-item-row" style={[styles.row, base.rowLine]}>
                  <CheckBox testID="list-item-check" checked={isPending} onPress={() => checkItem(item.id)} />
                  <View style={[styles.flex, isPending && styles.pendingText]}>
                    <Text
                      onPress={() => checkItem(item.id)}
                      style={[styles.label, isPending && styles.struck]}
                    >
                      {item.label}
                    </Text>
                    {isPending ? null : (
                      <ItemTags testID="list-item-tag" tags={itemTags(item, snapshot.today)} lamp={showItemLamp(item)} />
                    )}
                  </View>
                  {isPending ? (
                    <Pressable testID="list-item-undo" onPress={() => checkItem(item.id)} style={styles.undo}>
                      <Text style={styles.undoText}>{`UNDO · ${Math.ceil(left / 1000)}s`}</Text>
                    </Pressable>
                  ) : (
                    <Pressable
                      testID="list-item-remove"
                      accessibilityLabel="Remove"
                      onPress={() => void removeItem(item.id)}
                      hitSlop={6}
                      style={styles.remove}
                    >
                      <Text style={styles.removeText}>✕</Text>
                    </Pressable>
                  )}
                  {isPending ? (
                    <View style={[styles.progress, { width: `${(left / CHECK_WINDOW_MS) * 100}%` }]} />
                  ) : null}
                </View>
              );
            })
          : null}
        <View style={styles.addRow}>
          <View style={styles.addBox}>
            <Text style={styles.addPlus}>+</Text>
          </View>
          <TextInput
            testID="list-add-input"
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={() => void submit()}
            placeholder={meta.placeholder}
            placeholderTextColor={P.muted}
            returnKeyType="done"
            style={styles.input}
          />
          {draft.trim() ? (
            <Pressable
              testID="list-add-button"
              accessibilityRole="button"
              disabled={busy}
              accessibilityState={{ disabled: busy }}
              onPress={() => void submit()}
              style={[styles.addButton, busy && styles.addButtonBusy]}
            >
              <Text style={styles.addButtonText}>Add</Text>
            </Pressable>
          ) : null}
        </View>
        <Text style={styles.footer}>CHECKED ITEMS LEAVE AFTER 5s · ✕ REMOVES NOW</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 10,
    paddingRight: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: P.line,
  },
  back: { color: P.text, fontSize: 26, fontFamily: Fonts.rajdhani.medium, paddingHorizontal: 6, lineHeight: 28 },
  name: { flex: 1, fontFamily: Fonts.rajdhani.bold, fontSize: 22, color: P.text },
  openCount: { fontFamily: Fonts.jetBrainsMono.regular, fontSize: 10, letterSpacing: 1, color: P.muted },
  body: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 20 },
  empty: { fontFamily: Fonts.rajdhani.medium, fontSize: 16, color: P.muted, textAlign: 'center', paddingVertical: 24 },
  row: { position: 'relative', flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13 },
  label: { fontFamily: Fonts.rajdhani.medium, fontSize: 16.5, color: P.text },
  pendingText: { opacity: 0.5 },
  struck: { textDecorationLine: 'line-through' },
  undo: { borderWidth: 1, borderColor: P.green, borderRadius: 4, paddingVertical: 5, paddingHorizontal: 8 },
  undoText: { color: P.green, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 10, letterSpacing: 1 },
  remove: { padding: 6 },
  removeText: { color: P.muted, fontSize: 14 },
  progress: { position: 'absolute', left: 0, bottom: -1, height: 2, backgroundColor: P.green },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  addBox: {
    width: 24,
    height: 24,
    borderRadius: 4,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: P.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addPlus: { color: P.muted, fontSize: 16, lineHeight: 18 },
  input: { flex: 1, minWidth: 0, color: P.text, fontFamily: Fonts.rajdhani.medium, fontSize: 16.5, padding: 0 },
  addButton: { backgroundColor: P.green, borderRadius: 4, paddingVertical: 6, paddingHorizontal: 12 },
  addButtonBusy: { opacity: 0.4 },
  addButtonText: { color: P.ink, fontFamily: Fonts.rajdhani.bold, fontSize: 14 },
  footer: { fontFamily: Fonts.jetBrainsMono.regular, fontSize: 9.5, letterSpacing: 1, color: P.muted, marginTop: 10 },
});
