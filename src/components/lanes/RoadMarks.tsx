import React, { useId } from 'react';
import { Animated, Text, View } from 'react-native';
import Svg, { Circle, Defs, Line, Path, Pattern, Rect } from 'react-native-svg';
import type { GoalClass, GoalDot, GoalPosition, ItemKind } from 'pentacle-chat-core';
import { Fonts } from '@/constants/Colors';
import { mono, p } from './LaneAtoms';

// Locked 2026-11-14: blocked is bright yellow and always carries a pattern, a hatch in rings and bars and a
// strike in item marks and home dots, so meaning never rests on hue alone.
const patternId = (id: string) => `hatch${id.replace(/[^a-zA-Z0-9]/g, '')}`;
/** Diagonal stripes `gap` apart. The tile draws the diagonal itself: iOS clips a rotated pattern tile to slivers. */
function Hatch({ id, gap, width, opacity = 1 }: { id: string; gap: number; width: number; opacity?: number }) {
  const t = gap * Math.SQRT2, q = t / 4;
  return <Defs><Pattern id={id} patternUnits="userSpaceOnUse" width={t} height={t}>
    <Path d={`M${-q} ${q}L${q} ${-q}M0 ${t}L${t} 0M${t - q} ${t + q}L${t + q} ${t - q}`} stroke={p.yellow} strokeWidth={width} opacity={opacity} />
  </Pattern></Defs>;
}

export function Check({ size, color = p.green, weight = 2.6 }: { size: number; color?: string; weight?: number }) {
  return <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke={color} strokeWidth={weight} strokeLinecap="round" strokeLinejoin="round" /></Svg>;
}

/** A circle struck from bottom left to top right: blocked as a shape, not only a hue. */
export function Struck({ size, testID }: { size: number; testID?: string }) {
  const r = 50 - 9, d = r * Math.SQRT1_2;
  return <Svg testID={testID} width={size} height={size} viewBox="0 0 100 100">
    <Circle cx={50} cy={50} r={r} fill="none" stroke={p.yellow} strokeWidth={13} />
    <Line x1={50 - d} y1={50 + d} x2={50 + d} y2={50 - d} stroke={p.yellow} strokeWidth={17} />
  </Svg>;
}

export type RingTone = 'now' | GoalPosition | 'done';
export const ringTone = (goalClass: GoalClass, position: GoalPosition | null): RingTone =>
  goalClass === 'done' ? 'done' : goalClass === 'working' || goalClass === 'moving' ? 'now' : position ?? 'later';

/** A goal stop: the number is its place among unfinished goals, the arc is progress, a done goal shows a check. */
export function NumRing({ n, tone, fraction = 0, size, yellow = false, hatch = false, muted = false, children, testID }: {
  n: number | null; tone: RingTone; fraction?: number; size: number; yellow?: boolean; hatch?: boolean; muted?: boolean; children?: React.ReactNode; testID?: string;
}) {
  const id = patternId(useId()), r = 44, c = 2 * Math.PI * r;
  const color = muted ? p.muted : yellow || hatch ? p.yellow : tone === 'next' || tone === 'later' ? p.faint : p.green;
  return <View testID={testID} style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
    <Svg width={size} height={size} viewBox="0 0 100 100" style={{ position: 'absolute' }}>
      {hatch ? <Hatch id={id} gap={11} width={3.5} opacity={0.55} /> : null}
      <Circle cx={50} cy={50} r={r} fill={p.ink} stroke={color} strokeWidth={tone === 'now' ? 5 : 4}
        strokeOpacity={tone === 'now' ? 0.3 : tone === 'done' ? 1 : 0.8} strokeDasharray={tone === 'later' ? '5 9' : undefined} />
      {hatch ? <Circle testID={testID ? `${testID}-hatch` : undefined} cx={50} cy={50} r={38} fill={`url(#${id})`} /> : null}
      {tone === 'now' ? <Circle cx={50} cy={50} r={r} fill="none" stroke={color} strokeWidth={8} strokeLinecap="round"
        strokeDasharray={`${Math.max(0.03, Math.min(1, fraction)) * c} ${c}`} transform="rotate(-90 50 50)" /> : null}
    </Svg>
    {tone === 'done' ? <View><Check size={size * 0.5} color={muted ? p.muted : p.green} /></View>
      : <Text allowFontScaling={false} style={{ fontFamily: tone === 'now' || hatch ? Fonts.rajdhani.bold : Fonts.rajdhani.medium, fontSize: size * 0.46,
        lineHeight: size * 0.56, color: tone === 'now' || hatch ? p.text : p.muted, ...(hatch ? { textShadowColor: p.ink, textShadowRadius: 3 } : {}) }}>{n}</Text>}
    {children}
  </View>;
}

