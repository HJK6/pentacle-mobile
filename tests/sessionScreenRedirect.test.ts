import React, { useEffect } from 'react';
import { act, render, type RenderAPI } from '@testing-library/react-native';
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
import {
  MISSING_SESSION_REDIRECT_MS,
  shouldArmRedirectTimer,
  type RedirectInputs,
} from '../src/services/sessionScreenRedirect';


const eligibleInputs: RedirectInputs = {
  isFocused: true,
  isReady: true,
  hasToken: true,
  hasSession: false,
  hasHydrated: true,
  connecting: false,
};

function RedirectHarness({
  inputs,
  onReplace,
}: {
  inputs: RedirectInputs;
  onReplace: (path: string) => void;
}) {
  useEffect(() => {
    if (!shouldArmRedirectTimer(inputs)) return undefined;
    const timer = setTimeout(() => {
      if (shouldArmRedirectTimer(inputs)) {
        onReplace('/chats');
      }
    }, MISSING_SESSION_REDIRECT_MS);
    return () => clearTimeout(timer);
  }, [inputs, onReplace]);

  return null;
}

test('shouldArmRedirectTimer only arms when every redirect precondition holds', () => {
  const keys = Object.keys(eligibleInputs) as (keyof RedirectInputs)[];
  for (let mask = 0; mask < 2 ** keys.length; mask += 1) {
    const inputs = { ...eligibleInputs };
    keys.forEach((key, index) => {
      if ((mask & (1 << index)) === 0) {
        inputs[key] = !eligibleInputs[key];
      }
    });

    const expected = keys.every((key) => inputs[key] === eligibleInputs[key]);
    expect(shouldArmRedirectTimer(inputs)).toBe(expected);
  }
});

test('redirect debounce waits for the missing-session settle window', () => {
  jest.useFakeTimers();
  const calls: string[] = [];
  let renderer: RenderAPI | undefined;

  renderer = render(React.createElement(RedirectHarness, {
      inputs: eligibleInputs,
      onReplace: (path) => calls.push(path),
    }));

  act(() => {
    jest.advanceTimersByTime(MISSING_SESSION_REDIRECT_MS - 1);
  });
  expect(calls).toEqual([]);

  act(() => {
    jest.advanceTimersByTime(1);
  });
  expect(calls).toEqual(['/chats']);

  act(() => {
    (renderer as RenderAPI).unmount();
  });
});

test('redirect debounce cancels when reconnect state changes before the window elapses', () => {
  jest.useFakeTimers();
  const cases: Array<{ name: string; inputs: RedirectInputs }> = [
    { name: 'connecting resumes', inputs: { ...eligibleInputs, connecting: true } },
    { name: 'session returns', inputs: { ...eligibleInputs, hasSession: true } },
    { name: 'focus is lost', inputs: { ...eligibleInputs, isFocused: false } },
  ];

  for (const item of cases) {
    const calls: string[] = [];
    let renderer: RenderAPI | undefined;

    renderer = render(React.createElement(RedirectHarness, {
        inputs: eligibleInputs,
        onReplace: (path) => calls.push(path),
      }));
    act(() => {
      jest.advanceTimersByTime(MISSING_SESSION_REDIRECT_MS - 1);
    });
    act(() => {
      (renderer as RenderAPI).update(React.createElement(RedirectHarness, {
        inputs: item.inputs,
        onReplace: (path) => calls.push(path),
      }));
    });
    act(() => {
      jest.advanceTimersByTime(MISSING_SESSION_REDIRECT_MS);
    });

    expect(calls).toEqual([]);

    act(() => {
      (renderer as RenderAPI).unmount();
    });
  }
});
