import React from 'react';
import { Text } from 'react-native';
import { render } from '@testing-library/react-native';
import ArcaneRingFrame from '../src/components/ArcaneRingFrame';
import Bevel from '../src/components/Bevel';
import MachineSigil from '../src/components/MachineSigil';
import ProviderTag from '../src/components/ProviderTag';
import SevTag from '../src/components/SevTag';
import Starfield from '../src/components/Starfield';
import StatusTag from '../src/components/StatusTag';
import { Bar, Brackets, Pill, Spark, Spinner } from '../src/components/ArcaneAtoms';
import { STATUS, Tokens, type MachineSigilKind } from '../constants/Colors';

const sigilKinds: MachineSigilKind[] = ['djinni', 'sun', 'mage', 'flower'];

test('arcane SVG component library renders without throwing', () => {
  for (const kind of sigilKinds) {
    expect(() => render(<MachineSigil kind={kind} />)).not.toThrow();
  }

  expect(() =>
    render(
      <>
        <Starfield />
        <ArcaneRingFrame machine="hosta" />
        <Bevel style={{ width: 160, minHeight: 48 }}>
          <Text>beveled content</Text>
        </Bevel>
        <ProviderTag provider="CLAUDE" color={Tokens.palette.green} />
        <ProviderTag provider="codex" color={Tokens.palette.green} />
        <StatusTag status="WORKING" />
        <StatusTag status="idle" />
        <SevTag severity="INFO" />
        <SevTag severity="WARNING" />
        <SevTag severity="CRITICAL" />
        <Spark />
        <Brackets />
        <Spinner />
        <Bar pct={67} color={Tokens.palette.green} />
        <Pill>READY</Pill>
      </>,
    ),
  ).not.toThrow();
});

test('StatusTag renders icon-only universal status colors', () => {
  const svg = require('react-native-svg');

  const working = render(<StatusTag status="WORKING" color="#ff2e3e" />);
  expect(working.queryByText(/working/i)).toBeNull();
  expect(working.getByTestId('status-tag-working')).toBeTruthy();
  expect(working.UNSAFE_getAllByType(svg.Circle).some((node) => node.props.stroke === STATUS.working)).toBe(true);
  working.unmount();

  const idle = render(<StatusTag status="idle" color={Tokens.palette.muted} />);
  expect(idle.queryByText(/idle/i)).toBeNull();
  expect(idle.getByTestId('status-tag-idle')).toBeTruthy();
  const idleCircle = idle.UNSAFE_getByType(svg.Circle);
  expect(idleCircle.props.stroke).toBe(STATUS.idle);
  expect(idleCircle.props.fill).toBe('none');
});

test('StatusTag renders a compact working elapsed timer only when provided', () => {
  const working = render(<StatusTag status="working" elapsedSeconds={65} />);
  expect(working.getByTestId('status-tag-elapsed').props.children).toBe('01:05');
  working.unmount();

  const idle = render(<StatusTag status="idle" elapsedSeconds={65} />);
  expect(idle.queryByTestId('status-tag-elapsed')).toBeNull();
});
