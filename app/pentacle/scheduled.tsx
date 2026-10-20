import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Fonts, TOP_INSET, Tokens } from '@/constants/Colors';
import Starfield from '../../src/components/Starfield';
import {
  formatInZone, formatRelative, selectRecurringRows, useScheduled,
  type RecurringEdit, type RecurringRule,
} from '../../src/services/recurringSchedules';
import {
  pauseRecurringSchedule, resumeRecurringSchedule, updateRecurringSchedule,
} from '../../src/services/pentacleStream';

const EVERY = ['daily', 'weekdays', 'weekly'] as const;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

function Chip({ label, selected, onPress, testID }: { label: string; selected: boolean; onPress(): void; testID?: string }) {
  return <Pressable testID={testID} accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress}
    style={[styles.chip, selected && styles.chipOn]}>
    <Text style={[styles.chipText, selected && styles.chipTextOn]}>{label}</Text>
  </Pressable>;
}

// The editable fields only: name, every, at_time, days, tz. Provider, prompt and spec stay on the CLI.
function EditSheet({ rule, onClose, onSave }: {
  rule: RecurringRule | null; onClose(): void; onSave(id: string, edit: RecurringEdit): Promise<void>;
}) {
  const [name, setName] = useState('');
  const [every, setEvery] = useState<string>('daily');
  const [atTime, setAtTime] = useState('');
  const [days, setDays] = useState<string[]>([]);
  const [tz, setTz] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!rule) return;
    setName(rule.name); setEvery(rule.recurrence.every); setAtTime(rule.recurrence.at_time);
    setDays(rule.recurrence.days || []); setTz(rule.recurrence.tz); setError(''); setSaving(false);
  }, [rule]);
  if (!rule) return null;
  const save = async () => {
    setSaving(true);
    try {
      await onSave(rule.recurring_id, { name: name.trim(), every, at_time: atTime.trim(), days: every === 'weekly' ? days : [], tz: tz.trim() });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setSaving(false);
    }
  };
  return <Modal visible transparent animationType="slide" onRequestClose={onClose}>
    <View style={styles.backdrop}>
      <View testID="scheduled-edit-sheet" style={styles.sheet}>
        <Text style={styles.sheetTitle}>Edit schedule</Text>
        <Text style={styles.fieldLabel}>Name</Text>
        <TextInput testID="scheduled-edit-name" style={styles.input} value={name} onChangeText={setName} maxLength={120} />
        <Text style={styles.fieldLabel}>Every</Text>
        <View style={styles.chips}>
          {EVERY.map((value) => <Chip key={value} testID={`scheduled-edit-every-${value}`} label={value} selected={every === value} onPress={() => setEvery(value)} />)}
        </View>
        {every === 'weekly'
          ? <View style={styles.chips}>
            {DAYS.map((day) => <Chip key={day} testID={`scheduled-edit-day-${day}`} label={day} selected={days.includes(day)}
              onPress={() => setDays((current) => current.includes(day) ? current.filter((item) => item !== day) : [...current, day])} />)}
          </View>
          : null}
        <Text style={styles.fieldLabel}>At (HH:MM, 24-hour)</Text>
        <TextInput testID="scheduled-edit-time" style={styles.input} value={atTime} onChangeText={setAtTime} placeholder="02:00" autoCapitalize="none" />
        <Text style={styles.fieldLabel}>Time zone</Text>
        <TextInput testID="scheduled-edit-tz" style={styles.input} value={tz} onChangeText={setTz} autoCapitalize="none" autoCorrect={false} />
        {error ? <Text testID="scheduled-edit-error" style={styles.error}>{error}</Text> : null}
        <View style={styles.actions}>
          <Pressable testID="scheduled-edit-cancel" accessibilityRole="button" onPress={onClose} style={styles.button}><Text style={styles.buttonText}>Cancel</Text></Pressable>
          <Pressable testID="scheduled-edit-save" accessibilityRole="button" disabled={saving} onPress={save} style={[styles.button, styles.buttonPrimary]}>
            <Text style={[styles.buttonText, styles.buttonPrimaryText]}>{saving ? 'Saving…' : 'Save'}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  </Modal>;
}

