import React, { useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect } from 'react';
import {
  ActivityIndicator, Alert, Image, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View,
  useWindowDimensions, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent,
} from 'react-native';
import { FontAwesome } from '@expo/vector-icons';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useVoiceSurface } from '../services/voicePresentation';
import { resolveImageAttachment } from '../services/attachmentFetch';
import { createImageGallery, type GalleryImage, type ImageGallery, type ViewerAttachment } from '../services/imageGallery';
import { shareImage } from '../services/imageShare';
import VoiceRecordingOverlay from './voice/VoiceRecordingOverlay';

const FIT_TOLERANCE = 0.01;
type Size = { width: number; height: number };
export interface ImageViewerModalProps {
  gallery?: ImageGallery | null;
  /** Single-image callers can use the same viewer without a transcript. */
  uri?: string | null;
  onClose: () => void;
}

export function ImageViewerModal({ gallery, uri, onClose }: ImageViewerModalProps) {
  const snapshot = useMemo(() => gallery ?? (uri ? createImageGallery([
    { id: 'single', attachments: [{ key: 'single', mime: /\.png$/i.test(uri) ? 'image/png' : 'image/jpeg', uri } as ViewerAttachment] },
  ], 'single', 0) : null), [gallery, uri]);
  const visible = snapshot != null;
  useVoiceSurface({ page_id: 'image', title: 'Image' }, visible, { priority: 2, bottom: 24 });
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
    <GestureHandlerRootView style={styles.backdrop} testID="image-viewer-modal">
      {snapshot ? <GallerySession key={snapshot.openingId} gallery={snapshot} onClose={onClose} /> : null}
      <VoiceRecordingOverlay visible={visible} priority={2} onReturn={onClose} hostName="image-viewer" />
    </GestureHandlerRootView>
  </Modal>;
}

function GallerySession({ gallery, onClose }: { gallery: ImageGallery; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(gallery.initialIndex);
  const window = useWindowDimensions();
  const [viewport, setViewport] = useState<Size>({ width: window.width, height: window.height });
  const [resolved, setResolved] = useState<{ id: string; uri: string } | null>(null);
  const [sharing, setSharing] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const image = gallery.images[index];
  const activeId = useRef(image.id);
  activeId.current = image.id;
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operation.current?.abort(); };
  }, []);
  useEffect(() => {
    operation.current?.abort();
    // Only adjacent files are warmed; no whole-transcript image decoding.
    for (const neighbor of [gallery.images[index - 1], gallery.images[index + 1]]) {
      if (neighbor) void resolveImageAttachment(neighbor.attachment).catch(() => undefined);
    }
  }, [gallery, index]);
  const loaded = useCallback((uri: string | null) => {
    setResolved(uri ? { id: image.id, uri } : null);
  }, [image.id]);
  const cancelPreparation = useCallback(() => {
    operation.current?.abort();
    operation.current = null;
    setSharing(false);
  }, []);
  const close = () => { cancelPreparation(); onClose(); };
  const page = useCallback((direction: number) => {
    cancelPreparation();
    setIndex(current => Math.max(0, Math.min(gallery.images.length - 1, current + direction)));
  }, [gallery.images.length, cancelPreparation]);
  const share = async () => {
    if (operation.current || !resolved || resolved.id !== image.id) return;
    const controller = new AbortController();
    operation.current = controller;
    setSharing(true);
    try {
      await shareImage(resolved.uri, image.attachment.mime, controller.signal, {
        x: insets.left + 16, y: insets.top + 8, width: 44, height: 44,
      });
    } catch (error) {
      if (!controller.signal.aborted && mounted.current && activeId.current === image.id) {
        Alert.alert('Pentacle', 'Could not share this image. Please try again.');
      }
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        if (mounted.current) setSharing(false);
      }
    }
  };
  const layout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setViewport(current => current.width === width && current.height === height ? current : { width, height });
  };
  return <View style={styles.fill} onLayout={layout} testID="image-viewer-viewport">
    {viewport.width > 0 && viewport.height > 0 ? <ImagePage
      key={`${image.id}:${viewport.width}:${viewport.height}`}
      image={image} viewport={viewport} index={index} count={gallery.images.length}
      onClose={close} onPage={page} onResolved={loaded}
    /> : null}
    <Pressable style={[styles.control, { top: insets.top + 8, left: insets.left + 16 }]}
      accessibilityRole="button" accessibilityLabel="Share image"
      accessibilityState={{ disabled: sharing || resolved?.id !== image.id, busy: sharing }}
      disabled={sharing || resolved?.id !== image.id} onPress={() => { void share(); }} testID="image-viewer-share">
      {sharing ? <ActivityIndicator color="#ffffff" /> : <FontAwesome name="share-square-o" size={26} color="#ffffff" />}
    </Pressable>
    <Pressable style={[styles.control, { top: insets.top + 8, right: insets.right + 16 }]}
      accessibilityRole="button" accessibilityLabel="Close image" onPress={close} testID="image-viewer-close">
      <FontAwesome name="close" size={26} color="#ffffff" />
    </Pressable>
  </View>;
}

