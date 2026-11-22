import React, { useState } from 'react';
import { Image, Pressable, StyleSheet, Text } from 'react-native';
import type { DashboardLink } from 'pentacle-chat-core';
import { Tokens } from '../../../constants/Colors';

type Props = {
  link: DashboardLink;
  caption: string;
  imageUri?: string;
  onOpen: () => void;
  onImageError?: () => void;
};

export function DesignLinkPreview({ link, caption, imageUri, onOpen, onImageError }: Props) {
  const [failedUri, setFailedUri] = useState<string>();
  const target = link.target;
  const title = target ? link.title || caption.trim() || 'Design' : 'Design';
  const showImage = target && imageUri && failedUri !== imageUri;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={target ? `Open Design: ${title}` : 'Open Design Home'}
      onPress={onOpen}
      testID={target ? 'design-link-preview' : 'design-link-chip'}
      style={[styles.card, target ? styles.preview : styles.chip]}
    >
      {showImage ? <Image
        accessible={false}
        source={{ uri: imageUri }}
        resizeMode="cover"
        onError={() => {
          setFailedUri(imageUri);
          onImageError?.();
        }}
        style={styles.image}
        testID="design-link-image"
      /> : null}
      <Text style={styles.title} numberOfLines={2}>{title}</Text>
      {target ? <Text style={styles.subtitle} numberOfLines={1}>Design · {link.subtitle || target.design_id}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    alignSelf: 'flex-start',
    backgroundColor: Tokens.palette.panel,
    borderColor: Tokens.palette.line,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 4,
    marginBottom: 6,
    padding: 10,
  },
  preview: { width: '100%', maxWidth: 296 },
  chip: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 14 },
  image: { width: '100%', aspectRatio: 1.6, borderRadius: 8, backgroundColor: Tokens.palette.ink },
  title: { color: Tokens.palette.text, fontSize: 15, fontWeight: '600' },
  subtitle: { color: Tokens.palette.muted, fontSize: 12 },
});
