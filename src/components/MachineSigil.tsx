import React from 'react';
import Svg, { Circle, Ellipse, G, Line, Path } from 'react-native-svg';
import { Tokens, type MachineSigilKind } from '@/constants/Colors';

type Props = {
  kind: MachineSigilKind;
  size?: number;
  color?: string;
};

function MageStar({ cx, cy, r, color }: { cx: number; cy: number; r: number; color: string }) {
  const pts: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    const a = (i * Math.PI) / 4;
    const rr = i % 2 ? r * 0.4 : r;
    pts.push(`${cx + rr * Math.sin(a)},${cy - rr * Math.cos(a)}`);
  }
  return <Path d={`M${pts.join(' L')} Z`} fill={color} stroke="none" />;
}

export default function MachineSigil({
  kind,
  size = 64,
  color = Tokens.palette.green,
}: Props) {
  const strokeProps = {
    fill: 'none',
    stroke: color,
    strokeWidth: 2.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  if (kind === 'djinni') {
    return (
      <Svg width={size} height={size} viewBox="0 0 64 64">
        <G {...strokeProps}>
          <Path d="M4 26 C9 29 13 30 18 30.5 C28 31 40 31 46 30.5 C50.5 31.5 51.5 35.5 48 38.5 C44 42.5 36 44.5 30 44.5 C22 44.5 14 41.5 11 37.5 C8 33.5 6 30 4 26 Z" />
          <Path d="M25.5 30.5 C25.5 23 38.5 23 38.5 30.5" />
          <Path d="M29.5 23.4 C29.5 21.4 34.5 21.4 34.5 23.4" />
          <Circle cx="32" cy="18.4" r="2.6" fill={color} stroke="none" />
          <Path d="M47 31 C57 29 59.5 39.5 51 41.5 C48.3 42.1 47.7 39.8 49.6 38.8" />
          <Path d="M30 44.5 L29.2 49 M34 44.5 L34.8 49" />
          <Path d="M26 51.5 C27 49 37 49 38 51.5" />
        </G>
      </Svg>
    );
  }

  if (kind === 'mage') {
    return (
      <Svg width={size} height={size} viewBox="0 0 64 64">
        <G {...strokeProps}>
          <Path d="M26 6 C24.5 12 22 18 19 23 L33 23 C30 18 27.5 12 26 6 Z" />
          <Path d="M15 23.5 C20 27 32 27 37 23.5" />
          <MageStar cx={25} cy={15} r={2.6} color={color} />
          <Circle cx="26" cy="27.6" r="3.3" />
          <Path d="M22.6 30.4 C22 38 24 43 26 45 C28 43 30 38 29.4 30.4" />
          <Path d="M20 32 C17 43 15.4 50 14.5 55.4 L37.5 55.4 C36.6 49 34.6 40 32 32" />
          <Path d="M26 45 L26 55.2" />
          <Path d="M17 46.5 C24 49.4 31 49.4 35.4 46.5" />
          <Path d="M32 39 C37 37.6 41 38 44 39.4" />
          <Path d="M45.6 13 L43.6 56" />
          <Circle cx="46" cy="10.4" r="3" fill={color} stroke="none" />
          <Path d="M46 4.4 L46 7.4 M51.6 10.4 L48.8 10.4 M50 6.4 L48.1 8.2" />
        </G>
      </Svg>
    );
  }

  if (kind === 'sun') {
    const rays = [];
    for (let a = 0; a < 360; a += 30) {
      const rad = (a * Math.PI) / 180;
      const long = (a / 30) % 2 === 0;
      const r1 = 20;
      const r2 = long ? 30 : 26;
      rays.push(
        <Line
          key={a}
          x1={32 + r1 * Math.cos(rad)}
          y1={32 + r1 * Math.sin(rad)}
          x2={32 + r2 * Math.cos(rad)}
          y2={32 + r2 * Math.sin(rad)}
        />,
      );
    }
    return (
      <Svg width={size} height={size} viewBox="0 0 64 64">
        <G {...strokeProps}>
          {rays}
          <Path
            d="M32 16 C36 23 41 27 41 35 A9 9 0 1 1 23 35 C23 29 26 26 28 22 C29.5 27 31 28.5 32 30 C34.5 25 32 20 32 16 Z"
            fill={`${color}22`}
          />
          <Path
            d="M32 31 C34 33 34.5 36 33 38 A3.2 3.2 0 1 1 29.6 35.5 C29.6 34 30.8 33 32 31 Z"
            fill={color}
            stroke="none"
          />
        </G>
      </Svg>
    );
  }

  const petals = [];
  for (let a = 0; a < 360; a += 60) {
    petals.push(
      <Ellipse key={a} cx="32" cy="14.5" rx="4.2" ry="8" transform={`rotate(${a} 32 24)`} />,
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <G {...strokeProps}>
        {petals}
        <Circle cx="32" cy="24" r="6" fill={`${color}22`} />
        <Path d="M27 22 Q29 20 31 22 M33 22 Q35 20 37 22" />
        <Path d="M30 23.5 L29.5 26 M32 23.5 L32 26.5 M34 23.5 L34.5 26" />
        <Path d="M32 30 L32 58" />
        <Path d="M32 48 C40 45 45 51 44 58" />
        <Path d="M32 40 C25 38 21 43 22 49" />
      </G>
    </Svg>
  );
}

export type { MachineSigilKind };
