import { StyleSheet } from 'react-native';
import { Fonts, Tokens } from '@/constants/Colors';

export const laneStyles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Tokens.palette.ink },
  body: { padding: 16, gap: 12 },
  panel: { padding: 14, gap: 10, borderWidth: 1, borderColor: Tokens.palette.line, backgroundColor: Tokens.palette.panel, borderRadius: 10 },
  title: { color: Tokens.palette.text, fontFamily: Fonts.rajdhani.bold, fontSize: 19, flexShrink: 1 },
  text: { color: Tokens.palette.text, fontFamily: Fonts.rajdhani.medium, fontSize: 15 },
  muted: { color: Tokens.palette.muted, fontFamily: Fonts.rajdhani.medium, fontSize: 14 },
  meta: { color: Tokens.palette.dim, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 10.5 },
  label: { color: Tokens.palette.green, fontFamily: Fonts.jetBrainsMono.bold, fontSize: 10.5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  button: { minHeight: 44, minWidth: 44, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: Tokens.palette.line, borderRadius: 6 },
  buttonText: { color: Tokens.palette.green, fontFamily: Fonts.rajdhani.bold, fontSize: 15 },
  header: { padding: 16, gap: 10, borderBottomWidth: 1, borderColor: Tokens.palette.line },
  error: { color: Tokens.palette.red, fontFamily: Fonts.rajdhani.medium, fontSize: 15 },
});
