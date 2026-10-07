// README § 9 Lists index (`ListsTab`): five fixed Cosmo lists; no "New list" (deviation D1).
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Fonts } from '../../../constants/Colors';
import { useHouseholdStore } from '../../services/household/householdStore';
import { LIST_META, LIST_ORDER, sortItems } from '../../services/household/selectors';
import { P, StatusLines, TabHeader, styles as base, useHouseholdRefresh } from './parts';

export default function ListsIndex() {
  const insets = useSafeAreaInsets();
  const { snapshot, pending, hiddenItems } = useHouseholdStore();
  useHouseholdRefresh();

  return (
    <View style={base.screen}>
      <TabHeader top={insets.top} title="Lists" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.body}>
        <StatusLines />
        {snapshot
          ? LIST_ORDER.map((id) => {
              const open = sortItems(snapshot.lists[id] ?? []).filter(
                (item) => !hiddenItems[item.id] && pending[item.id] === undefined,
              );
              const preview = open.slice(0, 3).map((item) => item.label).join(' · ') || 'Empty';
              return (
                <Pressable
                  key={id}
                  testID="lists-row"
                  accessibilityRole="button"
                  onPress={() => router.push({ pathname: '/pentacle/personal/list/[id]', params: { id } })}
                  style={[styles.row, base.rowLine]}
                >
                  <View style={styles.flex}>
                    <Text style={styles.name}>{LIST_META[id].name}</Text>
                    <Text style={styles.preview} numberOfLines={1}>{preview}</Text>
                  </View>
                  <Text style={[styles.count, { color: open.length ? P.green : P.muted }]}>{String(open.length)}</Text>
                  <Text style={styles.chevron}>{'›'}</Text>
                </Pressable>
              );
            })
          : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  body: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 20 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
  name: { fontFamily: Fonts.rajdhani.bold, fontSize: 18, color: P.text },
  preview: { fontFamily: Fonts.rajdhani.medium, fontSize: 13, color: P.muted, marginTop: 2 },
  count: { fontFamily: Fonts.jetBrainsMono.bold, fontSize: 12 },
  chevron: { color: P.muted, fontSize: 18 },
});
