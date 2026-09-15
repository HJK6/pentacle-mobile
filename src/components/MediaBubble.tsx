import React, { useEffect, useState } from 'react';
import { logTelemetry, TELEMETRY_EVENTS } from 'pentacle-chat-core';
import {
  View,
  Image,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';

/**
 * Renders a single attached image inside a message bubble with reserved layout
 * (from the stored width/height so the thread doesn't jump), a loading spinner
 * while the source resolves, and a broken-image fallback. Tapping invokes
 * `onPress` (the full-screen viewer).
 *
 * Lifted from altum-phone `src/components/conversation/MediaBubble.tsx`, adapted
 * to the mobile-local `RenderAttachment` shape. The `uri` may be a local
 * `file://` (optimistic / just-sent rows) or a remote read URL (delivered rows,
 * A2) — React Native's <Image> handles both, so no per-scheme branch is needed
 * for display.
 */

const MAX_WIDTH = 220;
const MAX_HEIGHT = 320;
// Fallback aspect (w/h) when the stored dimensions are missing, so the bubble
// still reserves a sensible box.
const FALLBACK_ASPECT = 0.75;

function reservedSize(width?: number, height?: number): { width: number; height: number } {
  const w = width ?? 0;
  const h = height ?? 0;
  const aspect = w > 0 && h > 0 ? w / h : FALLBACK_ASPECT;
  let boxWidth = MAX_WIDTH;
  let boxHeight = Math.round(boxWidth / aspect);
  if (boxHeight > MAX_HEIGHT) {
    boxHeight = MAX_HEIGHT;
    boxWidth = Math.round(boxHeight * aspect);
  }
  return { width: boxWidth, height: boxHeight };
}

export interface MediaBubbleProps {
  uri: string;
  width?: number;
  height?: number;
  onPress: () => void;
  testID: string;
  borderColor: string;
}

export function MediaBubble(props: MediaBubbleProps) {
  // A source owns its loading/error state. Replacing it also isolates callbacks
  // from the previous native image request.
  return <MediaBubbleSource key={props.uri} {...props} />;
}

function MediaBubbleSource({
  uri,
  width,
  height,
  onPress,
  testID,
  borderColor,
}: MediaBubbleProps) {
  const [loading, setLoading] = useState(true);
  const [broken, setBroken] = useState(false);
  const box = reservedSize(width, height);
  const loadState = broken || !uri ? 'failed' : loading ? 'loading' : 'loaded';
  const sourceKind = uri.startsWith('file:') ? 'local' : uri.startsWith('http') ? 'remote' : 'other';
  useEffect(() => {
    // Report state without attachment URLs, local paths or image content.
    logTelemetry(TELEMETRY_EVENTS.CHAT_IMAGE_LOAD_STATE, { state: loadState, source: sourceKind });
  }, [loadState, sourceKind]);

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      testID={testID}
      style={[styles.frame, { width: box.width, height: box.height, borderColor }]}
    >
      {!broken && uri ? (
        <Image
          source={{ uri }}
          style={styles.image}
          resizeMode="cover"
          // Fabric may report a cached completion before its loadStart event.
          // Initial state already represents loading; completion stays terminal
          // for this source instead of a late start restoring the spinner.
          onLoad={() => setLoading(false)}
          onError={() => {
            setLoading(false);
            setBroken(true);
          }}
          testID={`${testID}-img`}
        />
      ) : null}
      {loading && !broken && uri ? (
        <View style={styles.overlay} testID={`${testID}-loading`}>
          <ActivityIndicator />
        </View>
      ) : null}
      {broken || !uri ? (
        <View style={styles.overlay} testID={`${testID}-broken`} />
      ) : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  frame: {
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#1a1f2b',
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
