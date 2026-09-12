import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Fonts, Tokens } from '@/constants/Colors';

type Props = {
  visible: boolean;
  title?: string;
  reportCount?: number;
  reportUnreadCount?: number;
  onReports?: () => void;
  onRename: () => void;
  onDelete?: () => void;
  onClose: () => void;
};

/**
 * Bottom action sheet for a single chat: Rename / Delete / Cancel.
 * Matches the SummonModal slide-up aesthetic. The caller owns what each
 * action does (rename modal, delete confirm) and is responsible for closing.
 */
export default function ChatActionSheet({ visible, reportCount = 0, reportUnreadCount = 0, onReports, onRename, onDelete, onClose }: Props) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} testID="chat-action-sheet">
        <Pressable style={styles.sheet} onPress={(event) => event?.stopPropagation?.()}>
          <View style={styles.handle} />
          {reportCount > 0 && onReports ? (
            <Pressable
              testID="chat-action-reports"
              style={[styles.row, { borderColor: `${Tokens.palette.green}55` }]}
              onPress={onReports}
              accessibilityRole="button"
              accessibilityLabel={`Reports, ${reportUnreadCount} unread`}
            >
              <View style={styles.reportGlyphWrap}>
                <Text style={[styles.glyph, { color: Tokens.palette.green }]}>▤</Text>
                {reportUnreadCount > 0 ? <View style={styles.unreadDot} /> : null}
              </View>
              <View style={styles.reportLabelWrap}>
                <Text style={styles.rowLabel}>Reports</Text>
                <Text style={styles.reportMeta}>{reportCount} from child agents · {reportUnreadCount} unread</Text>
              </View>
            </Pressable>
          ) : null}

          <Pressable
            testID="chat-action-rename"
            style={[styles.row, { borderColor: `${Tokens.palette.green}55` }]}
            onPress={onRename}
            accessibilityRole="button"
              accessibilityLabel="Rename chat"
          >
            <Text style={[styles.glyph, { color: Tokens.palette.green }]}>✎</Text>
            <Text style={styles.rowLabel}>Rename</Text>
          </Pressable>

          {onDelete ? (
            <Pressable
              testID="chat-action-delete"
              style={[styles.row, { borderColor: `${Tokens.palette.red}66` }]}
              onPress={onDelete}
              accessibilityRole="button"
                accessibilityLabel="Delete chat"
            >
              <Text style={[styles.glyph, { color: Tokens.palette.red }]}>🗑</Text>
              <Text style={[styles.rowLabel, styles.destructiveLabel]}>Delete</Text>
            </Pressable>
          ) : null}

          <Pressable
            testID="chat-action-cancel"
            style={styles.cancelButton}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: Tokens.palette.backdrop,
  },
  sheet: {
    width: '100%',
    backgroundColor: Tokens.palette.panel,
    borderTopWidth: 1,
    borderTopColor: Tokens.palette.line,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 32,
    gap: 12,
  },
  handle: {
    width: 42,
    height: 4,
    borderRadius: 999,
    backgroundColor: Tokens.palette.line,
    alignSelf: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 16,
    paddingHorizontal: 18,
  },
  glyph: {
    fontFamily: Fonts.rajdhani.bold,
    fontSize: 18,
    width: 22,
    textAlign: 'center',
  },
  reportGlyphWrap: { position: 'relative' },
  unreadDot: { position: 'absolute', right: -2, top: -2, width: 7, height: 7, borderRadius: 4, backgroundColor: Tokens.palette.green },
  reportLabelWrap: { flex: 1 },
  reportMeta: { marginTop: 1, fontFamily: Fonts.rajdhani.medium, fontSize: 12, color: Tokens.palette.muted },
  rowLabel: {
    fontFamily: Fonts.rajdhani.bold,
    fontSize: 17,
    color: Tokens.palette.text,
  },
  destructiveLabel: {
    color: Tokens.palette.red,
  },
  cancelButton: {
    alignItems: 'center',
    paddingVertical: 12,
    marginTop: 2,
  },
  cancelText: {
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 13,
    color: Tokens.palette.muted,
  },
});
