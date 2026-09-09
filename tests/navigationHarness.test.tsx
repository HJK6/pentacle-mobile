import React from 'react';
import { Pressable, Text } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/core';
import { fireEvent } from '@testing-library/react-native';
import { createRoute, renderWithNavigation } from './helpers/navigationHarness';
jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));

function HarnessProbe() {
  const navigation = useNavigation() as { navigate: (name: string, params?: Record<string, unknown>) => void };
  const route = useRoute() as { params?: { streamId?: string } };
  return (
    <Pressable
      accessibilityRole="button"
      testID="harness-probe"
      onPress={() => navigation.navigate('Session', { streamId: route.params?.streamId })}
    >
      <Text>{String(route.params?.streamId || '')}</Text>
    </Pressable>
  );
}

test('renderWithNavigation provides route params and records navigation actions', () => {
  const { rendered, navigation } = renderWithNavigation(
    <HarnessProbe />,
    { route: createRoute('Chats', { streamId: 'alpha:codex:1' }) },
  );

  fireEvent.press(rendered.getByTestId('harness-probe'));

  expect(navigation.calls).toEqual([
    { name: 'navigate', args: ['Session', { streamId: 'alpha:codex:1' }] },
  ]);
});
