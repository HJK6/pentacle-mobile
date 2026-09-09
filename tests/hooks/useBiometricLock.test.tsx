import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react-native';

let mockAppStateCurrentState = 'active';
let mockAppStateListener: ((state: string) => void) | undefined;
const mockRemove = jest.fn();
const mockAddEventListener = jest.fn((_event: string, listener: (state: string) => void) => {
  mockAppStateListener = listener;
  return { remove: mockRemove };
});
const mockPlatform = { OS: 'ios' };

jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(),
  isEnrolledAsync: jest.fn(),
  authenticateAsync: jest.fn(),
}));

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'AppState') return {
        get currentState() {
          return mockAppStateCurrentState;
        },
        addEventListener: mockAddEventListener,
      };
      if (prop === 'Platform') return mockPlatform;
      return target[prop as keyof typeof target];
    },
  });
});

function loadHook() {
  jest.resetModules();
  jest.doMock('react', () => React);
  const hook = require('../../src/hooks/useBiometricLock').default as typeof import('../../src/hooks/useBiometricLock').default;
  const auth = require('expo-local-authentication');
  auth.hasHardwareAsync.mockResolvedValue(true);
  auth.isEnrolledAsync.mockResolvedValue(true);
  auth.authenticateAsync.mockResolvedValue({ success: true });
  return hook;
}

function localAuth() {
  return require('expo-local-authentication');
}

beforeEach(() => {
  delete process.env.EXPO_PUBLIC_DISABLE_BIOMETRIC_LOCK;
  delete process.env.EXPO_PUBLIC_HARNESS;
  delete process.env.EXPO_PUBLIC_HARNESS_AUTOACCEPT_BIOMETRIC;
  mockAppStateCurrentState = 'active';
  mockAppStateListener = undefined;
  mockPlatform.OS = 'ios';
});

test('prompts when hardware is available and app returns from background to foreground', async () => {
  const useBiometricLock = loadHook();
  const { result } = renderHook(() => useBiometricLock('Pentacle'));

  await waitFor(() => expect(result.current.locked).toBe(false));
  expect(localAuth().authenticateAsync).toHaveBeenCalledTimes(1);

  act(() => {
    mockAppStateListener?.('background');
  });
  expect(result.current.locked).toBe(true);

  await act(async () => {
    mockAppStateListener?.('active');
  });

  expect(localAuth().authenticateAsync).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(result.current.locked).toBe(false));
});

test('coalesces mount and foreground authentication into one biometric prompt', async () => {
  const useBiometricLock = loadHook();
  const telemetry = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const { TELEMETRY_EVENTS } = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const seen: import('pentacle-chat-core').TelemetryPayload[] = [];
  let resolveHardware!: (value: boolean) => void;
  localAuth().hasHardwareAsync.mockReturnValue(new Promise((resolve) => {
    resolveHardware = resolve;
  }));
  telemetry.setTelemetrySink((payload) => seen.push(payload));

  renderHook(() => useBiometricLock('Pentacle'));

  act(() => {
    mockAppStateListener?.('background');
    mockAppStateListener?.('active');
  });

  await act(async () => {
    resolveHardware(true);
  });

  await waitFor(() => expect(localAuth().authenticateAsync).toHaveBeenCalledTimes(1));
  expect(seen.filter((payload) => payload.message === TELEMETRY_EVENTS.AUTH_BIOMETRIC_PROMPT_SCHEDULED)).toHaveLength(1);
  telemetry.setTelemetrySink(null);
});

test('falls back to unlocked when biometric hardware is unavailable', async () => {
  const useBiometricLock = loadHook();
  localAuth().hasHardwareAsync.mockResolvedValue(false);

  const { result } = renderHook(() => useBiometricLock());

  await waitFor(() => expect(result.current.locked).toBe(false));
  expect(localAuth().authenticateAsync).not.toHaveBeenCalled();
});

test('stays locked when the user cancels authentication', async () => {
  const useBiometricLock = loadHook();
  localAuth().authenticateAsync.mockResolvedValue({ success: false });

  const { result } = renderHook(() => useBiometricLock());

  await waitFor(() => expect(localAuth().authenticateAsync).toHaveBeenCalled());
  expect(result.current.locked).toBe(true);
});

