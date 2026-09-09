import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Fonts, SEV, Tokens, type Severity } from '@/constants/Colors';

type Props = {
  severity: Severity | string;
};

function severityColor(severity: string): string {
  const key = severity.toLowerCase() as 'info' | 'warning' | 'critical';
  return SEV[key] ?? Tokens.palette.green;
}

export default function SevTag({ severity }: Props) {
  const label = String(severity || 'info').toUpperCase();
  const color = severityColor(label);

  return (
    <View style={[styles.root, { borderColor: color, backgroundColor: `${color}10` }]}>
      <Text style={[styles.label, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  label: {
    fontFamily: Fonts.jetBrainsMono.bold,
    fontSize: Tokens.type.label,
    letterSpacing: 0.6,
  },
});
