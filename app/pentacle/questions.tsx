import React from 'react';
import { Stack, useLocalSearchParams, useNavigation } from 'expo-router';

import { QuestionsScreen } from '../../src/components/questions';
import type { RemovalGuardNavigation } from '../../src/components/questions/voice/useVoiceAnswers';

// /pentacle/questions — the Bart-first Questions overlay (docs/bart_home_contracts.md § Routes).
// The route hands its navigation to the screen so a live voice take guards its own removal
// (iOS swipe-dismiss of the transparentModal).
export default function QuestionsRoute() {
  const params = useLocalSearchParams<{ notificationId?: string | string[] }>();
  const navigation = useNavigation();
  const raw = Array.isArray(params.notificationId) ? params.notificationId[0] : params.notificationId;
  return (
    <>
      <Stack.Screen options={{ presentation: 'transparentModal', animation: 'fade' }} />
      <QuestionsScreen notificationId={raw || undefined} navigation={navigation as unknown as RemovalGuardNavigation} />
    </>
  );
}
