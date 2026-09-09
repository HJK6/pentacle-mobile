import type { PentacleQuestion } from 'pentacle-chat-core';

// Captured from hosta:claude-hosta-fdd78858, AskUserQuestion daemon seq 28885.
export const UNANET_QUESTION_PREVIEW_PAYLOAD = {
  header: 'Submit decision',
  prompt: "I've saved 8h for 06/29 and 06/30. How should I handle 06/19 (Juneteenth, currently 0h) and the submit?",
  multiSelect: false,
  allow_custom: true,
  options: [
    {
      index: 1,
      label: 'Submit as-is (06/19 = 0h)',
      description: 'Submit the whole 06/16\u201306/30 period now, leaving Friday 06/19 at 0h (treated as the Juneteenth federal holiday). Total submitted = 80h.',
      preview: 'Period 06/16\u201306/30 submitted as:\n  06/16-18  8/8/8\n  06/19     0   (Juneteenth holiday)\n  06/22-26  8/8/8/8/8\n  06/29-30  8/8\n  --------------------\n  TOTAL     80h',
    },
    {
      index: 2,
      label: 'Set 06/19 to 8h first, then submit',
      description: 'Fill Friday 06/19 with 8h (if you actually worked Juneteenth), then submit the full period. Total submitted = 88h.',
      preview: 'Period 06/16\u201306/30 submitted as:\n  06/16-19  8/8/8/8\n  06/22-26  8/8/8/8/8\n  06/29-30  8/8\n  --------------------\n  TOTAL     88h',
    },
    {
      index: 3,
      label: "Don't submit yet \u2014 hold",
      description: 'Leave everything saved (not submitted). I stop here and you can submit later or tell me when to.',
      preview: 'Saved, NOT submitted.\nTimesheet stays editable.\nNothing sent for approval.',
    },
  ],
} as unknown as PentacleQuestion;
