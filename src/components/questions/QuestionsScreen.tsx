import React from 'react';
import QuestionDeckCard from './QuestionDeckCard';
import type { RemovalGuardNavigation } from './voice/useVoiceAnswers';

/** Notification deep links retain the overlay chrome and structured voice lifecycle. */
export default function QuestionsScreen(props: { notificationId?: string; navigation?: RemovalGuardNavigation }) {
  return <QuestionDeckCard {...props} />;
}
