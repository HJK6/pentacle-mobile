// README § 8 new-event sheet (`AddEventSheet`). WHO is a display tag only: an event tagged with the partner
// stays private to the operator, and the sheet says so (advisor correction 2, deviation D6).
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Fonts } from '../../../constants/Colors';
import { useHouseholdStore } from '../../services/household/householdStore';
import {
  dateIn, dayOfMonth, daysInMonth, dowShort, monthOf, parseTimeInput, partnerName, whoFromToggles,
} from '../../services/household/selectors';
import { PARTNER_BLUE, P, StatusLines } from './parts';

export const privateNote = (partner: string) => `PRIVATE TO YOU · ${partner.toUpperCase()} WON'T SEE THIS`;

export default function AddEventSheet({ day, onClose }: { day: string; onClose: () => void }) {
  const partner = partnerName(useHouseholdStore().snapshot);
  const month = monthOf(day);
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(day);
  const [time, setTime] = useState('');
  const [who, setWho] = useState({ me: true, partner: false });
  const [busy, setBusy] = useState(false);

  const parsedTime = parseTimeInput(time);
  const valid = title.trim().length > 0 && parsedTime.ok;
  const disabled = !valid || busy;

  const toggle = (key: 'me' | 'partner') =>
    setWho((current) => {
      const next = { ...current, [key]: !current[key] };
      return next.me || next.partner ? next : current;
    });
  const step = (delta: number) =>
    setDate((current) => {
      const target = Math.min(daysInMonth(month), Math.max(1, dayOfMonth(current) + delta));
      return dateIn(month, target);
    });

  const save = async () => {
    if (disabled || !parsedTime.ok) return;
    setBusy(true);
    const outcome = await useHouseholdStore.getState().addEvent({
      date,
      time: parsedTime.value,
      title: title.trim(),
      who: whoFromToggles(who),
    });
    setBusy(false);
    if (outcome === 'ok' || outcome === 'saved') onClose();
  };

  return (
    <View style={styles.overlay}>
      <Pressable accessibilityLabel="Close" style={styles.scrim} onPress={onClose} />
      <View style={styles.panel}>
        <View style={styles.grabber} />
        <View style={styles.bar}>
          <Pressable onPress={onClose} hitSlop={8}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.heading}>New event</Text>
          <Pressable
            testID="event-sheet-save"
            accessibilityRole="button"
            disabled={disabled}
            accessibilityState={{ disabled }}
            onPress={() => void save()}
            hitSlop={8}
          >
            <Text style={[styles.save, { color: disabled ? P.muted : P.green }]}>Save</Text>
          </Pressable>
        </View>
        <StatusLines />
        <View>
          <Text style={styles.label}>TITLE</Text>
          <TextInput
            testID="event-sheet-title"
            autoFocus
            value={title}
            onChangeText={setTitle}
            onSubmitEditing={() => void save()}
            placeholder="What’s happening?"
            placeholderTextColor={P.muted}
            style={styles.field}
          />
        </View>
        <View style={styles.columns}>
          <View style={styles.column}>
            <Text style={styles.label}>DATE</Text>
            <View style={[styles.field, styles.stepper]}>
              <Pressable onPress={() => step(-1)} hitSlop={6}>
                <Text style={styles.stepText}>‹</Text>
              </Pressable>
              <Text style={styles.dateText}>{`${dowShort(date)} ${dayOfMonth(date)}`}</Text>
              <Pressable onPress={() => step(1)} hitSlop={6}>
                <Text style={styles.stepText}>›</Text>
              </Pressable>
            </View>
          </View>
          <View style={styles.column}>
            <Text style={styles.label}>TIME</Text>
            <TextInput
              testID="event-sheet-time"
              value={time}
              onChangeText={setTime}
              placeholder="all day"
              placeholderTextColor={P.muted}
              autoCapitalize="none"
              style={[styles.field, styles.timeField]}
            />
          </View>
        </View>
        <View>
          <Text style={styles.label}>WHO · ONE OR BOTH</Text>
          <View style={styles.whoRow}>
            {(['me', 'partner'] as const).map((key) => {
              const on = who[key];
              const color = key === 'me' ? P.text : PARTNER_BLUE;
              return (
                <Pressable
                  key={key}
                  testID={`event-sheet-who-${key}`}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: on }}
                  onPress={() => toggle(key)}
                  style={[
                    styles.who,
                    { borderColor: on ? color : P.line, backgroundColor: on ? `${color}1a` : 'transparent' },
                  ]}
                >
                  <View style={[styles.whoSwatch, { backgroundColor: color, opacity: on ? 1 : 0.4 }]} />
                  <Text style={[styles.whoText, { color: on ? color : P.muted }]}>{key === 'me' ? 'Me' : partner}</Text>
                </Pressable>
              );
            })}
          </View>
          {who.partner ? (
            <Text testID="event-sheet-private-note" style={styles.privateNote}>{privateNote(partner)}</Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, zIndex: 20 },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(3,7,5,0.7)' },
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: P.panel,
    borderTopWidth: 1,
    borderTopColor: P.line,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: 10,
    paddingHorizontal: 16,
    paddingBottom: 22,
    gap: 16,
  },
  grabber: { width: 42, height: 4, borderRadius: 999, backgroundColor: P.line, alignSelf: 'center' },
  bar: { flexDirection: 'row', alignItems: 'center' },
  cancel: { color: P.muted, fontFamily: Fonts.rajdhani.bold, fontSize: 15 },
  heading: { flex: 1, textAlign: 'center', fontFamily: Fonts.rajdhani.bold, fontSize: 18, color: P.text },
  save: { fontFamily: Fonts.rajdhani.bold, fontSize: 15 },
  label: { fontFamily: Fonts.jetBrainsMono.regular, fontSize: 9.5, letterSpacing: 1.3, color: P.muted, marginBottom: 6 },
  field: {
    backgroundColor: P.ink,
    borderWidth: 1,
    borderColor: P.line,
    borderRadius: 4,
    paddingVertical: 11,
    paddingHorizontal: 12,
    color: P.text,
    fontFamily: Fonts.rajdhani.medium,
    fontSize: 16,
  },
  columns: { flexDirection: 'row', gap: 10 },
  column: { flex: 1 },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, paddingHorizontal: 6 },
  stepText: { color: P.dim, fontSize: 20, fontFamily: Fonts.rajdhani.medium, paddingHorizontal: 6 },
  dateText: { color: P.text, fontFamily: Fonts.rajdhani.bold, fontSize: 16 },
  timeField: { fontFamily: Fonts.jetBrainsMono.regular, fontSize: 15 },
  whoRow: { flexDirection: 'row', gap: 8 },
  who: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 4,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  whoSwatch: { width: 4, height: 16, borderRadius: 2 },
  whoText: { fontFamily: Fonts.rajdhani.bold, fontSize: 15 },
  privateNote: { fontFamily: Fonts.jetBrainsMono.regular, fontSize: 9.5, letterSpacing: 1, color: P.amber, marginTop: 8 },
});
