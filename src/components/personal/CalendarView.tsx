// README § 8 Calendar (`CalendarTab`): month grid of the selected day's month with ‹ › paging,
// selected-day agenda, ✕ remove, new-event sheet. Days are America/Chicago (snapshot.today).
// Paging selects today in today's month and the 1st elsewhere; it is held while a change is unresolved.
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Fonts } from '../../../constants/Colors';
import { useHouseholdStore } from '../../services/household/householdStore';
import {
  MAX_MONTH, MIN_MONTH, dateIn, dayLabel, daysInMonth, eventsOn, formatTime, isBartEvent, monthName, monthOf,
  parseRouteDate, partnerName, selectionForMonth, shiftMonth, weekdayIndex, whoDisplay, yearOf,
} from '../../services/household/selectors';
import AddEventSheet from './AddEventSheet';
import { useAssistantIdentity } from '../../services/assistantIdentity';
import { Lamp, P, ROW_LINE, StatusLines, TabHeader, WhoBar, styles as base, useHouseholdRefresh } from './parts';

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export default function CalendarView({ date }: { date?: string }) {
  const assistant = useAssistantIdentity();
  const insets = useSafeAreaInsets();
  const { snapshot, hiddenEvents, removeEvent, unresolved } = useHouseholdStore();
  const routeDate = parseRouteDate(date);
  const [picked, setPicked] = useState<string | null>(null);
  // The picked (or paged-to) month, else the route month, else the daemon's default (today's month).
  const shownMonth = picked ? monthOf(picked) : routeDate ? monthOf(routeDate) : undefined;
  useHouseholdRefresh(shownMonth, true);
  const [adding, setAdding] = useState(false);

  const today = snapshot?.today;
  const selected = picked ?? routeDate ?? today;
  if (!snapshot || !selected || !today) {
    return (
      <View style={base.screen}>
        <TabHeader top={insets.top} title="Calendar" onBack={() => router.back()} />
        <View style={styles.body}>
          <StatusLines />
        </View>
      </View>
    );
  }

  const partner = partnerName(snapshot);
  const month = monthOf(selected);
  const events = snapshot.events.filter((event) => !hiddenEvents[event.id] && monthOf(event.date) === month);
  const dayEvents = eventsOn(events, selected);
  const first = weekdayIndex(dateIn(month, 1));
  const cells: Array<string | null> = [
    ...Array.from({ length: first }, () => null),
    ...Array.from({ length: daysInMonth(month) }, (_, i) => dateIn(month, i + 1)),
  ];
  while (cells.length % 7) cells.push(null);
  const weeks = Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
  const count = dayEvents.length;
  // Held while a change is unresolved so its readbacks and the screen agree on the month.
  const pagingHeld = unresolved > 0;
  const page = (n: number) => setPicked(selectionForMonth(shiftMonth(month, n), today));
  const offToday = month !== monthOf(today);

  return (
    <View style={base.screen}>
      <TabHeader
        top={insets.top}
        sub={yearOf(selected)}
        subAction={
          offToday && !pagingHeld
            ? { label: 'BACK TO TODAY', onPress: () => setPicked(today), testID: 'calendar-back-to-today' }
            : undefined
        }
        title={monthName(selected)}
        onBack={() => router.back()}
        right={
          <View style={styles.headerButtons}>
            <Pressable
              testID="calendar-prev-month"
              accessibilityRole="button"
              accessibilityLabel="Previous month"
              disabled={pagingHeld || month === MIN_MONTH}
              accessibilityState={{ disabled: pagingHeld || month === MIN_MONTH }}
              onPress={() => page(-1)}
              style={styles.pager}
            >
              <Text style={styles.pagerText}>‹</Text>
            </Pressable>
            <Pressable
              testID="calendar-next-month"
              accessibilityRole="button"
              accessibilityLabel="Next month"
              disabled={pagingHeld || month === MAX_MONTH}
              accessibilityState={{ disabled: pagingHeld || month === MAX_MONTH }}
              onPress={() => page(1)}
              style={styles.pager}
            >
              <Text style={styles.pagerText}>›</Text>
            </Pressable>
            <Pressable
              testID="calendar-new-event"
              accessibilityRole="button"
              accessibilityLabel="New event"
              onPress={() => setAdding(true)}
              style={styles.newEvent}
            >
              <Text style={styles.newEventText}>+ Event</Text>
            </Pressable>
          </View>
        }
      />
      <ScrollView contentContainerStyle={styles.body}>
        {adding ? null : <StatusLines />}
        <View style={styles.week}>
          {WEEKDAYS.map((letter, i) => (
            <Text key={i} style={styles.weekday}>{letter}</Text>
          ))}
        </View>
        <View style={styles.grid}>
          {weeks.map((week, w) => (
            <View key={w} style={styles.weekRow}>
              {week.map((day, i) => {
                if (!day) return <View key={`blank-${w}-${i}`} style={styles.cellBlank} />;
                const isToday = day === today;
                const isSelected = day === selected;
                const dots = eventsOn(events, day).slice(0, 3);
                return (
                  <Pressable
                    key={day}
                    testID={`calendar-cell-${day}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => setPicked(day)}
                    style={[
                      styles.cell,
                      {
                        borderColor: isSelected ? P.green : ROW_LINE,
                        backgroundColor: isSelected ? `${P.green}18` : 'transparent',
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.cellNumber,
                        {
                          color: isToday ? P.green : day < today ? P.muted : P.text,
                          fontFamily: isToday || isSelected ? Fonts.rajdhani.bold : Fonts.rajdhani.medium,
                        },
                      ]}
                    >
                      {String(Number(day.slice(8)))}
                    </Text>
                    <View style={styles.dots}>
                      {dots.map((event) => (
                        <View
                          key={event.id}
                          style={[styles.dot, { backgroundColor: isBartEvent(event) ? P.green : P.dim }]}
                        />
                      ))}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>
        <View style={styles.agendaHead}>
          <Text style={[base.sectionLabel, styles.flex]}>
            {`${dayLabel(selected)}${selected === today ? ' · TODAY' : ''}`}
          </Text>
          <Text style={styles.count}>{`${count} EVENT${count === 1 ? '' : 'S'}`}</Text>
        </View>
        {count === 0 ? (
          <Pressable accessibilityRole="button" onPress={() => setAdding(true)} style={styles.emptyBox}>
            <Text style={styles.emptyTitle}>Nothing scheduled</Text>
            <Text style={styles.emptyAdd}>+ ADD AN EVENT</Text>
          </Pressable>
        ) : null}
        {dayEvents.map((event) => {
          const who = whoDisplay(event, partner);
          return (
            <View key={event.id} testID="agenda-row" style={[styles.agendaRow, base.rowLine]}>
              <Text style={styles.time}>{formatTime(event.time)}</Text>
              <WhoBar bars={who.bars} height={30} />
              <View style={styles.flex}>
                <Text style={styles.title} numberOfLines={1}>{event.title}</Text>
                <View style={styles.meta}>
                  <Text style={styles.metaText}>{who.label}</Text>
                  {isBartEvent(event) ? (
                    <View style={styles.bart}>
                      <Text style={[styles.metaText, styles.bartText]}>·</Text>
                      <Lamp size={12} />
                      <Text style={[styles.metaText, styles.bartText]}>ADDED BY {assistant.name.toUpperCase()}</Text>
                    </View>
                  ) : null}
                </View>
              </View>
              <Pressable
                testID="agenda-remove"
                accessibilityLabel="Remove"
                onPress={() => void removeEvent(event.id)}
                hitSlop={6}
                style={styles.remove}
              >
                <Text style={styles.removeText}>✕</Text>
              </Pressable>
            </View>
          );
        })}
      </ScrollView>
      {adding ? <AddEventSheet day={selected} onSubmit={setPicked} onClose={() => setAdding(false)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  body: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 20 },
  headerButtons: { flexDirection: 'row', gap: 6 },
  pager: {
    height: 36,
    minWidth: 36,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: P.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pagerText: { color: P.dim, fontFamily: Fonts.rajdhani.bold, fontSize: 22 },
  newEvent: {
    height: 36,
    minWidth: 36,
    paddingHorizontal: 10,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: P.green,
    backgroundColor: P.green,
    alignItems: 'center',
    justifyContent: 'center',
  },
  newEventText: { color: P.ink, fontFamily: Fonts.rajdhani.bold, fontSize: 14 },
  week: { flexDirection: 'row' },
  weekday: {
    flex: 1,
    textAlign: 'center',
    fontFamily: Fonts.jetBrainsMono.regular,
    fontSize: 9.5,
    letterSpacing: 1,
    color: P.muted,
  },
  grid: { marginTop: 6, gap: 3 },
  weekRow: { flexDirection: 'row', gap: 3 },
  cell: {
    flex: 1,
    height: 42,
    borderRadius: 4,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  cellBlank: { flex: 1, height: 42 },
  cellNumber: { fontSize: 15 },
  dots: { flexDirection: 'row', gap: 2, height: 4 },
  dot: { width: 4, height: 4, borderRadius: 2 },
  agendaHead: { flexDirection: 'row', alignItems: 'center', marginTop: 20, marginBottom: 4 },
  count: { fontFamily: Fonts.jetBrainsMono.regular, fontSize: 10, color: P.muted },
  emptyBox: {
    paddingVertical: 18,
    paddingHorizontal: 14,
    borderRadius: 4,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: P.line,
    alignItems: 'center',
    gap: 4,
  },
  emptyTitle: { fontFamily: Fonts.rajdhani.medium, fontSize: 16, color: P.muted },
  emptyAdd: { fontFamily: Fonts.jetBrainsMono.regular, fontSize: 9.5, letterSpacing: 1.2, color: P.green },
  agendaRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11 },
  time: { width: 44, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 11, color: P.dim },
  title: { fontFamily: Fonts.rajdhani.semiBold, fontSize: 16, color: P.text },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  metaText: { fontFamily: Fonts.jetBrainsMono.regular, fontSize: 9, letterSpacing: 1, color: P.muted },
  bart: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  bartText: { color: P.green },
  remove: { padding: 6 },
  removeText: { color: P.muted, fontSize: 14 },
});
