import type { ComponentType } from 'react';
import type { NativeSyntheticEvent, ViewProps } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';

export type MessageTextRun = {
  text: string;
  fontFamily?: string;
  fontSize: number;
  lineHeight: number;
  color: string;
  backgroundColor?: string;
  italic: boolean;
  underline: boolean;
  href?: string;
  alignment: string;
};
export type MessageTextNativeProps = ViewProps & {
  runs: MessageTextRun[];
  contentIdentity: string;
  textIdentifier: string;
  onContentSize: (event: NativeSyntheticEvent<{ height: number; width: number; naturalWidth: number; contentIdentity: string }>) => void;
  onLinkPress: (event: NativeSyntheticEvent<{ href: string }>) => void;
  onSelectionChange: (event: NativeSyntheticEvent<{ start: number; end: number; length: number }>) => void;
  onFontError: (event: NativeSyntheticEvent<{ fontFamily: string }>) => void;
};
export default requireNativeViewManager('PentacleMessageText') as ComponentType<MessageTextNativeProps>;
