import React, { createContext, useContext, useId, useMemo, useState } from 'react';
import { Linking, Platform, StyleSheet, Text, useWindowDimensions, type StyleProp, type TextStyle } from 'react-native';
import { logTelemetry, type MdInline } from 'pentacle-chat-core';
import { Tokens } from '../../constants/Colors';
import { MOBILE_TELEMETRY_EVENTS } from '../services/mobileTelemetryEvents';
import type { MessageTextNativeProps, MessageTextRun } from '../../modules/pentacle-message-text';

export const MessageTextRow = createContext('message');
type InlineStyles = Partial<Record<'strong' | 'em' | 'code' | 'link', StyleProp<TextStyle>>>;

type Props = {
  children?: React.ReactNode;
  nodes?: MdInline[];
  style?: StyleProp<TextStyle>;
  inlineStyles?: InlineStyles;
  testID?: string;
  blockId?: string;
  shrinkToFit?: boolean;
  fallbackSelectable?: boolean;
};

export function messageTextRuns(nodes: MdInline[], style: StyleProp<TextStyle>, inlineStyles: InlineStyles = {}, fontScale = 1): MessageTextRun[] {
  const runs: MessageTextRun[] = [];
  const walk = (items: MdInline[], inherited: TextStyle, href?: string) => {
    for (const node of items) {
      if (node.type === 'strong' || node.type === 'em' || node.type === 'link') {
        walk(node.children, { ...inherited, ...StyleSheet.flatten(inlineStyles[node.type]) }, node.type === 'link' ? node.href : href);
      } else {
        const leaf = node.type === 'code' ? { ...inherited, ...StyleSheet.flatten(inlineStyles.code) } : inherited;
        runs.push({
          text: node.type === 'break' ? '\n' : node.value,
          fontFamily: leaf.fontFamily,
          fontSize: (leaf.fontSize ?? 14.5) * fontScale,
          lineHeight: (leaf.lineHeight ?? 22) * fontScale,
          color: typeof leaf.color === 'string' ? leaf.color : '#ffffff',
          backgroundColor: typeof leaf.backgroundColor === 'string' ? leaf.backgroundColor : undefined,
          italic: leaf.fontStyle === 'italic',
          underline: leaf.textDecorationLine?.includes('underline') ?? false,
          href,
          alignment: leaf.textAlign ?? 'left',
        });
      }
    }
  };
  walk(nodes, StyleSheet.flatten(style) ?? {});
  return runs;
}

let nativeView: React.ComponentType<MessageTextNativeProps> | undefined;
function nativeMessageText(): React.ComponentType<MessageTextNativeProps> {
  // Web/Android must never require the Apple-only view manager.
  if (!nativeView) nativeView = require('../../modules/pentacle-message-text').default as React.ComponentType<MessageTextNativeProps>;
  return nativeView;
}

export default function MessageSelectableText({ children, nodes, style, inlineStyles, testID, blockId, shrinkToFit = false, fallbackSelectable = true }: Props) {
  const rowId = useContext(MessageTextRow);
  const { fontScale } = useWindowDimensions();
  const localId = useId();
  const identity = `${rowId}:${blockId ?? localId}`;
  const runs = useMemo(() => messageTextRuns(nodes ?? [{ type: 'text', value: String(children ?? '') }], style, inlineStyles, fontScale), [nodes, children, style, inlineStyles, fontScale]);
  const contentKey = `${identity}:${runs.map((run) => run.text).join('')}`;
  const [measurement, setMeasurement] = useState<{ contentKey: string; height: number; width: number; naturalWidth?: number }>();
  if (Platform.OS !== 'ios') return <Text selectable={fallbackSelectable} selectionColor={Tokens.palette.green} style={style} testID={testID}>{children}</Text>;
  const NativeText = nativeMessageText();
  const base = StyleSheet.flatten(style) ?? {};
  const height = measurement?.contentKey === contentKey ? measurement.height : (base.lineHeight ?? 22) * fontScale;
  return <NativeText
    runs={runs}
    contentIdentity={identity}
    textIdentifier={testID ?? `message-text-${identity}`}
    testID={testID ?? `message-text-${identity}`}
    style={[style, { height, minHeight: (base.lineHeight ?? 22) * fontScale, alignSelf: 'stretch' }, shrinkToFit && { alignSelf: 'flex-start', minWidth: 1, width: measurement?.contentKey === contentKey ? measurement.naturalWidth : undefined, maxWidth: '100%' }]}
    onContentSize={({ nativeEvent }) => {
      if (nativeEvent.contentIdentity !== identity || !Number.isFinite(nativeEvent.height) || nativeEvent.height <= 0 || nativeEvent.width <= 0) return;
      setMeasurement((previous) => previous?.contentKey === contentKey && previous.height === nativeEvent.height && previous.width === nativeEvent.width && previous.naturalWidth === nativeEvent.naturalWidth
        ? previous : { contentKey, height: nativeEvent.height, width: nativeEvent.width, naturalWidth: nativeEvent.naturalWidth });
    }}
    onLinkPress={({ nativeEvent }) => {
      if (runs.some((run) => run.href === nativeEvent.href)) void Linking.openURL(nativeEvent.href).catch(() => undefined);
    }}
    onSelectionChange={({ nativeEvent }) => {
      const { start, end, length } = nativeEvent;
      const textLength = runs.reduce((sum, run) => sum + run.text.length, 0);
      if (![start, end, length].every(Number.isInteger) || start < 0 || end < start || end > textLength || end - start !== length) return;
      logTelemetry(MOBILE_TELEMETRY_EVENTS.CHAT_MESSAGE_SELECTION_CHANGED as Parameters<typeof logTelemetry>[0], {
        subsystem: 'chat', bug_ref: 'message_native_text_selection_2026_10', row_id: rowId,
        block_id: blockId ?? localId, start, end, length,
      });
    }}
    onFontError={({ nativeEvent }) => {
      logTelemetry(MOBILE_TELEMETRY_EVENTS.CHAT_MESSAGE_SELECTION_FONT_ERROR as Parameters<typeof logTelemetry>[0], {
        subsystem: 'chat', bug_ref: 'message_native_text_selection_2026_10', font_family: nativeEvent.fontFamily,
      });
    }}
  />;
}
