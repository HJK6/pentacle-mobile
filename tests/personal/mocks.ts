// Device-boundary mocks shared by the P5 personal component suites. Import this file FIRST
// (`import './mocks'`). The household modules under test are loaded lazily inside tests so a
// missing module fails each test individually (RED) instead of the whole suite at import time.
// The only transport the household modules may use is sendHouseholdCommand.
jest.mock('../../src/services/pentacleStream', () => ({
  sendHouseholdCommand: jest.fn(),
}));

jest.mock('expo-router', () => {
  const ReactLocal = require('react');
  const { Pressable: PressableLocal } = require('react-native');
  const base = require('../helpers/mocks/expoRouter').makeMock();
  return {
    ...base,
    useFocusEffect: (cb: () => void | (() => void)) => ReactLocal.useEffect(cb, [cb]),
    Link: ({ href, children, onPress, ...rest }: any) =>
      ReactLocal.createElement(
        PressableLocal,
        {
          ...rest,
          onPress: (e: unknown) => {
            onPress?.(e);
            base.router.push(href);
          },
        },
        children,
      ),
  };
});

jest.mock('@react-navigation/native', () => {
  const ReactLocal = require('react');
  return {
    useIsFocused: () => true,
    useFocusEffect: (cb: () => void | (() => void)) => ReactLocal.useEffect(cb, [cb]),
    useNavigation: () => ({ goBack: jest.fn(), navigate: jest.fn() }),
  };
});

jest.mock('react-native-safe-area-context', () => {
  const { View: ViewLocal } = require('react-native');
  return {
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ViewLocal,
    SafeAreaProvider: ({ children }: { children?: unknown }) => children,
  };
});

jest.mock('@expo/vector-icons/FontAwesome', () => 'FontAwesome');

// The Bart lamp is the existing MachineSigil `djinni` kind (spec Target State). Each sigil
// renders a testID `sigil-<kind>` so tests can see exactly where the lamp is shown.
jest.mock('../../src/components/MachineSigil', () => {
  const ReactLocal = require('react');
  const { View: ViewLocal } = require('react-native');
  return {
    __esModule: true,
    default: (props: { kind: string }) =>
      ReactLocal.createElement(ViewLocal, { testID: `sigil-${props.kind}` }),
  };
});

export {};
