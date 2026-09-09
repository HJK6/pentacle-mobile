import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Fonts, Tokens, type ProviderName } from '@/constants/Colors';
import { Brackets, Spark } from './ArcaneAtoms';

type Props = {
  provider: ProviderName | string;
  color?: string;
};

export default function ProviderTag({ provider, color = Tokens.palette.green }: Props) {
  const normalized = String(provider).toLowerCase();
  const isClaude = normalized === 'claude';

  return (
    <View style={styles.root}>
      {isClaude ? <Spark size={12} color={color} /> : <Brackets size={12} color={color} />}
      <Text style={[styles.label, { color }]}>{isClaude ? 'Claude' : 'Codex'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  label: {
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: Tokens.type.meta,
    letterSpacing: 0.5,
  },
});
