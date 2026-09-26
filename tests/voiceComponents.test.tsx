import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react-native';

import VoiceBubble from '../src/components/voice/VoiceBubble';
import RecordingStrip from '../src/components/voice/RecordingStrip';
import RecordingPill from '../src/components/voice/RecordingPill';

describe('VoiceBubble', () => {
  test('renders the formatted duration', () => {
    render(<VoiceBubble levels={[0.2, 0.8, 0.5]} durationS={75} />);
    expect(screen.getByTestId('voice-bubble')).toBeTruthy();
    expect(screen.getByTestId('voice-bubble-duration').props.children).toBe('1:15');
  });

  test('handles an empty level series without throwing', () => {
    render(<VoiceBubble levels={[]} durationS={3} />);
    expect(screen.getByTestId('voice-bubble-duration').props.children).toBe('0:03');
  });
});

describe('RecordingStrip', () => {
  test('renders the timer and discard, and Discard fires onDiscard', () => {
    const onDiscard = jest.fn();
    render(<RecordingStrip displayLevels={[0.3, 0.6]} durationS={42} onDiscard={onDiscard} />);
    expect(screen.getByTestId('voice-recording-strip-timer').props.children).toBe('0:42');
    fireEvent.press(screen.getByTestId('voice-recording-strip-discard'));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});

describe('RecordingPill', () => {
  test('renders label + timer and Return fires onReturn', () => {
    const onReturn = jest.fn();
    render(<RecordingPill durationS={62} onReturn={onReturn} />);
    expect(screen.getByTestId('voice-recording-pill-timer').props.children).toBe('1:02');
    fireEvent.press(screen.getByTestId('voice-recording-pill'));
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  test('accepts a custom label (e.g. Sent)', () => {
    render(<RecordingPill durationS={5} onReturn={() => {}} label="Sent" />);
    expect(screen.getByText('Sent')).toBeTruthy();
  });
});
