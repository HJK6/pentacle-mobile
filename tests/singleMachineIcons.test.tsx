import React from 'react';
import { render } from '@testing-library/react-native';
import ArcaneRingFrame from '../src/components/ArcaneRingFrame';
import MachineSigil from '../src/components/MachineSigil';
import { MachineRosterContext } from '../src/components/MachineRosterContext';
import { getMachineHostCount, showMachineIcons } from '../src/config/local';

jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {
  hosts: { laptop: { color: '#1f5bff' } }, hostOrder: ['laptop', 'laptop'],
} } } }));

for (const count of [1, 2]) for (const condition of [true, false]) {
  test(`${count} host(s), single-host condition ${condition}: icons ${count === 1 && condition ? 'absent' : 'present'}`, () => {
    expect(showMachineIcons(count, condition)).toBe(!(count === 1 && condition));
    // Automatic production wiring: the condition is exactly-one-host.
    const tree = render(<MachineRosterContext.Provider value={{ hostCount: count, singleHostCondition: condition }}>
      <ArcaneRingFrame machine="hostc" />
    </MachineRosterContext.Provider>);
    expect(tree.UNSAFE_queryAllByType(MachineSigil)).toHaveLength(count === 1 && condition ? 0 : 1);
    expect(tree.queryAllByTestId('machine-icon')).toHaveLength(count === 1 && condition ? 0 : 1);
  });
}
test('live second host restores icons; offline configured host and identity do not skew count', () => {
  expect(getMachineHostCount()).toBe(1);
  const state = { hosts: { server: { host: 'server', online: false }, identity: { host: 'bart' } }, sessions: [], machineStats: {} };
  expect(getMachineHostCount(state as any)).toBe(2);
  const tree = render(<MachineRosterContext.Provider value={{ hostCount: 1 }}><ArcaneRingFrame machine="hostc" /></MachineRosterContext.Provider>);
  expect(tree.queryByTestId('machine-icon')).toBeNull();
  tree.rerender(<MachineRosterContext.Provider value={{ hostCount: 2 }}><ArcaneRingFrame machine="hostc" /></MachineRosterContext.Provider>);
  expect(tree.getByTestId('machine-icon')).toBeTruthy();
});
test('assistant artwork and explicit child content remain in a single-host fleet', () => {
  const tree = render(<MachineRosterContext.Provider value={{ hostCount: 1 }}><ArcaneRingFrame identity machine="hosta" /></MachineRosterContext.Provider>);
  expect(tree.UNSAFE_queryAllByType(MachineSigil)).toHaveLength(1);
});
