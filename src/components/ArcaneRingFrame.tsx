import React from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';
import { MACHINES, Tokens, type MachineName, type MachineSigilKind } from '@/constants/Colors';
import MachineSigil from './MachineSigil';

type Props = {
  size?: number;
  color?: string;
  kind?: MachineSigilKind;
  machine?: MachineName;
  sigilSize?: number;
  children?: React.ReactNode;
};

// Memoized: this renders an SVG ring (2 circles + 12 trig-computed tick lines)
// plus a MachineSigil, and it appears once per all-chats row. Its inputs
// (machine/size/sigilSize) do not change when a row's preview text updates, so
// under burst load re-rendering the whole SVG for every changed row dominated
// the React commit that kept all_chats set_state_ms over budget (spec
// tap_shell_layout_regression_build_1155 slice 2b). React.memo skips the SVG
// when props are unchanged; callers passing per-render `children` still update.
function ArcaneRingFrame({
  size = 64,
  color,
  kind,
  machine,
  sigilSize,
  children,
}: Props) {
  const machineMeta = machine ? MACHINES[machine] : undefined;
  const accent = color ?? machineMeta?.accent ?? Tokens.palette.green;
  const sigilKind = kind ?? machineMeta?.kind;
  const ticks = [];

  for (let a = 0; a < 360; a += 30) {
    const rad = (a * Math.PI) / 180;
    const r = (a / 30) % 3 === 0 ? 38 : 41;
    ticks.push(
      <Line
        key={a}
        x1={50 + r * Math.cos(rad)}
        y1={50 + r * Math.sin(rad)}
        x2={50 + 45 * Math.cos(rad)}
        y2={50 + 45 * Math.sin(rad)}
        stroke={accent}
        strokeWidth="1"
        opacity="0.5"
      />,
    );
  }

  return (
    <View style={[styles.frame, { width: size, height: size }]}>
      <Svg width={size} height={size} viewBox="0 0 100 100" style={StyleSheet.absoluteFill}>
        <Circle cx="50" cy="50" r="47" fill="none" stroke={accent} strokeWidth="1.4" opacity="0.6" />
        <Circle
          cx="50"
          cy="50"
          r="34"
          fill="none"
          stroke={accent}
          strokeWidth="0.8"
          strokeDasharray="1.5 3"
          opacity="0.45"
        />
        {ticks}
      </Svg>
      {children ?? (sigilKind ? <MachineSigil kind={sigilKind} size={sigilSize ?? size * 0.62} color={accent} /> : null)}
    </View>
  );
}

export default React.memo(ArcaneRingFrame);

const styles = StyleSheet.create({
  frame: {
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    position: 'relative',
  },
});
