jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// Feed the chat-core package its hostconfig data source so the moved chat-model
// selectors (getHostOrder/getHostTheme) resolve through mobile's config/local
// exactly as before the move. config/local is `require`d LAZILY inside the
// provider functions (not imported at the top of this setup file) so that each
// suite's per-file `jest.mock('expo-constants', ...)` is in effect by the time
// config/local first reads Expo config — a top-level import here would bind
// config/local to the real expo-constants before any test file's mock applies.
import { setHostConfigProvider } from 'pentacle-chat-core';

setHostConfigProvider({
  getHostOrder: (state) =>
    (require('../src/config/local') as typeof import('../src/config/local')).getHostOrder(state),
  getHostTheme: (host) =>
    (require('../src/config/local') as typeof import('../src/config/local')).getHostTheme(host),
});

afterEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});
