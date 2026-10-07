// Shared atoms for Personal / Lists / Calendar, bound to design original § 7–9
// (`pentacle-bart-personal.jsx`, `-lists.jsx`, `-calendar.jsx`) and README § Design tokens.
import React, { useCallback, useEffect } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Fonts, Tokens } from '../../../constants/Colors';
import { Spinner } from '../ArcaneAtoms';
import MachineSigil from '../MachineSigil';
import { useHouseholdStore } from '../../services/household/householdStore';
import type { ItemTag, Tone, WhoBar as WhoBarKind } from '../../services/household/selectors';

export const P = Tokens.palette;
export const PARTNER_BLUE = '#6fb3ff';
export const ROW_LINE = 'rgba(255,255,255,0.05)';
export const TONE: Record<Tone, string> = { red: P.red, amber: P.amber, muted: P.muted };
export const WHO_COLOR: Record<WhoBarKind, string> = { me: P.text, partner: PARTNER_BLUE };
export const UNAVAILABLE_TEXT = 'Household store unavailable';

/** Bart's genie lamp (the djinni sigil belongs to Bart alone). */
export function Lamp({ size = 16, color = P.green }: { size?: number; color?: string }) {
  return <MachineSigil kind="djinni" size={size} color={color} />;
}

/** `PcTabHeader`: optional back chevron, mono sub-label over a Rajdhani 26/700 title, right slot. */
export function TabHeader({
  title,
  sub,
  right,
  onBack,
  top,
}: {
  title: string;
  sub?: string;
  right?: React.ReactNode;
  onBack?: () => void;
  top: number;
}) {
  return (
    <View style={[styles.header, { paddingTop: top + 4, paddingLeft: onBack ? 10 : 16 }]}>
      {onBack ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} hitSlop={8}>
          <Text style={styles.back}>‹</Text>
        </Pressable>
      ) : null}
      <View style={styles.headerText}>
        {sub ? <Text style={styles.sub}>{sub}</Text> : null}
        <Text style={styles.title}>{title}</Text>
      </View>
      {right}
    </View>
  );
}

/** 4 px who-bar; `both` is the split Me/partner bar. */
export function WhoBar({ bars, height }: { bars: WhoBarKind[]; height: number }) {
  return (
    <View style={[styles.whoBar, { height }]}>
      {bars.map((bar) => (
        <View key={bar} style={{ flex: 1, backgroundColor: WHO_COLOR[bar] }} />
      ))}
    </View>
  );
}

/** Due/priority tags (mono 9, letter-spacing 1, 700), with the muted lamp only for Bart's items. */
export function ItemTags({ tags, lamp, testID }: { tags: ItemTag[]; lamp: boolean; testID?: string }) {
  if (!tags.length && !lamp) return null;
  return (
    <View style={styles.tags}>
      {lamp ? <Lamp size={11} color={P.muted} /> : null}
      {tags.map((tag) => (
        <Text key={tag.text} testID={testID} style={[styles.tag, { color: TONE[tag.tone] }]}>
          {tag.text}
        </Text>
      ))}
    </View>
  );
}

/** 24 px checkbox (1.5 px border, radius 4); green fill with a check while pending. */
export function CheckBox({ checked, onPress, testID }: { checked: boolean; onPress: () => void; testID?: string }) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="checkbox"
      accessibilityLabel={checked ? 'Undo' : 'Check'}
      accessibilityState={{ checked }}
      onPress={onPress}
      hitSlop={6}
      style={[styles.check, checked && styles.checkOn]}
    >
      {checked ? <Text style={styles.checkMark}>✓</Text> : null}
    </Pressable>
  );
}

/** The first-load spinner, one notice line (unresolved / not saved) and the unavailable line. */
export function StatusLines() {
  const { notice, status, snapshot } = useHouseholdStore();
  return (
    <>
      {!snapshot && status !== 'unavailable' ? (
        <View testID="household-loading" style={styles.loading}>
          <Spinner size={24} strokeWidth={2.5} />
        </View>
      ) : null}
      {status === 'unavailable' ? <Text style={styles.unavailable}>{UNAVAILABLE_TEXT}</Text> : null}
      {notice ? (
        <Text style={[styles.notice, notice.kind === 'error' && { color: P.red }]}>{notice.text}</Text>
      ) : null}
    </>
  );
}

/** Refetch on screen focus and on app foreground (spec B2: no live relay in this packet). */
export function useHouseholdRefresh(month?: string, hasMonth = false) {
  const refresh = useCallback(() => {
    const { refresh: run } = useHouseholdStore.getState();
    void (hasMonth ? run(month) : run());
  }, [month, hasMonth]);
  useFocusEffect(refresh);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') refresh();
    });
    return () => sub.remove();
  }, [refresh]);
  return refresh;
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: P.ink },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    paddingRight: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: P.line,
  },
  back: { color: P.text, fontSize: 28, fontFamily: Fonts.rajdhani.medium, paddingHorizontal: 6, paddingBottom: 2, lineHeight: 30 },
  headerText: { flex: 1, minWidth: 0 },
  sub: { fontFamily: Fonts.jetBrainsMono.regular, fontSize: 10, letterSpacing: 1.4, color: P.muted },
  title: { fontFamily: Fonts.rajdhani.bold, fontSize: 26, color: P.text, lineHeight: 29 },
  whoBar: { width: 4, borderRadius: 2, overflow: 'hidden' },
  tags: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  tag: { fontFamily: Fonts.jetBrainsMono.bold, fontSize: 9, letterSpacing: 1 },
  check: {
    width: 24,
    height: 24,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: P.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { borderColor: P.green, backgroundColor: P.green },
  checkMark: { color: P.ink, fontSize: 14, fontFamily: Fonts.rajdhani.bold, lineHeight: 16 },
  loading: { alignItems: 'center', paddingVertical: 24 },
  unavailable: { fontFamily: Fonts.rajdhani.medium, fontSize: 15, color: P.muted, paddingVertical: 8 },
  notice: { fontFamily: Fonts.jetBrainsMono.regular, fontSize: 9.5, letterSpacing: 1, color: P.amber, paddingVertical: 6 },
  sectionLabel: { fontFamily: Fonts.jetBrainsMono.bold, fontSize: 10.5, letterSpacing: 1.4, color: P.green },
  rowLine: { borderBottomWidth: 1, borderBottomColor: ROW_LINE },
});
