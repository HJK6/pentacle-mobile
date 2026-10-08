import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Fonts, Tokens } from '../../../constants/Colors';
import type { CatalogBoard } from './catalogLoader';

export default function UnsupportedBoard({ board }: { board: CatalogBoard }) {
  return (
    <View style={styles.card} testID={`dashboard-board-${board.id}`} accessibilityValue={{ text: 'unsupported' }}>
      <Text style={styles.title}>{board.name}</Text>
      <View testID="dashboard-board-unsupported">
        <View accessible accessibilityLabel="Unsupported on this client" testID={`dashboard-board-unsupported-${board.id}`}>
          <Text style={styles.body}>Unsupported on this client</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: Tokens.palette.panel, borderColor: Tokens.palette.line, borderRadius: 8, borderWidth: 1, gap: 10, padding: 16 },
  title: { color: Tokens.palette.text, fontFamily: Fonts.rajdhani.semiBold, fontSize: 20 },
  body: { color: Tokens.palette.muted, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 12 },
});
