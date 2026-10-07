import React from 'react';
import { StyleSheet, Text } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { Tabs } from 'expo-router';
import { PlatformPressable } from '@react-navigation/elements';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Fonts, Tokens } from '@/constants/Colors';
import { AssistantIcon } from '../../src/components/bart/assistantIdentity';
import { useAssistantIdentity } from '../../src/services/assistantIdentity';
import { logTabPressed } from '../../src/services/mobileTabsTelemetry';

function PersonIcon({ color }: { color: string }) {
  return <Svg testID="bart-tab-person" width={20} height={20} viewBox="0 0 24 24"
    fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <Circle cx={12} cy={8} r={3.5} /><Path d="M5 20c1-3.6 3.8-5.5 7-5.5s6 1.9 7 5.5" />
  </Svg>;
}

function GridIcon({ color }: { color: string }) {
  return <Svg testID="bart-tab-grid" width={20} height={20} viewBox="0 0 24 24"
    fill="none" stroke={color} strokeWidth={2}>
    <Rect x={4} y={4} width={7} height={9} rx={1} /><Rect x={13} y={4} width={7} height={5} rx={1} />
    <Rect x={13} y={11} width={7} height={9} rx={1} /><Rect x={4} y={15} width={7} height={5} rx={1} />
  </Svg>;
}

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const identity = useAssistantIdentity();
  const bottom = Math.max(insets.bottom, 22);
  return <Tabs initialRouteName="bart" screenOptions={{
    headerShown: false,
    tabBarHideOnKeyboard: true,
    tabBarActiveTintColor: Tokens.palette.green,
    tabBarInactiveTintColor: Tokens.palette.muted,
    tabBarLabelStyle: styles.label,
    tabBarStyle: [styles.bar, { height: 47 + bottom, paddingBottom: bottom, paddingLeft: insets.left, paddingRight: insets.right }],
    tabBarLabelPosition: 'below-icon',
    tabBarIconStyle: styles.icon,
    tabBarButton: (props) => <PlatformPressable {...props} style={[props.style, styles.button]} />,
  }}>
    <Tabs.Screen name="bart" listeners={{ tabPress: () => logTabPressed('bart') }} options={{
      title: identity.name, tabBarLabel: identity.name.toUpperCase(), tabBarButtonTestID: 'bart-tab-button',
      tabBarIcon: ({ color }) => <AssistantIcon identity={identity} size={22} color={color} />,
    }} />
    <Tabs.Screen name="personal" listeners={{ tabPress: () => logTabPressed('personal') }} options={{
      title: 'Personal', tabBarLabel: 'PERSONAL', tabBarButtonTestID: 'personal-tab-button',
      tabBarIcon: ({ color }) => <PersonIcon color={color} />,
    }} />
    <Tabs.Screen name="dashboards" listeners={{ tabPress: () => logTabPressed('dashboards') }} options={{
      title: 'Dashboards', tabBarLabel: 'DASHBOARDS', tabBarButtonTestID: 'dashboards-tab-button',
      tabBarIcon: ({ color }) => <GridIcon color={color} />,
    }} />
    <Tabs.Screen name="settings" listeners={{ tabPress: () => logTabPressed('settings') }} options={{
      title: 'Settings', tabBarLabel: 'SETTINGS', tabBarButtonTestID: 'settings-tab-button',
      tabBarIcon: ({ color }) => <Text style={[styles.settings, { color }]}>⊹</Text>,
    }} />
    <Tabs.Screen name="chats" options={{ href: null }} />
    <Tabs.Screen name="unified" options={{ href: null }} />
    <Tabs.Screen name="updates" options={{ href: null }} />
  </Tabs>;
}

const styles = StyleSheet.create({
  bar: {
    height: 69, paddingTop: 9, paddingBottom: 22, paddingHorizontal: 0,
    backgroundColor: Tokens.palette.ink, borderTopColor: Tokens.palette.line,
    borderTopWidth: 1, elevation: 0, shadowOpacity: 0,
  },
  label: { fontFamily: Fonts.jetBrainsMono.medium, fontSize: 9, lineHeight: 11, letterSpacing: 0.5 },
  button: { padding: 0, gap: 3 },
  icon: { width: 22, height: 22 },
  settings: { fontSize: 18, lineHeight: 20 },
});
