// README § 7 Personal tab (`PersonalHome`): TO-DO (critical items across lists), TODAY, UPCOMING.
import React, { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Fonts } from '../../../constants/Colors';
import { useHouseholdStore } from '../../services/household/householdStore';
import {
  LIST_META, criticalItems, partnerName, dayLabel, formatTime, isBartEvent, itemTags, personalHeaderLabel,
  showItemLamp, todayEvents, upcomingEvents, whoDisplay,
} from '../../services/household/selectors';
import type { HouseholdEvent } from '../../services/household/types';
import { CheckBox, ItemTags, Lamp, P, StatusLines, TabHeader, WhoBar, styles as base, useHouseholdRefresh } from './parts';

function Section({ label, link, onLink, children }: {
  label: string; link?: string; onLink?: () => void; children: React.ReactNode;
}) {
  return (
    <View>
      <View style={styles.sectionHead}>
        <Text style={[base.sectionLabel, styles.flex]}>{label}</Text>
        {link ? (
          <Pressable accessibilityRole="link" onPress={onLink} hitSlop={6}>
            <Text style={styles.link}>{`${link} ›`}</Text>
          </Pressable>
        ) : null}
      </View>
      {children}
    </View>
  );
}

function EventRow({ event, showDay, testID, partner }: {
  event: HouseholdEvent; showDay?: boolean; testID: string; partner: string;
}) {
  const who = whoDisplay(event, partner);
  return (
    <View testID={testID} style={[styles.eventRow, base.rowLine]}>
      <View style={styles.timeCol}>
        {showDay ? <Text style={styles.dayLabel}>{dayLabel(event.date)}</Text> : null}
        <Text style={styles.time}>{formatTime(event.time)}</Text>
      </View>
      <WhoBar bars={who.bars} height={showDay ? 28 : 22} />
      <View style={styles.flex}>
        <Text style={styles.eventTitle} numberOfLines={1}>{event.title}</Text>
        <Text style={styles.whoLabel}>{who.label}</Text>
      </View>
      {isBartEvent(event) ? <Lamp size={16} /> : null}
    </View>
  );
}

export default function PersonalHome() {
  const insets = useSafeAreaInsets();
  const state = useHouseholdStore();
  const [refreshing, setRefreshing] = useState(false);
  useHouseholdRefresh();
  const { snapshot, pending, hiddenItems, checkItem } = state;

  const critical = useMemo(
    () => (snapshot ? criticalItems(snapshot).filter(({ item }) => !hiddenItems[item.id]) : []),
    [snapshot, hiddenItems],
  );
  const partner = partnerName(snapshot);
  const today = snapshot ? todayEvents(snapshot) : [];
  const upcoming = snapshot ? upcomingEvents(snapshot) : [];

  const onRefresh = async () => {
    setRefreshing(true);
    await useHouseholdStore.getState().refresh();
    setRefreshing(false);
  };

  return (
    <View style={base.screen}>
      <TabHeader top={insets.top} sub={snapshot ? personalHeaderLabel(snapshot.today) : undefined} title="Personal" />
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={P.green} />}
      >
        <StatusLines />
        {snapshot ? (
          <>
            <Section label={`TO-DO · ${critical.length}`} link="Lists" onLink={() => router.push('/pentacle/personal/lists')}>
              {critical.map(({ list, item }) => {
                const isPending = pending[item.id] !== undefined;
                return (
                  <View key={item.id} testID="personal-todo-row" style={[styles.todoRow, base.rowLine]}>
                    <CheckBox testID="list-item-check" checked={isPending} onPress={() => checkItem(item.id)} />
                    <View style={[styles.flex, isPending && styles.pending]}>
                      <Text
                        numberOfLines={1}
                        style={[styles.todoTitle, isPending && styles.struck]}
                      >
                        {item.label}
                      </Text>
                      <View style={styles.todoMeta}>
                        <Text style={styles.listName}>{LIST_META[list].name.toUpperCase()}</Text>
                        <ItemTags tags={itemTags(item, snapshot.today)} lamp={showItemLamp(item)} />
                      </View>
                    </View>
                  </View>
                );
              })}
            </Section>
            <Section label={`TODAY · ${today.length}`} link="Calendar" onLink={() => router.push('/pentacle/personal/calendar')}>
              {today.length ? (
                today.map((event) => <EventRow key={event.id} event={event} partner={partner} testID="personal-today-row" />)
              ) : (
                <Text style={styles.empty}>Nothing scheduled today</Text>
              )}
            </Section>
            <Section label="UPCOMING · NEXT 7 DAYS">
              {upcoming.map((event) => (
                <EventRow key={event.id} event={event} partner={partner} showDay testID="personal-upcoming-row" />
              ))}
            </Section>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  body: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 24, gap: 24 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  link: { color: P.dim, fontFamily: Fonts.rajdhani.bold, fontSize: 13.5, padding: 2 },
  todoRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  todoTitle: { fontFamily: Fonts.rajdhani.semiBold, fontSize: 15.5, color: P.text },
  todoMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  listName: { fontFamily: Fonts.jetBrainsMono.regular, fontSize: 9, letterSpacing: 1, color: P.muted, marginTop: 2 },
  pending: { opacity: 0.5 },
  struck: { textDecorationLine: 'line-through' },
  eventRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  timeCol: { width: 52 },
  dayLabel: { fontFamily: Fonts.jetBrainsMono.regular, fontSize: 9, letterSpacing: 1, color: P.muted },
  time: { fontFamily: Fonts.jetBrainsMono.regular, fontSize: 11, color: P.dim, lineHeight: 14 },
  eventTitle: { fontFamily: Fonts.rajdhani.semiBold, fontSize: 15.5, color: P.text },
  whoLabel: { fontFamily: Fonts.jetBrainsMono.regular, fontSize: 9, letterSpacing: 1, color: P.muted, marginTop: 2 },
  empty: { fontFamily: Fonts.rajdhani.medium, fontSize: 15, color: P.muted, paddingVertical: 8 },
});
