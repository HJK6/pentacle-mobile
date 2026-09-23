import React from 'react';
import { render } from '@testing-library/react-native';
import { MACHINE_ORDER, MACHINES, Tokens } from '../constants/Colors';
import MachineSigil from '../src/components/MachineSigil';

it('uses the five machine accents and keeps the app action green', () => {
  expect(MACHINE_ORDER).toEqual(['hosta', 'hostb', 'hostc', 'hostd', 'hoste']);
  expect(Object.fromEntries(MACHINE_ORDER.map(name => [name, MACHINES[name].accent]))).toEqual({
    hosta: '#1fbf4a', hostb: '#ff2e3e', hostc: '#1f5bff', hostd: '#a377a1', hoste: '#ffd60a',
  });
  expect(Tokens.palette.green).toBe('#3dff66');
});

it('renders the ibis with its beak, crescent, eye and legs', () => {
  const tree = render(<MachineSigil kind="ibis" color="#ffd60a" />);
  const paths = tree.UNSAFE_getAllByType(require('react-native-svg').Path);
  expect(paths.some(path => String(path.props.d).includes('M19.5 12.5 C12 16'))).toBe(true);
  expect(paths.some(path => String(path.props.d).includes('M52 5 A7.5'))).toBe(true);
  expect(paths.some(path => String(path.props.d).includes('M38 45 L37 52'))).toBe(true);
  const circles = tree.UNSAFE_getAllByType(require('react-native-svg').Circle);
  expect(circles.some(circle => circle.props.cx === '24.2' && circle.props.fill === '#ffd60a')).toBe(true);
});

it('accepts ibis in the production host sigil domain', () => {
  const { HOST_SIGIL_KINDS, guardProductionHostSigils } = require('../scripts/prod-build.cjs');
  expect([...HOST_SIGIL_KINDS].sort()).toEqual(Object.values(MACHINES).map(machine => machine.kind).sort());
  expect(() => guardProductionHostSigils({ hosts: { hoste: { label: 'Host E', color: '#ffd60a', sigil: 'ibis' } } })).not.toThrow();
});
