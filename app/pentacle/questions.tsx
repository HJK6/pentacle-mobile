import React from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';

import { QuestionsScreen } from '../../src/components/questions';

// /pentacle/questions — the Bart-first Questions overlay (docs/bart_home_contracts.md § Routes).
export default function QuestionsRoute() {
  const params = useLocalSearchParams<{ notificationId?: string | string[] }>();
  const raw = Array.isArray(params.notificationId) ? params.notificationId[0] : params.notificationId;
  return (
    <>
      <Stack.Screen options={{ presentation: 'transparentModal', animation: 'fade' }} />
      <QuestionsScreen notificationId={raw || undefined} />
    </>
  );
}
