import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Keyboard, Modal, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Fonts, Tokens } from '@/constants/Colors';
import type { SmartChatListItem } from '../../../app/(tabs)/chats';
import { performChatOpenNavigation } from '../../services/chatOpenNavigation';
import StatusTag from '../StatusTag';
import MachineMark from './MachineMark';

type Group = { title: 'NEEDS YOU' | 'WORKING' | 'IDLE'; chats: SmartChatListItem[] };
type Props = { open: boolean; groups: Group[]; canStart: boolean; onClose(): void; onNewSession(): void };

export default function ChatsDrawer({ open, groups, canStart, onClose, onNewSession }: Props) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [mounted, setMounted] = useState(open);
  const slide = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(0)).current;
  const newOpening = useRef(false);
  const afterDismiss = useRef<(() => void) | null>(null);
  const finishDismiss = useCallback(() => {
    const action = afterDismiss.current;
    afterDismiss.current = null;
    action?.();
  }, []);
  useEffect(() => () => { afterDismiss.current = null; }, []);
  useEffect(() => {
    if (open) { Keyboard.dismiss(); setMounted(true); newOpening.current = false; afterDismiss.current = null; }
    const animation = Animated.parallel([
      Animated.timing(slide, { toValue: open ? 1 : 0, duration: 300, easing: Easing.bezier(0.4, 0, 0.2, 1), useNativeDriver: true }),
      Animated.timing(fade, { toValue: open ? 1 : 0, duration: 250, useNativeDriver: true }),
    ]);
    animation.start(({ finished }) => {
      if (finished && !open) {
        setMounted(false);
        // iOS must finish native modal dismissal before presenting the summon sheet.
        if (Platform.OS !== 'ios') finishDismiss();
      }
    });
    return () => animation.stop();
  }, [open, slide, fade, finishDismiss]);
  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gesture) => open && gesture.dx < -10 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
    onPanResponderRelease: (_event, gesture) => { if (open && gesture.dx < -50) onClose(); },
  }), [open, onClose]);

  const startSession = () => {
    if (!open || !canStart || newOpening.current) return;
    newOpening.current = true;
    afterDismiss.current = onNewSession;
    onClose();
  };
  return <Modal visible={mounted} onDismiss={finishDismiss} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
    <View style={styles.root} pointerEvents={open ? 'auto' : 'none'} accessibilityViewIsModal>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: fade }]}>
        <Pressable accessibilityLabel="Close sessions" accessibilityRole="button" onPress={onClose} style={styles.scrim} />
      </Animated.View>
      <Animated.View testID="bart-drawer-panel" {...pan.panHandlers} style={[styles.panel, {
        paddingTop: Math.max(insets.top, 52) + 4, paddingBottom: Math.max(insets.bottom, 20),
        transform: [{ translateX: slide.interpolate({ inputRange: [0, 1], outputRange: [-width * 0.86 * 1.02, 0] }) }],
      }]}>
        <View style={styles.heading}>
          <Text accessibilityRole="header" style={styles.title}>Sessions</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="New session" disabled={!canStart} accessibilityState={{ disabled: !canStart }} onPress={startSession} style={[styles.plus, !canStart && styles.disabled]}>
            <Text style={styles.plusText}>+</Text>
          </Pressable>
        </View>
        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {groups.filter((group) => group.chats.length > 0).map((group) => <View key={group.title}>
            <Text accessibilityRole="header" style={styles.group}>{group.title} · {group.chats.length}</Text>
            {group.chats.map((chat) => <Pressable key={chat.streamId} testID={`bart-drawer-row-${chat.streamId}`}
              accessibilityRole="button" accessibilityLabel={`Open ${chat.title}, ${chat.statusLabel}, ${chat.hostTitle}`}
              onPress={() => { if (open) performChatOpenNavigation(chat.streamId, router, onClose); }} style={styles.row}>
              <MachineMark machine={chat.machineName} />
              <View style={styles.copy}>
                <View style={styles.rowHeading}><StatusTag status={chat.status} />
                  <Text style={styles.rowTitle} numberOfLines={1}>{chat.title}</Text>
                  <Text style={styles.time}>{chat.updatedLabel}</Text></View>
                <Text style={[styles.preview, group.title === 'NEEDS YOU' && styles.needsYou]} numberOfLines={1}>{chat.previewText}</Text>
              </View>
            </Pressable>)}
          </View>)}
        </ScrollView>
      </Animated.View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scrim: { flex: 1, backgroundColor: 'rgba(3,7,5,0.7)' },
  panel: { position: 'absolute', top: 0, bottom: 0, left: 0, width: '86%', backgroundColor: Tokens.palette.panel,
    borderRightWidth: 1, borderRightColor: Tokens.palette.line, paddingHorizontal: 18 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { flex: 1, fontFamily: Fonts.rajdhani.bold, fontSize: 20, color: Tokens.palette.text },
  plus: { width: 32, height: 32, borderRadius: 4, backgroundColor: Tokens.palette.green, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.4 },
  plusText: { fontSize: 25, lineHeight: 28, color: Tokens.palette.ink },
  group: { marginTop: 16, marginBottom: 2, fontFamily: Fonts.jetBrainsMono.regular, fontSize: 9.5,
    letterSpacing: 1.4, color: Tokens.palette.muted },
  row: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' },
  copy: { flex: 1, minWidth: 0 },
  rowHeading: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  rowTitle: { flex: 1, fontFamily: Fonts.rajdhani.bold, fontSize: 15.5, color: Tokens.palette.text },
  time: { fontFamily: Fonts.jetBrainsMono.regular, fontSize: 9.5, color: Tokens.palette.muted },
  preview: { marginTop: 3, fontFamily: Fonts.rajdhani.medium, fontSize: 12.5, color: Tokens.palette.muted },
  needsYou: { color: Tokens.palette.amber },
});
