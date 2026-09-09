import React, { useCallback, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Fonts, TOP_INSET, Tokens } from '@/constants/Colors';
import NotificationCard from '../../src/components/NotificationCard';
import Starfield from '../../src/components/Starfield';
import { Spinner } from '../../src/components/ArcaneAtoms';
import useAutoRefresh from '../../src/hooks/useAutoRefresh';
import useNotifications from '../../src/hooks/useNotifications';
import { filterUpdatesNotifications } from '../../src/services/agentQuestionNotifications';
import type { PentacleNotification } from 'pentacle-chat-core';
import { logFocusedTab } from '../../src/services/mobileTabsTelemetry';

export default function UpdatesScreen() {
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  // Notifications-only feed (A1): the persistent Updates feed is a view over the
  // notifications store, including open agent-question cards.
  const {
    notifications,
    loading,
    error,
    refetch: refetchNotifications,
  } = useNotifications(isFocused);
  const [refreshing, setRefreshing] = useState(false);
  const updatesNotifications = React.useMemo(
    () => filterUpdatesNotifications(notifications),
    [notifications],
  );

  React.useEffect(() => {
    if (isFocused) logFocusedTab('updates');
  }, [isFocused]);

  useAutoRefresh(refetchNotifications, { intervalMs: 10000 });

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetchNotifications();
    setRefreshing(false);
  }, [refetchNotifications]);

  const renderNotification = useCallback(
    ({ item }: { item: PentacleNotification }) => <NotificationCard notification={item} informational />,
    [],
  );

  const initialLoading = loading && updatesNotifications.length === 0;

  if (initialLoading) {
    return (
      <View style={[styles.centered, styles.container]}>
        <Starfield />
        <Spinner size={38} color={Tokens.palette.green} />
      </View>
    );
  }

  const hasContent = updatesNotifications.length > 0;

  return (
    <View style={styles.container}>
      <Starfield />
      <FlatList
        data={updatesNotifications}
        renderItem={renderNotification}
        keyExtractor={(item) => item.notification_id}
        contentContainerStyle={[
          hasContent ? styles.list : styles.emptyList,
          { paddingTop: Math.max(insets.top, TOP_INSET), paddingBottom: Math.max(insets.bottom, 18) + 92 },
        ]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={Tokens.palette.green} />}
        ListEmptyComponent={
          <View style={styles.centered}>
            <Text style={styles.emptyText}>{error ? 'Updates unavailable' : 'Nothing yet'}</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Tokens.palette.ink,
    position: 'relative',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  list: {
    paddingVertical: 8,
  },
  emptyList: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    color: Tokens.palette.muted,
    fontFamily: Fonts.rajdhani.medium,
    fontSize: 16,
  },
});
