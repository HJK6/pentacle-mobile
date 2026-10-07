import React from 'react';
import { render, screen } from '@testing-library/react-native';

import { VoiceAnswersStatusNote } from '../../src/components/questions/voice';

jest.mock('expo-constants', () => require('../helpers/stubs/expoConstants.cjs'));

describe('VoiceAnswersStatusNote', () => {
  test('a dropped binding renders "Couldn\'t attach questions" under the bubble', () => {
    render(<VoiceAnswersStatusNote meta={{ voice_answers_status: { state: 'dropped', reason: 'unknown_question', stale_keys: [] } }} />);
    expect(screen.getByTestId('voice-answers-status-dropped').props.children).toBe("Couldn't attach questions");
  });

  test('a bound turn and a turn without status render nothing', () => {
    const bound = render(<VoiceAnswersStatusNote meta={{ voice_answers_status: { state: 'bound', stale_keys: [] } }} />);
    expect(bound.toJSON()).toBeNull();
    const none = render(<VoiceAnswersStatusNote meta={{ voice: { duration_s: 3 } }} />);
    expect(none.toJSON()).toBeNull();
  });
});
