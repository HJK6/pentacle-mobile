import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { Tabs } from 'expo-router';
import { Fonts, Tokens } from '@/constants/Colors';
import { logTabPressed } from '../../src/services/mobileTabsTelemetry';

function TabGlyph({ glyph, color }: { glyph: string; color: string }) {
  return <Text style={[styles.glyph, { color }]}>{glyph}</Text>;
}


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
          tabPress: () => logTabPressed('updates'),
        }}
        options={{
          // The tab is the Bart status surface (status-card spec); it no longer
          // shows notifications, so it carries no unread dot and marks nothing read.
          title: 'Bart',
          tabBarLabel: 'BART',
          tabBarIcon: ({ color }) => <TabGlyph glyph="⬡" color={color} />,
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
  glyph: {
    fontSize: 18,
    lineHeight: 22,
    marginBottom: -1,
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