test('unlocks when authentication succeeds', async () => {
  const useBiometricLock = loadHook();

  const { result } = renderHook(() => useBiometricLock());

  await waitFor(() => expect(result.current.locked).toBe(false));
});

test('respects EXPO_PUBLIC_DISABLE_BIOMETRIC_LOCK', async () => {
  process.env.EXPO_PUBLIC_DISABLE_BIOMETRIC_LOCK = '1';
  const useBiometricLock = loadHook();

  const { result } = renderHook(() => useBiometricLock());

  expect(result.current.locked).toBe(false);
  await Promise.resolve();
  expect(localAuth().authenticateAsync).not.toHaveBeenCalled();
});

test('bypasses authenticateAsync and synthesizes success when EXPO_PUBLIC_HARNESS=1 + autoaccept_biometric is armed', async () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const useBiometricLock = loadHook();
  const telemetry = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const harnessRuntime = require('../../src/utils/harnessRuntime') as typeof import('../../src/utils/harnessRuntime');
  const { TELEMETRY_EVENTS } = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const seen: import('pentacle-chat-core').TelemetryPayload[] = [];
  telemetry.setTelemetrySink((payload) => seen.push(payload));

  // Simulate the cold-launch URL arming firing BEFORE the biometric mount
  // effect — i.e. applyURL has resolved and isArmed() reads true.
  harnessRuntime.applyURL('pentacle://harness?actions=autoaccept_biometric&scenario=biometric_lock_resume');

  const { result } = renderHook(() => useBiometricLock());

  // Lock unwinds without any iOS prompt.
  await waitFor(() => expect(result.current.locked).toBe(false));
  expect(localAuth().authenticateAsync).not.toHaveBeenCalled();

  // harness:autoaccept_biometric_scheduled fires, then synthetic
  // auth:biometric_prompt_resolved with outcome: 'success' and harness: true.
  expect(seen).toEqual(expect.arrayContaining([
    expect.objectContaining({
      message: TELEMETRY_EVENTS.HARNESS_AUTOACCEPT_BIOMETRIC_SCHEDULED,
      data: expect.objectContaining({
        trigger: 'mount',
        platform: 'ios',
      }),
    }),
    expect.objectContaining({
      message: TELEMETRY_EVENTS.AUTH_BIOMETRIC_PROMPT_RESOLVED,
      data: expect.objectContaining({
        trigger: 'mount',
        outcome: 'success',
        platform: 'ios',
        harness: true,
      }),
    }),
  ]));
  telemetry.setTelemetrySink(null);
  harnessRuntime.reset();
});

test('does NOT emit harness biometric telemetry when EXPO_PUBLIC_HARNESS=1 but action not armed (mount-time race acceptable)', async () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  const useBiometricLock = loadHook();
  const telemetry = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const harnessRuntime = require('../../src/utils/harnessRuntime') as typeof import('../../src/utils/harnessRuntime');
  const { TELEMETRY_EVENTS } = require('pentacle-chat-core') as typeof import('pentacle-chat-core');
  const seen: import('pentacle-chat-core').TelemetryPayload[] = [];
  telemetry.setTelemetrySink((payload) => seen.push(payload));

  // No applyURL — the mount auth runs while isArmed() is still false.
  // Per harness_runtime_alignment §Biometric mount-time race clarification:
  // the harness telemetry MAY skip for this call; auth flow proceeds normally.
  const { result } = renderHook(() => useBiometricLock());

  await waitFor(() => expect(result.current.locked).toBe(false));
  expect(localAuth().authenticateAsync).toHaveBeenCalledTimes(1);
  // Base-app event still fires.
  expect(seen.find((p) => p.message === TELEMETRY_EVENTS.AUTH_BIOMETRIC_PROMPT_SCHEDULED)).toBeDefined();
  // Harness-only event does NOT fire because isArmed()=false at the moment of read.
  expect(seen.find((p) => p.message === TELEMETRY_EVENTS.HARNESS_AUTOACCEPT_BIOMETRIC_SCHEDULED)).toBeUndefined();
  telemetry.setTelemetrySink(null);
  harnessRuntime.reset();
});