function ImagePage({ image, viewport, index, count, onClose, onPage, onResolved }: {
  image: GalleryImage; viewport: Size; index: number; count: number;
  onClose: () => void; onPage: (direction: number) => void;
  onResolved: (uri: string | null) => void;
}) {
  const [uri, setUri] = useState<string | null>(image.attachment.uri || null);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const [retry, setRetry] = useState(0);
  const [size, setSize] = useState<Size>({
    width: image.attachment.width || viewport.width, height: image.attachment.height || viewport.height,
  });
  const [scale, setScale] = useState(1);
  const zoom = useRef(1);
  const dragged = useRef(false);
  const offset = useRef({ x: 0, y: 0 });
  const scroll = useRef<ScrollView>(null);
  const fitRatio = Math.min(viewport.width / size.width, viewport.height / size.height);
  const fit = { width: size.width * fitRatio, height: size.height * fitRatio };
  const atFit = scale <= 1 + FIT_TOLERANCE;
  useEffect(() => {
    let active = true;
    setStatus('loading'); onResolved(null);
    resolveImageAttachment(image.attachment).then(next => {
      if (active) setUri(next);
    }).catch(() => { if (active) setStatus('failed'); });
    return () => { active = false; };
  }, [image, retry, onResolved]);
  const reportZoom = (value: number) => {
    zoom.current = value;
    setScale(value);
  };
  const scrolled = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    offset.current = event.nativeEvent.contentOffset;
    reportZoom(event.nativeEvent.zoomScale ?? 1);
  };
  const doubleTap = Gesture.Tap().numberOfTaps(2).maxDelay(275).maxDistance(12)
    .withTestId('image-double-tap').runOnJS(true).onEnd((event, success) => {
      if (!success || dragged.current || status !== 'loaded' || Platform.OS !== 'ios') return;
      const target = zoom.current > 1 + FIT_TOLERANCE ? 1 : 2;
      if (target === 1) {
        scroll.current?.scrollResponderZoomTo({ x: 0, y: 0, ...viewport, animated: true });
      } else {
        const width = viewport.width / target, height = viewport.height / target;
        const centerX = (event.x + offset.current.x) / zoom.current;
        const centerY = (event.y + offset.current.y) / zoom.current;
        const x = fit.width < width ? (fit.width - width) / 2 : Math.max(0, Math.min(fit.width - width, centerX - width / 2));
        const y = fit.height < height ? (fit.height - height) / 2 : Math.max(0, Math.min(fit.height - height, centerY - height / 2));
        scroll.current?.scrollResponderZoomTo({ x, y, width, height, animated: true });
      }
      // Fence paging immediately; the displayed zoom follows native onScroll.
      zoom.current = target;
    });
  const singleTap = Gesture.Tap().maxDistance(12).withTestId('image-single-tap')
    .runOnJS(true).onEnd((_event, success) => { if (success && !dragged.current) onClose(); });
  // Native zoom/pan owns image movement. A one-finger swipe turns a page only
  // after completion, with a second zoom check against the latest native event.
  const paging = Gesture.Pan().maxPointers(1).activeOffsetX([-24, 24]).failOffsetY([-24, 24])
    .enabled(atFit).withTestId('image-page-swipe').runOnJS(true).onEnd((event, success) => {
      if (success && zoom.current <= 1 + FIT_TOLERANCE && Math.abs(event.translationX) > 50) {
        onPage(event.translationX < 0 ? 1 : -1);
      }
    });
  const gestures = Gesture.Simultaneous(Gesture.Native(), paging, Gesture.Exclusive(doubleTap, singleTap));
  const actions = atFit ? [
    ...(index > 0 ? [{ name: 'previous' as const, label: 'Previous image' }] : []),
    ...(index + 1 < count ? [{ name: 'next' as const, label: 'Next image' }] : []),
  ] : [];
  const accessibilityPage = (event: { nativeEvent: { actionName: string } }) => {
    if (zoom.current > 1 + FIT_TOLERANCE) return;
    if (event.nativeEvent.actionName === 'next') onPage(1);
    if (event.nativeEvent.actionName === 'previous') onPage(-1);
  };
  return <View style={styles.fill}>
    <GestureDetector gesture={gestures}>
      <ScrollView ref={scroll} style={styles.fill} contentContainerStyle={fit}
        centerContent minimumZoomScale={1} maximumZoomScale={4} bouncesZoom={false}
        pinchGestureEnabled scrollEventThrottle={16} onScroll={scrolled}
        onTouchStart={event => { dragged.current = event.nativeEvent.touches.length > 1; }}
        onScrollBeginDrag={() => { dragged.current = true; }}
        showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false}
        contentInsetAdjustmentBehavior="never" testID="image-viewer-scroll">
        {uri ? <Image key={`${uri}:${retry}`} source={{ uri }} style={fit} resizeMode="contain"
          accessible accessibilityRole="image" accessibilityLabel={`Chat image ${index + 1} of ${count}`}
          accessibilityValue={{ text: `${Math.round(scale * 100)}% zoom` }} accessibilityActions={actions}
          onAccessibilityAction={accessibilityPage}
          onLoad={event => {
            const source = event.nativeEvent.source;
            if (source?.width > 0 && source?.height > 0) setSize({ width: source.width, height: source.height });
            setStatus('loaded'); onResolved(uri);
          }}
          onError={() => { setStatus('failed'); onResolved(null); }} testID="image-viewer-image" /> : null}
      </ScrollView>
    </GestureDetector>
    {status === 'loading' ? <View style={styles.message} pointerEvents="none"><ActivityIndicator color="#ffffff" accessible accessibilityLabel={`Loading image ${index + 1} of ${count}`} accessibilityActions={actions} onAccessibilityAction={accessibilityPage} testID="image-viewer-loading" /></View> : null}
    {status === 'failed' ? <View style={styles.message} pointerEvents="box-none">
      <Text style={styles.error} accessibilityActions={actions} onAccessibilityAction={accessibilityPage} testID="image-viewer-error">Could not load this image.</Text>
      <Pressable accessibilityRole="button" onPress={() => { setUri(null); setRetry(value => value + 1); }} style={styles.retry} testID="image-viewer-retry">
        <Text style={styles.error}>Retry</Text>
      </Pressable>
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)' },
  fill: { flex: 1 },
  control: { position: 'absolute', zIndex: 2, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  message: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  error: { color: '#ffffff', fontSize: 16 },
  retry: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
});
