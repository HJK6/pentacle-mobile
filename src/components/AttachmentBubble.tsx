import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import type { ChatAttachment } from 'pentacle-chat-core';
import { MediaBubble, type MediaBubbleProps } from './MediaBubble';
import { downloadAndShareAttachment, fileDisplayName, fileType, FILE_ATTACHMENT_MAX_BYTES } from '../services/fileAttachmentShare';

export interface AttachmentBubbleProps extends MediaBubbleProps {
  kind?: 'file';
  attachment?: ChatAttachment;
}
export function AttachmentBubble(props: AttachmentBubbleProps) {
  if (props.kind === 'file' && props.attachment) {
    return <FileBubble key={JSON.stringify([props.attachment.key, props.attachment.mime, props.attachment.filename, props.attachment.size])}
      attachment={props.attachment} testID={props.testID} borderColor={props.borderColor} />;
  }
  return <MediaBubble {...props} />;
}
function FileBubble({ attachment, testID, borderColor }: { attachment: ChatAttachment; testID: string; borderColor: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'failed' | 'unavailable'>('idle');
  const [message, setMessage] = useState('');
  const mounted = React.useRef(true);
  const active = React.useRef<AbortController | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; active.current?.abort(); }; }, []);
  const name = fileDisplayName(attachment);
  const size = attachment.size ?? attachment.bytes;
  const supported = Boolean(fileType(attachment.mime) && /^[0-9a-f]{64}$/.test(attachment.key)
    && Number.isSafeInteger(size) && size && size > 0 && size <= FILE_ATTACHMENT_MAX_BYTES);
  async function share() {
    if (active.current || state === 'unavailable' || !supported) return;
    const controller = new AbortController(); active.current = controller;
    setState('busy'); setMessage('Preparing file…');
    try {
      await downloadAndShareAttachment(attachment, controller.signal);
      if (mounted.current) { setState('idle'); setMessage(''); }
    } catch (error) {
      if (!mounted.current) return;
      const code = (error as { code?: string })?.code;
      if (code === 'blob_unknown') { setState('unavailable'); setMessage('File expired or unavailable'); }
      else { setState('failed'); setMessage(code === 'sharing_unavailable' ? 'Sharing is unavailable on this device' : 'Download failed. Tap to retry'); }
    } finally { if (active.current === controller) active.current = null; }
  }
  return <View style={[styles.file, { borderColor }]} testID={`${testID}-file`}>
    <Text style={styles.name}>{name}</Text>
    <Text style={styles.details}>{attachment.mime} · {attachment.size ?? attachment.bytes ?? '?'} bytes</Text>
    {state === 'busy' ? <ActivityIndicator testID={`${testID}-file-loading`} /> : null}
    <Text accessibilityLiveRegion="polite" style={styles.details} testID={`${testID}-file-status`}>
      {!supported ? 'Unsupported attachment' : message || 'Save a copy or share'}
    </Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`Save or share ${name}`}
      accessibilityState={{ disabled: !supported || state === 'busy' || state === 'unavailable', busy: state === 'busy' }}
      disabled={!supported || state === 'busy' || state === 'unavailable'}
      onPress={() => { void share(); }} testID={`${testID}-file-share`} style={styles.action}>
      <Text style={styles.actionText}>{state === 'failed' ? 'Retry' : 'Save or share'}</Text>
    </Pressable>
  </View>;
}
const styles = StyleSheet.create({
  file: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, gap: 6, maxWidth: 280, marginBottom: 6, backgroundColor: '#1a1f2b' },
  name: { color: '#f0f3fa', fontWeight: '600' },
  details: { color: '#b6bfce', fontSize: 12 },
  action: { paddingVertical: 8 },
  actionText: { color: '#a8cfff', fontWeight: '600' },
});
