// New-event date picker (`PcMiniCal`): an inline month grid with its own ‹ › paging. Paging only
// changes what the picker shows; nothing is fetched until the event is saved.
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Fonts } from '../../../constants/Colors';
import {
  MAX_MONTH, MIN_MONTH, dateIn, daysInMonth, monthName, monthOf, shiftMonth, weekdayIndex, yearOf,
} from '../../services/household/selectors';
import { P } from './parts';

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export default function MiniCalendar({
  value,
  today,
  onPick,
}: {
  value: string;
  today: string;
  onPick: (date: string) => void;
}) {
  const [month, setMonth] = useState(monthOf(value));
  const first = weekdayIndex(dateIn(month, 1));
  const cells: Array<string | null> = [
    ...Array.from({ length: first }, () => null),
    ...Array.from({ length: daysInMonth(month) }, (_, i) => dateIn(month, i + 1)),
  ];
  while (cells.length % 7) cells.push(null);
  const weeks = Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
  const firstDay = dateIn(month, 1);

  return (
    <View testID="mini-calendar" style={styles.box}>
      <View style={styles.head}>
        <Pressable
          testID="mini-calendar-prev"
          accessibilityRole="button"
          accessibilityLabel="Previous month"
          disabled={month === MIN_MONTH}
          onPress={() => setMonth(shiftMonth(month, -1))}
          style={styles.nav}
        >
          <Text style={styles.navText}>‹</Text>
        </Pressable>
        <Text testID="mini-calendar-title" style={styles.title}>{`${monthName(firstDay)} ${yearOf(firstDay)}`}</Text>
        <Pressable
          testID="mini-calendar-next"
          accessibilityRole="button"
          accessibilityLabel="Next month"
          disabled={month === MAX_MONTH}
          onPress={() => setMonth(shiftMonth(month, 1))}
          style={styles.nav}
        >
          <Text style={styles.navText}>›</Text>
        </Pressable>
      </View>
      <View style={styles.row}>
        {WEEKDAYS.map((letter, i) => (
          <Text key={i} style={styles.weekday}>{letter}</Text>
        ))}
      </View>
      {weeks.map((week, w) => (
        <View key={w} style={styles.row}>
          {week.map((day, i) => {
            if (!day) return <View key={`blank-${w}-${i}`} style={styles.cell} />;
            const picked = day === value;
            const isToday = day === today;
            return (
              <Pressable
                key={day}
                testID={`mini-calendar-day-${day}`}
                accessibilityRole="button"
                accessibilityState={{ selected: picked }}
                onPress={() => onPick(day)}
                style={[styles.cell, styles.day, picked && styles.picked]}
              >
                <Text
                  style={[
                    styles.dayText,
                    {
                      color: picked ? P.ink : isToday ? P.green : P.text,
                      fontFamily: picked || isToday ? Fonts.rajdhani.bold : Fonts.rajdhani.medium,
                    },
                  ]}
                >
                  {String(Number(day.slice(8)))}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: P.ink, borderWidth: 1, borderColor: P.line, borderRadius: 4, padding: 10, gap: 2 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  nav: {
    width: 36,
    height: 32,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: P.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navText: { color: P.text, fontFamily: Fonts.rajdhani.medium, fontSize: 20 },
  title: { flex: 1, textAlign: 'center', color: P.text, fontFamily: Fonts.rajdhani.bold, fontSize: 16 },
  row: { flexDirection: 'row', gap: 2 },
  weekday: {
    flex: 1,
    textAlign: 'center',
    fontFamily: Fonts.jetBrainsMono.regular,
    fontSize: 9,
    color: P.muted,
    paddingBottom: 4,
  },
  cell: { flex: 1, height: 32 },
  day: { borderRadius: 4, borderWidth: 1, borderColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  picked: { backgroundColor: P.green, borderColor: P.green },
  dayText: { fontSize: 14 },
});
