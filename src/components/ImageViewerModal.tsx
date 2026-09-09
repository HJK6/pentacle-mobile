import React from 'react';
import {
  Modal,
  View,
  Image,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { FontAwesome } from '@expo/vector-icons';

/**
 * Full-screen lightbox for a tapped image attachment. Plain RN Modal with a
 * contain-fit image and a close affordance (tap backdrop or the X button).
 *
 * Lifted from altum-phone `src/components/conversation/ImageViewerModal.tsx`,
 * trimmed to view-only for A1 — the altum Save/Share toolbar (which pulls
 * `expo-media-library` + `expo-sharing` + the remote→temp download branch) is
 * intentionally dropped: it is outside A1's "open in a viewer on tap" scope and
 * its extra native deps/permissions are not in A1's dependency set. The
 * `uri` may be local `file://` (just-sent) or a remote read URL (delivered,
 * A2); <Image> handles both, so no download is needed for display.
 */

export interface ImageViewerModalProps {
  uri: string | null;
  onClose: () => void;
}

export function ImageViewerModal({ uri, onClose }: ImageViewerModalProps) {
  return (
    <Modal
      visible={uri != null}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.backdrop} testID="image-viewer-modal">
        <TouchableOpacity
          style={styles.closeButton}
          onPress={onClose}
          hitSlop={{ top: 12, right: 12, bottom: 12, left: 12 }}
          testID="image-viewer-close"
        >
          <FontAwesome name="close" size={26} color="#ffffff" />
        </TouchableOpacity>
        <TouchableOpacity style={styles.fill} activeOpacity={1} onPress={onClose}>
          {uri ? (
            <Image
              source={{ uri }}
              style={styles.image}
              resizeMode="contain"
              testID="image-viewer-image"
            />
          ) : null}
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
  },
  fill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  closeButton: {
    position: 'absolute',
    top: 48,
    right: 20,
    zIndex: 2,
    padding: 4,
  },
});