/** A spark circling a ring: an agent is on this goal right now. Mounted only while its screen's loop runs. */
export function Spark({ size, phase, testID }: { size: number; phase: Animated.Value; testID: string }) {
  const inset = size * 0.06, box = size - inset * 2, dot = size < 24 ? 4 : 5;
  return <Animated.View testID={testID} pointerEvents="none" style={{ position: 'absolute', left: inset, top: inset, width: box, height: box,
    transform: [{ rotate: phase.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] }}>
    <View style={{ position: 'absolute', top: -dot / 2, left: box / 2 - dot / 2, width: dot, height: dot, borderRadius: dot / 2,
      backgroundColor: '#eafff0', shadowColor: p.green, shadowOpacity: 1, shadowRadius: 3, shadowOffset: { width: 0, height: 0 } }} />
  </Animated.View>;
}

/** Item marks differ by shape as well as colour. Only a working item's mark pulses. */
export function ItemMark({ kind, pulse, testID }: { kind: ItemKind; pulse?: Animated.Value | null; testID?: string }) {
  const ring = (color: string) => <View style={{ width: 9, height: 9, borderRadius: 5, borderWidth: 1.5, borderColor: color }} />;
  return <View testID={testID} style={{ width: 14, height: 18, alignItems: 'center', justifyContent: 'center' }}>
    {kind === 'done' ? <Check size={11} color={p.muted} />
      : kind === 'needs' ? <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: p.yellow, alignItems: 'center', justifyContent: 'center' }}>
        <Text allowFontScaling={false} style={{ fontFamily: Fonts.rajdhani.bold, fontSize: 11, lineHeight: 14, color: '#1a1600' }}>?</Text></View>
      : kind === 'working' ? <>
        {pulse ? <Animated.View testID={testID ? `${testID}-pulse` : undefined} style={{ position: 'absolute', width: 15, height: 15, borderRadius: 8, backgroundColor: p.green,
          opacity: pulse.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.18, 0.05, 0.18] }),
          transform: [{ scale: pulse.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 1.3, 1] }) }] }} /> : null}
        <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: p.green }} /></>
      : kind === 'blocked' ? <Struck size={12} />
      : ring(kind === 'in_progress' ? p.green : kind === 'next' ? p.muted : p.faint)}
  </View>;
}

/** The lane's road in one line: one still dot per goal, in goal order. */
export function GoalDots({ dots, more, testID }: { dots: GoalDot[]; more: number; testID?: string }) {
  if (!dots.length) return null;
  return <View testID={testID} style={{ flexDirection: 'row', alignItems: 'center', marginTop: 7, marginBottom: 2 }}>
    {dots.map((dot, i) => <React.Fragment key={i}>
      {i ? <View style={{ width: 14, height: 1.5, backgroundColor: dot === 'done' ? p.green : p.faint, opacity: dot === 'done' ? 0.55 : 0.6 }} /> : null}
      <View testID={testID ? `${testID}-${i}-${dot}` : undefined}>{dot === 'blocked' ? <Struck size={10} />
        : <Svg width={dot === 'working' || dot === 'moving' ? 10 : 8} height={dot === 'working' || dot === 'moving' ? 10 : 8} viewBox="0 0 10 10">
          <Circle cx={5} cy={5} r={dot === 'done' || dot === 'working' ? 5 : 4.25}
            fill={dot === 'done' || dot === 'working' ? p.green : 'none'} fillOpacity={dot === 'done' ? 0.55 : 1}
            stroke={dot === 'done' || dot === 'working' ? 'none' : dot === 'moving' ? p.green : dot === 'next' ? p.muted : p.faint} strokeWidth={1.5}
            strokeDasharray={dot === 'later' ? '1.4 2' : undefined} />
        </Svg>}</View>
    </React.Fragment>)}
    {more ? <Text style={{ ...mono, fontSize: 8.5, marginLeft: 7 }}>+{more}</Text> : null}
  </View>;
}

/** The one bar. Blocked draws diagonal stripes in yellow. */
export function RoadBar({ done, total, label, hatch = false, testID }: { done: number; total: number; label: string; hatch?: boolean; testID?: string }) {
  const id = patternId(useId()), fill = total ? Math.max(0, Math.min(1, done / total)) : 0, h = hatch ? 6 : 4;
  return <View testID={testID} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 7 }}>
    <View style={{ flex: 1, minWidth: 48, height: h }}>
      {hatch ? <Svg width="100%" height={h}>
        <Hatch id={`${id}a`} gap={7} width={2.8} opacity={0.3} /><Hatch id={`${id}b`} gap={7} width={3.5} />
        <Rect testID={testID ? `${testID}-hatch` : undefined} x={0} y={0} width="100%" height={h} rx={3} fill={`url(#${id}a)`} />
        <Rect x={0} y={0} width={`${fill * 100}%`} height={h} rx={3} fill={`url(#${id}b)`} />
      </Svg> : <View style={{ flex: 1, borderRadius: 2, backgroundColor: `${p.green}1f`, overflow: 'hidden' }}>
        <View style={{ width: `${fill * 100}%`, height: '100%', backgroundColor: p.green }} /></View>}
    </View>
    <Text testID={testID ? `${testID}-label` : undefined} numberOfLines={1} style={{ ...mono, flexShrink: 0 }}><Text style={{ color: p.dim }}>{done}/{total}</Text>{label}</Text>
  </View>;
}
