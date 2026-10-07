// /pentacle/personal/calendar?date=YYYY-MM-DD — America/Chicago day; invalid or out-of-range
// dates fall back to today inside CalendarView (spec B5).
import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import CalendarView from '../../../src/components/personal/CalendarView';

export default function CalendarRoute() {
  const { date } = useLocalSearchParams<{ date?: string }>();
  return <CalendarView date={typeof date === 'string' ? date : undefined} />;
}
