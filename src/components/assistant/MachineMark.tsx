import React from 'react';
import { Text } from 'react-native';
import { Fonts, MACHINES, Tokens, type MachineName } from '@/constants/Colors';
import ArcaneRingFrame from '../ArcaneRingFrame';
import MachineSigil from '../MachineSigil';

export default function MachineMark({ machine, size = 38 }: { machine: MachineName; size?: number }) {
  const meta = MACHINES[machine];
  const monogram = meta.kind === 'djinni';
  const color = monogram ? Tokens.palette.muted : meta.accent;
  return <ArcaneRingFrame size={size} color={color} identity>
    {monogram ? <Text style={{ fontFamily: Fonts.cinzel.bold, fontSize: size * 0.38, color: Tokens.palette.dim }}>B</Text>
      : <MachineSigil kind={meta.kind} size={size * 0.62} color={color} />}
  </ArcaneRingFrame>;
}
