import './mocks';
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { FakeHousehold, flush, installServer, sendMock } from './support';

type StoreHook = typeof import('../../src/services/household/householdStore')['useHouseholdStore'];

const storeHook = (): StoreHook => require('../../src/services/household/householdStore').useHouseholdStore;

let initialState: unknown;

/** The real store, with its pristine state captured the first time it is loaded in this file. */
export function store(): StoreHook {
  const hook = storeHook();
  if (initialState === undefined) initialState = hook.getState();
  return hook;
}

/** Call from beforeEach: fake timers, a fresh fake daemon behind the RPC mock, a pristine store. */
export function resetWorld(server: FakeHousehold = new FakeHousehold()): FakeHousehold {
  jest.useFakeTimers();
  sendMock().mockReset();
  installServer(server);
  const hook = store();
  hook.setState(initialState as never, true);
  const { router } = require('expo-router');
  router.push.mockClear?.();
  router.replace.mockClear?.();
  router.back.mockClear?.();
  return server;
}

export type PersonalComponent =
  | 'PersonalHome'
  | 'ListsIndex'
  | 'ListDetail'
  | 'CalendarView'
  | 'AddEventSheet';

export function component(name: PersonalComponent): React.ComponentType<any> {
  return require(`../../src/components/personal/${name}`).default;
}

/** Load the snapshot into the store first (so screens render data), then mount and settle. */
export async function mount(name: PersonalComponent, props: Record<string, unknown> = {}, preload = true) {
  if (preload) await store().getState().refresh();
  const Screen = component(name);
  const utils = render(<Screen {...props} />);
  await flush();
  return utils;
}

export function navTargets(): string[] {
  const { router } = require('expo-router');
  const all = [...router.push.mock.calls, ...router.replace.mock.calls];
  return all.map((c: unknown[]) => JSON.stringify(c[0]));
}

export function backCalls(): number {
  return require('expo-router').router.back.mock.calls.length;
}

export function isDisabled(el: Parameters<typeof expect>[0]): boolean {
  try {
    expect(el).toBeDisabled();
    return true;
  } catch {
    return false;
  }
}

/** True when the control is absent or disabled (either way it cannot submit). */
export function isInert(el: ReturnType<typeof screen.queryByTestId>): boolean {
  return el === null || isDisabled(el);
}

export { fireEvent, screen, within };
