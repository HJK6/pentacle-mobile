import React from 'react';
import { StyleSheet, View } from 'react-native';

import { MACHINES, Tokens, type MachineName, type MachineSigilKind } from '../../../constants/Colors';
import MachineSigil from '../MachineSigil';

// The question's source: the assistant's ring (its identity sigil in lamp green) or the session host's
// machine sigil in its accent ring. Swap for P3's MachineMark/LampRing if they become shared.
export default function SourceMark({ isBart, assistantSigil, machineName, accent, size = 32 }: {
  isBart: boolean;
  assistantSigil: MachineSigilKind;
  machineName: MachineName;
  accent: string;
  size?: number;
}) {
  const kind = isBart ? assistantSigil : MACHINES[machineName].kind;
  const color = isBart ? Tokens.palette.green : accent;
  return (
    <View
      testID="questions-source-mark"
      style={[styles.ring, { width: size, height: size, borderRadius: size / 2, borderColor: color }]}
    >
      <MachineSigil kind={kind} size={Math.round(size * 0.58)} color={color} />
    </View>
  );
}

const styles = StyleSheet.create({
  ring: { borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
});
