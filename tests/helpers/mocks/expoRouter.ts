import React, { type ReactNode } from 'react';
import { Text } from 'react-native';

type RouterMockOptions = {
  params?: Record<string, unknown>;
  getParams?: () => Record<string, unknown>;
  router?: {
    push: (...args: any[]) => unknown;
    replace: (...args: any[]) => unknown;
    back: (...args: any[]) => unknown;
    canGoBack: () => boolean;
  };
};

const push = jest.fn();
const replace = jest.fn();
const back = jest.fn();
const canGoBack = jest.fn(() => true);
const redirect = jest.fn();
const stackScreens = jest.fn();
const stackRoot = jest.fn();
const tabScreens = jest.fn();

function createPassThrough() {
  return function PassThrough({ children }: { children?: ReactNode }) {
    return React.createElement(React.Fragment, null, children);
  };
}

// Like createPassThrough but records the root navigator's own props (e.g. the
// <Stack screenOptions={...}> default) so tests can assert navigator-level config.
function createRootRecorder(spy: jest.Mock) {
  return function RootRecorder({ children, ...props }: { children?: ReactNode }) {
    spy(props);
    return React.createElement(React.Fragment, null, children);
  };
}

function createScreenRecorder(spy: jest.Mock) {
  return (props: { name?: string; options?: { title?: string } }) => {
    const { name, options } = props;
    spy(props);
    return React.createElement(Text, null, options?.title || name || '');
  };
}

export function makeMock(options: RouterMockOptions = {}) {
  const router = options.router || { push, replace, back, canGoBack };

  return {
    useRouter: () => router,
    useLocalSearchParams: <T extends Record<string, unknown>>() => (options.getParams?.() || options.params || {}) as T,
    Redirect: ({ href }: { href: string }) => {
      redirect(href);
      return null;
    },
    Stack: Object.assign(createRootRecorder(stackRoot), { Screen: createScreenRecorder(stackScreens) }),
    Tabs: Object.assign(createPassThrough(), { Screen: createScreenRecorder(tabScreens) }),
    router,
    ErrorBoundary: createPassThrough(),
    __mock: {
      push,
      replace,
      back,
      canGoBack,
      redirect,
      stackScreens,
      stackRoot,
      tabScreens,
      router,
    },
  };
}
