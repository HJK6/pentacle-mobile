import React from 'react';
import { render } from '@testing-library/react-native';

// Count how many times the (expensive) SVG Path actually renders. If the bevel
// frame is split into a memoized component, a re-render with unchanged frame
// props must not re-run the SVG — so the Path renders once, not per parent
// re-render.
const mockPathRenders = jest.fn();
jest.mock('react-native-svg', () => ({
  __esModule: true,
  default: ({ children }: any) => children ?? null,
  Svg: ({ children }: any) => children ?? null,
  Path: (props: any) => {
    mockPathRenders();
    return null;
  },
}));

import { BevelFrame } from '../src/components/Bevel';

beforeEach(() => mockPathRenders.mockClear());

// Spec tap_shell_layout_regression_build_1155 slice 3: Bevel is the card frame
// for every all-chats row. Its SVG Path depends only on layout size + fill/
// stroke, none of which change when a row's preview text / time updates. Before
// this slice the Path was inline in Bevel and re-rendered for every changed row
// under burst load, part of the React commit that kept all_chats set_state_ms
// over budget. The frame must short-circuit on unchanged props (RED when the
// SVG was inline / un-memoized, GREEN after the memoized BevelFrame split).
const FRAME = { width: 100, height: 40, path: 'M0 0 H88 L100 12 V40 H12 L0 28 Z', strokeWidth: 1 };

test('BevelFrame is memoized: a message-only update does not re-render the SVG Path', () => {
  const { rerender } = render(
    <BevelFrame {...FRAME} fill="rgba(255,255,255,0.018)" stroke="#222" />,
  );
  expect(mockPathRenders).toHaveBeenCalledTimes(1);

  // Parent re-render with identical frame props — what a sibling row's preview
  // text / time update triggers on the shared list. memo must short-circuit.
  rerender(<BevelFrame {...FRAME} fill="rgba(255,255,255,0.018)" stroke="#222" />);
  expect(mockPathRenders).toHaveBeenCalledTimes(1);

  // A genuine frame change (attention flips the fill/stroke) still re-renders.
  rerender(<BevelFrame {...FRAME} fill="#00e5ff14" stroke="#00e5ff55" />);
  expect(mockPathRenders).toHaveBeenCalledTimes(2);
});

test('BevelFrame renders nothing before layout (empty path)', () => {
  render(<BevelFrame width={0} height={0} path="" fill="#111" stroke="#222" strokeWidth={1} />);
  expect(mockPathRenders).toHaveBeenCalledTimes(0);
});

test('BevelFrame is a React.memo component', () => {
  expect((BevelFrame as any).$$typeof).toBe(Symbol.for('react.memo'));
});