export default function ScheduledRoute() {
  const isFocused = useIsFocused();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { recurring, oneShots } = useScheduled();
  const [now, setNow] = useState(Date.now);
  const [editing, setEditing] = useState<RecurringRule | null>(null);
  const [failure, setFailure] = useState('');
  useEffect(() => {
    if (!isFocused) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [isFocused]);
  const rows = useMemo(() => selectRecurringRows(recurring, now), [recurring, now]);
  const toggle = useCallback(async (rule: RecurringRule) => {
    setFailure('');
    try {
      await (rule.state === 'paused' ? resumeRecurringSchedule : pauseRecurringSchedule)(rule.recurring_id);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  }, []);
  const save = useCallback(async (id: string, edit: RecurringEdit) => {
    await updateRecurringSchedule(id, edit);
    setEditing(null);
  }, []);
  const top = Math.max(insets.top, TOP_INSET);
  return <View style={styles.root}>
    <Starfield />
    <View style={[styles.header, { paddingTop: top }]}>
      <Pressable testID="scheduled-back" accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={styles.back}>
        <Text style={styles.backText}>‹</Text>
      </Pressable>
      <Text style={styles.title}>Scheduled</Text>
    </View>
    <ScrollView contentContainerStyle={[styles.list, { paddingBottom: Math.max(insets.bottom, 18) + 12 }]}>
      {failure ? <Text testID="scheduled-failure" style={styles.error}>{failure}</Text> : null}
      {rows.length === 0 && oneShots.length === 0 ? <Text testID="scheduled-empty" style={styles.empty}>Nothing scheduled.</Text> : null}
      {rows.map((row, index) => <View key={row.id} testID={`scheduled-rule-${row.id}`} style={styles.card}>
        <View style={styles.cardHead}>
          <Text style={styles.name} numberOfLines={1}>{row.name}</Text>
          <Text testID={`scheduled-state-${row.id}`} style={[styles.badge, row.state === 'active' && styles.badgeOn]}>{row.state.toUpperCase()}</Text>
        </View>
        <Text style={styles.meta}>{row.recurrence}</Text>
        <Text style={styles.meta}>Next: {row.next}</Text>
        <Text style={styles.meta}>Last: {row.last}</Text>
        <View style={styles.actions}>
          <Pressable testID={`scheduled-toggle-${row.id}`} accessibilityRole="button" onPress={() => toggle(recurring[index])} style={styles.button}>
            <Text style={styles.buttonText}>{row.actionLabel}</Text>
          </Pressable>
          <Pressable testID={`scheduled-edit-${row.id}`} accessibilityRole="button" onPress={() => setEditing(recurring[index])} style={styles.button}>
            <Text style={styles.buttonText}>Edit</Text>
          </Pressable>
        </View>
      </View>)}
      {oneShots.map((shot) => <View key={shot.schedule_id} testID={`scheduled-oneshot-${shot.schedule_id}`} style={styles.card}>
        <View style={styles.cardHead}>
          <Text style={styles.name} numberOfLines={1}>{shot.prompt_preview || shot.schedule_id}</Text>
          <Text style={styles.badge}>ONE-SHOT</Text>
        </View>
        <Text style={styles.meta}>Fires: {formatInZone(shot.fires_at_utc, undefined)} ({formatRelative(shot.fires_at_utc, now)})</Text>
      </View>)}
    </ScrollView>
    <EditSheet rule={editing} onClose={() => setEditing(null)} onSave={save} />
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Tokens.palette.ink },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: '#3dff6633' },
  back: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backText: { color: Tokens.palette.dim, fontSize: 30, lineHeight: 32 },
  title: { color: Tokens.palette.text, fontFamily: Fonts.rajdhani.bold, fontSize: 20 },
  list: { padding: 12, gap: 10 },
  empty: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 12, textAlign: 'center', marginTop: 40 },
  card: { borderWidth: 1, borderColor: Tokens.palette.line, backgroundColor: 'rgba(8,11,10,0.7)', borderRadius: 4, padding: 12, gap: 4 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flex: 1, color: Tokens.palette.text, fontFamily: Fonts.rajdhani.bold, fontSize: 16 },
  badge: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 9.5, letterSpacing: 0.5 },
  badgeOn: { color: Tokens.palette.green },
  meta: { color: Tokens.palette.dim, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 11 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 8 },
  button: { borderWidth: 1, borderColor: Tokens.palette.line, borderRadius: 4, paddingHorizontal: 14, paddingVertical: 8 },
  buttonText: { color: Tokens.palette.text, fontFamily: Fonts.rajdhani.bold, fontSize: 14 },
  buttonPrimary: { backgroundColor: Tokens.palette.green },
  buttonPrimaryText: { color: Tokens.palette.ink },
  error: { color: Tokens.palette.amber, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 11 },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: Tokens.palette.backdrop },
  sheet: { backgroundColor: Tokens.palette.panel, padding: 16, gap: 8, borderTopWidth: 1, borderTopColor: Tokens.palette.line },
  sheetTitle: { color: Tokens.palette.text, fontFamily: Fonts.rajdhani.bold, fontSize: 18 },
  fieldLabel: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 10, letterSpacing: 0.5 },
  input: { borderWidth: 1, borderColor: Tokens.palette.line, borderRadius: 4, color: Tokens.palette.text, paddingHorizontal: 10, paddingVertical: 8,
    fontFamily: Fonts.jetBrainsMono.regular, fontSize: 13 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderColor: Tokens.palette.line, borderRadius: 4, paddingHorizontal: 10, paddingVertical: 6 },
  chipOn: { borderColor: Tokens.palette.green },
  chipText: { color: Tokens.palette.dim, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 12 },
  chipTextOn: { color: Tokens.palette.green },
});
