import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Tokens } from '../../../constants/Colors';
import type { QuestionDeckEntry } from './questionSelectors';

// One dot per page: active is 22 wide in that question's accent, answered is accent+66,
// the rest are the line color. Tapping a dot goes to that page.
export default function DeckDots({ entries, activeIndex, answered, onChange }: {
  entries: readonly QuestionDeckEntry[];
  activeIndex: number;
  answered: ReadonlySet<string>;
  onChange: (index: number) => void;
}) {
  return (
    <View style={styles.dots}>
      {entries.map((entry, index) => {
        const active = index === activeIndex;
        return (
          <Pressable
            key={entry.key}
            testID={`questions-dot-${index}`}
            accessibilityRole="button"
            accessibilityLabel={`Go to question ${index + 1}`}
            accessibilityState={{ selected: active, checked: answered.has(entry.key) }}
            hitSlop={{ top: 10, bottom: 10, left: 4, right: 4 }}
            onPress={() => onChange(index)}
            style={[
              styles.dot,
              {
                width: active ? 22 : 8,
                backgroundColor: active ? entry.accent : (answered.has(entry.key) ? `${entry.accent}66` : Tokens.palette.line),
              },
            ]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  dots: { minHeight: 12, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 7 },
  dot: { height: 8, borderRadius: 999 },
});
