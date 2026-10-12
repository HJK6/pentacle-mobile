import { StyleSheet } from 'react-native';

// Keep the mic beside the compact title/status stack, centered with the mark.
export const compactHeaderLayout = StyleSheet.create({
  identity: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 9 },
  copy: { flexShrink: 1, minWidth: 0 },
});
