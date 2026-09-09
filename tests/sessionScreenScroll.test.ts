import { autoscrollTelemetryReason, planScroll, type ScrollInputs } from '../src/services/sessionScreenScroll';
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

const baseInputs: ScrollInputs = {
  hasInitialized: true,
  isAtBottom: true,
  isDragging: false,
  transcriptLength: 10,
  previousLength: 9,
};

test('planScroll preserves cold-start scroll when opening at bottom', () => {
  expect(planScroll({ ...baseInputs, hasInitialized: false })).toEqual({ kind: 'cold-start' });
});

test('planScroll returns growth for transcript length increases at bottom', () => {
  expect(planScroll({ ...baseInputs, previousLength: 9, transcriptLength: 10 })).toEqual({ kind: 'growth' });
  expect(planScroll({ ...baseInputs, previousLength: 10, transcriptLength: 11 })).toEqual({ kind: 'growth' });
  expect(planScroll({ ...baseInputs, previousLength: 11, transcriptLength: 12 })).toEqual({ kind: 'growth' });
});

test('planScroll suppresses every auto-scroll while dragging', () => {
  expect(planScroll({ ...baseInputs, hasInitialized: false, isDragging: true })).toEqual({ kind: 'none' });
  expect(planScroll({ ...baseInputs, hasInitialized: true, isDragging: true, previousLength: 1, transcriptLength: 20 })).toEqual({ kind: 'none' });
});

test('planScroll ignores identity changes without transcript growth', () => {
  expect(planScroll({ ...baseInputs, previousLength: 10, transcriptLength: 10 })).toEqual({ kind: 'none' });
});

test('planScroll leaves sticky-bottom pill behavior in control when not at bottom', () => {
  expect(planScroll({ ...baseInputs, isAtBottom: false, previousLength: 1, transcriptLength: 20 })).toEqual({ kind: 'none' });
});

test('autoscrollTelemetryReason explains every scroll decision branch', () => {
  expect(autoscrollTelemetryReason({ ...baseInputs, hasInitialized: false }, { kind: 'cold-start' })).toBe('cold-start');
  expect(autoscrollTelemetryReason(baseInputs, { kind: 'growth' })).toBe('growth');
  expect(autoscrollTelemetryReason({ ...baseInputs, isDragging: true }, { kind: 'none' })).toBe('user_dragging');
  expect(autoscrollTelemetryReason({ ...baseInputs, isAtBottom: false }, { kind: 'none' })).toBe('user_not_at_bottom');
  expect(autoscrollTelemetryReason({ ...baseInputs, previousLength: 10, transcriptLength: 10 }, { kind: 'none' })).toBe('no_transcript_growth');
  expect(autoscrollTelemetryReason({ ...baseInputs, previousLength: 11, transcriptLength: 10 }, { kind: 'none' })).toBe('no_transcript_growth');
  expect(autoscrollTelemetryReason(baseInputs, { kind: 'none' })).toBe('suppressed');
});
