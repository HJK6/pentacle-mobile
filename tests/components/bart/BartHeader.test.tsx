import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import BartHeader from '../../../src/components/bart/BartHeader';
import MachineSigil from '../../../src/components/MachineSigil';
import { Fonts } from '../../../constants/Colors';

const props = { identity: { assistantName: 'Lews', icon: { host: 'hostc', kind: 'djinni' as const, color: '#1f5bff' } }, others: 2, pending: 4, lanes: 3, working: true, top: 52,
  onDrawer: jest.fn(), onStatus: jest.fn(), onQuestions: jest.fn() };

test('renders Bart identity, lamp, lanes, authoritative counts and existing status tag', () => {
  const view = render(<BartHeader {...props} />);
  expect(view.getByText('Lews')).toBeTruthy();
  expect(view.getByText('3 LANES')).toBeTruthy();
  expect(view.getByTestId('status-tag-working')).toBeTruthy();
  expect(view.getByTestId('bart-sessions-badge').props.children).toBe(2);
  expect(view.getByTestId('bart-questions-badge').props.children).toBe(4);
  expect(view.UNSAFE_getByType(MachineSigil).props).toMatchObject({ kind: 'djinni', color: '#1f5bff' });
  fireEvent.press(view.getByLabelText('Sessions, 2 need you'));
  fireEvent.press(view.getByLabelText('Lews status, 3 open lanes'));
  fireEvent.press(view.getByLabelText('Questions, 4 pending'));
  expect(props.onDrawer).toHaveBeenCalledTimes(1);
  expect(props.onStatus).toHaveBeenCalledTimes(1);
  expect(props.onQuestions).toHaveBeenCalledTimes(1);
});

test('zero hides each badge without hiding the controls', () => {
  const view = render(<BartHeader {...props} others={0} pending={0} lanes={0} working={false} />);
  expect(view.queryByTestId('bart-sessions-badge')).toBeNull();
  expect(view.queryByTestId('bart-questions-badge')).toBeNull();
  expect(view.getByLabelText('Sessions, 0 need you')).toBeTruthy();
  expect(view.getByLabelText('Questions, 0 pending')).toBeTruthy();
  expect(view.getByTestId('status-tag-idle')).toBeTruthy();
});

test('header and badges retain approved geometry, safe top, and typography', () => {
  const view = render(<BartHeader {...props} top={60} />);
  expect(StyleSheet.flatten(view.getByTestId('bart-header').props.style)).toMatchObject({
    paddingTop: 60, paddingHorizontal: 12, paddingBottom: 12, borderBottomColor: '#3dff6633',
  });
  expect(StyleSheet.flatten(view.getByLabelText('Sessions, 2 need you').props.style)).toMatchObject({
    width: 40, height: 40, borderRadius: 4, borderWidth: 1, backgroundColor: 'rgba(8,11,10,0.7)',
  });
  expect(StyleSheet.flatten(view.getByTestId('bart-questions-badge').props.style)).toMatchObject({
    fontFamily: Fonts.jetBrainsMono.bold, fontSize: 10, height: 17, backgroundColor: '#ffb53d', color: '#080b0a',
  });
});
