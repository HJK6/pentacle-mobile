import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Tabs } from 'expo-router';
import { Fonts, Tokens } from '@/constants/Colors';
import { markRead, useHasUnreadNotification } from '../../src/hooks/useUnreadNotifications';
import { logTabPressed } from '../../src/services/mobileTabsTelemetry';

function TabGlyph({ glyph, color }: { glyph: string; color: string }) {
  return <Text style={[styles.glyph, { color }]}>{glyph}</Text>;
}

const UpdatesTabIcon = React.memo(function UpdatesTabIcon({ color }: { color: string }) {
  const hasUnreadUpdates = useHasUnreadNotification('system');

  return (
    <View style={styles.iconWrap}>
      <TabGlyph glyph="⬡" color={color} />
      {hasUnreadUpdates ? <View testID="updates-unread-dot" style={styles.unreadDot} /> : null}
    </View>
  );
});

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: Tokens.palette.green,
        tabBarInactiveTintColor: Tokens.palette.muted,
        tabBarLabelStyle: styles.label,
        tabBarStyle: {
          backgroundColor: Tokens.palette.ink,
          borderTopColor: Tokens.palette.line,
          borderTopWidth: 1,
          elevation: 0,
          shadowOpacity: 0,
        },
        tabBarItemStyle: styles.item,
        headerStyle: { backgroundColor: Tokens.palette.panel },
        headerTintColor: Tokens.palette.text,
      }}
    >
      <Tabs.Screen
        name="unified"
        options={{
          href: null,
        }}
      />
      <Tabs.Screen
        name="chats"
        listeners={{
          tabPress: () => logTabPressed('chats'),
        }}
        options={{
          title: 'Agents',
          tabBarLabel: 'AGENTS',
          tabBarIcon: ({ color }) => <TabGlyph glyph="◈" color={color} />,
        }}
      />
      <Tabs.Screen
        name="dashboards"
        listeners={{
          tabPress: () => logTabPressed('dashboards'),
        }}
        options={{
          title: 'Dashboards',
          tabBarLabel: 'BOARDS',
          tabBarButtonTestID: 'dashboards-tab-button',
          tabBarIcon: ({ color }) => <TabGlyph glyph="▦" color={color} />,
        }}
      />
      <Tabs.Screen
        name="updates"
        listeners={{
          tabPress: () => {
            logTabPressed('updates');
            markRead('system');
          },
        }}
        options={{
          title: 'Updates',
          tabBarLabel: 'UPDATES',
          tabBarIcon: ({ color }) => <UpdatesTabIcon color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        listeners={{
          tabPress: () => logTabPressed('settings'),
        }}
        options={{
          title: 'Settings',
          tabBarLabel: 'SETTINGS',
          tabBarIcon: ({ color }) => <TabGlyph glyph="⊹" color={color} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  iconWrap: {
    position: 'relative',
    minWidth: 24,
    minHeight: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: {
    fontSize: 18,
    lineHeight: 22,
    marginBottom: -1,
  },
  unreadDot: {
    position: 'absolute',
    top: 1,
    right: 2,
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: Tokens.palette.amber,
  },
  label: {
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 9,
    letterSpacing: 0.5,
  },
  item: {
    paddingTop: 5,
  },
});
