import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { Tokens } from '@/constants/Colors';
import { createDesignEmbed, isDesignEmbedNavigationAllowed, type DesignWebViewRequest } from '../../../src/features/dashboards/designEmbed';
import { getHostedDashboardPolicy } from '../../../src/services/pentacleStream';

type RouteParams = {
  dashboardId?: string | string[];
  projectId?: string | string[];
  designId?: string | string[];
  viewId?: string | string[];
};

export default function DashboardScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { dashboardId, projectId, designId, viewId } = useLocalSearchParams<RouteParams>();

  const showDesign = dashboardId === 'design';
  const title = showDesign ? 'Design' : 'Dashboard';
  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.canGoBack() ? router.back() : router.replace('/dashboards')}
          style={styles.back}
        >
          <Text style={styles.backLabel}>‹</Text>
        </Pressable>
        <Text accessibilityRole="header" style={styles.title}>{title}</Text>
      </View>
      {showDesign ? (
        <DesignEmbed
          key={JSON.stringify([projectId, designId, viewId])}
          projectId={projectId}
          designId={designId}
          viewId={viewId}
        />
      ) : (
        <View style={styles.status}><Text style={styles.message}>Dashboard unavailable</Text></View>
      )}
    </View>
  );
}

function DesignEmbed(target: Omit<RouteParams, 'dashboardId'>) {
  const resolve = () => createDesignEmbed(getHostedDashboardPolicy(), target);
  const [source, setSource] = useState(resolve);

  if (!source) {
    return (
      <View style={styles.status}>
        <Text accessibilityLiveRegion="polite" style={styles.message}>Design did not load</Text>
        <Pressable accessibilityRole="button" onPress={() => setSource(resolve())} style={styles.retry}>
          <Text style={styles.retryLabel}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  const { origin, uri } = source;
  const fail = () => setSource(current => current === source ? null : current);
  return (
    <WebView
      testID="design-webview"
      source={{ uri }}
      style={styles.webview}
      // Route every URL to our exact guard. Whitelist misses in the wrapper invoke the system opener.
      originWhitelist={['*']}
      onShouldStartLoadWithRequest={(request: DesignWebViewRequest) => {
        const allowed = isDesignEmbedNavigationAllowed(origin, request);
        if (!allowed && request.isTopFrame !== false && request.hasTargetFrame !== false) fail();
        return allowed;
      }}
      onOpenWindow={() => {
        // Discard popup requests inside the app.
      }}
      javaScriptCanOpenWindowsAutomatically={false}
      sharedCookiesEnabled={false}
      thirdPartyCookiesEnabled={false}
      incognito
      allowFileAccess={false}
      mixedContentMode="never"
      allowsBackForwardNavigationGestures={false}
      startInLoadingState
      renderLoading={() => (
        <View style={styles.status}>
          <ActivityIndicator accessibilityLabel="Loading Design" color={Tokens.palette.green} />
        </View>
      )}
      onHttpError={({ nativeEvent }) => {
        if (nativeEvent.statusCode >= 400 && isDesignEmbedNavigationAllowed(origin, nativeEvent)) fail();
      }}
      onError={fail}
      onContentProcessDidTerminate={fail}
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Tokens.palette.ink },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Tokens.palette.line,
  },
  back: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  backLabel: { color: Tokens.palette.text, fontSize: 28 },
  title: { color: Tokens.palette.text, fontSize: 18, fontWeight: '600' },
  webview: { flex: 1, backgroundColor: Tokens.palette.ink },
  status: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12, backgroundColor: Tokens.palette.ink },
  message: { color: Tokens.palette.text, fontSize: 16 },
  retry: { justifyContent: 'center', minHeight: 44, paddingHorizontal: 16 },
  retryLabel: { color: Tokens.palette.green, fontSize: 15, fontWeight: '600' },
});
