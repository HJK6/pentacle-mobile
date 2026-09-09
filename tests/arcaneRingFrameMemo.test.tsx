import React from 'react';
import { render } from '@testing-library/react-native';

// Count how many times the (expensive) sigil child actually renders. If
// ArcaneRingFrame is memoized, a re-render with unchanged props must not re-run
// its body — so the sigil renders once, not per parent re-render.
const mockSigilRenders = jest.fn();
jest.mock('../src/components/MachineSigil', () => ({
  __esModule: true,
  default: (props: any) => {
    mockSigilRenders();
    return null;
  },
}));
jest.mock('react-native-svg', () => ({
  __esModule: true,
  default: ({ children }: any) => children ?? null,
  Svg: ({ children }: any) => children ?? null,
  Circle: () => null,
  Line: () => null,
}));

import ArcaneRingFrame from '../src/components/ArcaneRingFrame';

beforeEach(() => mockSigilRenders.mockClear());

// Spec tap_shell_layout_regression_build_1155 slice 2b: ArcaneRingFrame is one
// per all-chats row; its inputs don't change when a row's preview text updates.
// Re-rendering its SVG for every changed row under burst load dominated the
// React commit that kept all_chats set_state_ms over budget. Memoization must
// skip the body on unchanged props (RED before React.memo, GREEN after).
test('ArcaneRingFrame is memoized: unchanged props do not re-render the sigil SVG', () => {
  const { rerender } = render(<ArcaneRingFrame machine={'hostc' as any} size={54} sigilSize={34} />);
  expect(mockSigilRenders).toHaveBeenCalledTimes(1);

  // Parent re-render with identical primitive props (what a sibling row's
  // preview-text update triggers) — memo must short-circuit.
  rerender(<ArcaneRingFrame machine={'hostc' as any} size={54} sigilSize={34} />);
  expect(mockSigilRenders).toHaveBeenCalledTimes(1);

  // A genuine prop change still re-renders.
  rerender(<ArcaneRingFrame machine={'hosta' as any} size={54} sigilSize={34} />);
  expect(mockSigilRenders).toHaveBeenCalledTimes(2);
});

test('ArcaneRingFrame default export is a React.memo component', () => {
  expect((ArcaneRingFrame as any).$$typeof).toBe(Symbol.for('react.memo'));
});
