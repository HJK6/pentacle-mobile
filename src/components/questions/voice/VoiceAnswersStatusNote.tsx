import React from 'react';
import { StyleSheet, Text } from 'react-native';

import { Fonts, Tokens } from '../../../../constants/Colors';
import { parseVoiceAnswersStatus, type VoiceAnswersStatus } from './voiceAnswersBinding';

// Rendered under a voice bubble in the assistant thread: when the daemon dropped the binding the
// turn still posted as a plain voice note, and this line says the questions were not attached
// (spec § V2). A bound turn, or one without status, renders nothing.
export default function VoiceAnswersStatusNote({ meta, status }: { meta?: unknown; status?: VoiceAnswersStatus | null }) {
  const resolved = status ?? parseVoiceAnswersStatus(meta);
  if (resolved?.state !== 'dropped') return null;
  return <Text testID="voice-answers-status-dropped" style={styles.note}>{"Couldn't attach questions"}</Text>;
}

const styles = StyleSheet.create({
  note: {
    alignSelf: 'flex-end',
    marginTop: 4,
    color: Tokens.palette.amber,
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 10,
    letterSpacing: 1,
  },
});
