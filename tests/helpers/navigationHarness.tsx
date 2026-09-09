import React, { type ReactElement, type ReactNode } from 'react';
import { NavigationContext, NavigationRouteContext, type ParamListBase, type RouteProp } from '@react-navigation/core';
import { render, type RenderAPI } from '@testing-library/react-native';

export type NavigationRecorder = {
  calls: Array<{ name: string; args: unknown[] }>;
  [key: string]: unknown;
};

export type MemoryRoute = {
  pathname: string;
  params: Record<string, unknown>;
};

export type MemoryStackHarness = {
  router: {
    push: jest.Mock;
    replace: jest.Mock;
    back: jest.Mock;
    canGoBack: jest.Mock<boolean, []>;
  };
  calls: Array<{ name: 'push' | 'replace' | 'back'; route?: MemoryRoute }>;
  current: () => MemoryRoute;
  routes: () => MemoryRoute[];
  reset: (routes: MemoryRoute[]) => void;
};

type RouterHref = string | { pathname: string; params?: Record<string, unknown> };

function memoryRoute(href: RouterHref): MemoryRoute {
  if (typeof href === 'string') return { pathname: href, params: {} };
  const params = { ...(href.params || {}) };
  return {
    pathname: href.pathname.replace(/\[([^\]]+)\]/g, (_match, key: string) => encodeURIComponent(String(params[key] ?? ''))),
    params,
  };
}

/**
 * Expo Router-compatible, stateful memory stack for navigation integration
 * tests. Unlike the call-recording mock, push/replace/back mutate the route
 * stack so a test can assert the final back-stack contract.
 */
export function createMemoryStackHarness(initialRoutes: MemoryRoute[] = [{ pathname: '/(tabs)/chats', params: {} }]): MemoryStackHarness {
  let stack = initialRoutes.map((route) => ({ pathname: route.pathname, params: { ...route.params } }));
  const calls: MemoryStackHarness['calls'] = [];
  const push = jest.fn((href: RouterHref) => {
    const route = memoryRoute(href);
    calls.push({ name: 'push', route });
    stack = [...stack, route];
  });
  const replace = jest.fn((href: RouterHref) => {
    const route = memoryRoute(href);
    calls.push({ name: 'replace', route });
    stack = stack.length ? [...stack.slice(0, -1), route] : [route];
  });
  const back = jest.fn(() => {
    calls.push({ name: 'back' });
    if (stack.length > 1) stack = stack.slice(0, -1);
  });
  const canGoBack = jest.fn(() => stack.length > 1);

  return {
    router: { push, replace, back, canGoBack },
    calls,
    current: () => ({ ...stack[stack.length - 1], params: { ...stack[stack.length - 1].params } }),
    routes: () => stack.map((route) => ({ ...route, params: { ...route.params } })),
    reset(routes) {
      stack = routes.map((route) => ({ pathname: route.pathname, params: { ...route.params } }));
    },
  };
}

export function createNavigationRecorder(): NavigationRecorder {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const record = (name: string) => (...args: unknown[]) => {
    calls.push({ name, args });
    return undefined;
  };

  return {
    calls,
    addListener: () => () => undefined,
    canGoBack: () => false,
    dispatch: record('dispatch'),
    getId: () => undefined,
    getParent: () => undefined,
    getState: () => ({ key: 'test-state', index: 0, routeNames: ['Test'], routes: [{ key: 'test-route', name: 'Test' }], type: 'stack', stale: false }),
    goBack: record('goBack'),
    isFocused: () => true,
    navigate: record('navigate'),
    pop: record('pop'),
    popToTop: record('popToTop'),
    push: record('push'),
    removeListener: () => undefined,
    replace: record('replace'),
    reset: record('reset'),
    setOptions: record('setOptions'),
    setParams: record('setParams'),
  };
}

export function createRoute(name = 'Test', params: Record<string, unknown> = {}): RouteProp<ParamListBase> {
  return {
    key: `${name}-route`,
    name,
    params,
  };
}

export function NavigationTestProvider({
  children,
  navigation = createNavigationRecorder(),
  route = createRoute(),
}: {
  children: ReactNode;
  navigation?: NavigationRecorder;
  route?: RouteProp<ParamListBase>;
}) {
  return (
    <NavigationContext.Provider value={navigation as never}>
      <NavigationRouteContext.Provider value={route}>
        {children}
      </NavigationRouteContext.Provider>
    </NavigationContext.Provider>
  );
}

export function renderWithNavigation(
  element: ReactElement,
  options: {
    navigation?: NavigationRecorder;
    route?: RouteProp<ParamListBase>;
  } = {},
): { rendered: RenderAPI; navigation: NavigationRecorder; route: RouteProp<ParamListBase> } {
  const navigation = options.navigation || createNavigationRecorder();
  const route = options.route || createRoute();

  const rendered = render(
    <NavigationTestProvider navigation={navigation} route={route}>
      {element}
    </NavigationTestProvider>,
  );

  return { rendered, navigation, route };
}
