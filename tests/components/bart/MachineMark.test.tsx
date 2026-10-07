import React from 'react';
import { render } from '@testing-library/react-native';
import MachineMark from '../../../src/components/bart/MachineMark';
import MachineSigil from '../../../src/components/MachineSigil';
import { Circle } from 'react-native-svg';
import { Fonts, Tokens } from '../../../constants/Colors';

jest.mock('../../../src/config/local', () => ({ getMachineHostCount: () => 1, showMachineIcons: () => false }));

test('the djinni machine gets a muted B instead of the Bart-only lamp', () => {
  const view = render(<MachineMark machine="hosta" />);
  expect(view.queryByText('B')).toHaveStyle({ fontFamily: Fonts.cinzel.bold, color: Tokens.palette.dim });
  expect(view.UNSAFE_queryByType(MachineSigil)).toBeNull();
  expect(view.UNSAFE_getAllByType(Circle)[0].props.stroke).toBe(Tokens.palette.muted);
});

test('other machines keep their sigil and remain visible with a single-host roster', () => {
  const view = render(<MachineMark machine="hostc" />);
  expect(view.UNSAFE_getByType(MachineSigil).props).toMatchObject({ kind: 'mage', size: 38 * 0.62 });
  expect(view.queryByText('B')).toBeNull();
});
