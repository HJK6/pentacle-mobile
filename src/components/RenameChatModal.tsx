import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Fonts, Tokens } from '@/constants/Colors';

type Props = {
  visible: boolean;
  initialName: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
};

/**
 * Cross-platform rename dialog (replaces the iOS-only Alert.prompt). A
 * prefilled text input; Save is disabled until the value is non-empty and
 * changed. Used by both the session screen and the chats list.
 */
export default function RenameChatModal({ visible, initialName, onSubmit, onClose }: Props) {
  const [value, setValue] = useState(initialName);

  useEffect(() => {
    if (visible) {
      setValue(initialName);
    }
  }, [visible, initialName]);

  const trimmed = value.trim();
  const canSave = trimmed.length > 0 && trimmed !== initialName.trim();

  const handleSave = () => {
    if (!canSave) return;
    onSubmit(trimmed);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} testID="rename-chat-modal">
        <Pressable style={styles.card} onPress={(event) => event?.stopPropagation?.()}>
          <Text style={styles.title}>Rename chat</Text>
          <TextInput
            testID="rename-chat-input"
            style={styles.input}
            value={value}
            onChangeText={setValue}
            placeholder="Chat name"
            placeholderTextColor={Tokens.palette.muted}
            autoFocus
            selectTextOnFocus
            returnKeyType="done"
            onSubmitEditing={handleSave}
            maxLength={120}
          />
          <View style={styles.actions}>
            <Pressable
              testID="rename-chat-cancel"
              style={styles.actionButton}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Cancel rename"
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              testID="rename-chat-save"
              style={[styles.actionButton, styles.saveButton, !canSave && styles.saveDisabled]}
              onPress={handleSave}
              disabled={!canSave}
              accessibilityRole="button"
              accessibilityLabel="Save chat name"
            >
              <Text style={[styles.saveText, !canSave && styles.saveTextDisabled]}>Save</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 28,
    backgroundColor: Tokens.palette.backdrop,
  },
  card: {
    width: '100%',
    backgroundColor: Tokens.palette.panel,
    borderWidth: 1,
    borderColor: Tokens.palette.line,
    borderRadius: 16,
    padding: 20,
    gap: 16,
  },
  title: {
    fontFamily: Fonts.cinzel.semiBold,
    fontSize: 18,
    color: Tokens.palette.text,
    textAlign: 'center',
  },
  input: {
    fontFamily: Fonts.rajdhani.medium,
    fontSize: 17,
    color: Tokens.palette.text,
    borderWidth: 1,
    borderColor: `${Tokens.palette.green}55`,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  actionButton: {
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 8,
  },
  cancelText: {
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 13,
    color: Tokens.palette.muted,
  },
  saveButton: {
    backgroundColor: `${Tokens.palette.green}1f`,
    borderWidth: 1,
    borderColor: `${Tokens.palette.green}66`,
  },
  saveDisabled: {
    opacity: 0.4,
  },
  saveText: {
    fontFamily: Fonts.rajdhani.bold,
    fontSize: 15,
    color: Tokens.palette.green,
  },
  saveTextDisabled: {
    color: Tokens.palette.muted,
  },
});
