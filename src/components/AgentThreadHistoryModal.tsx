import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Tokens } from '@/constants/Colors';
import type { ChildAgent, ChildExchangeRow } from 'pentacle-chat-core';

export type AgentThreadHistoryTarget = {
  parentStreamId: string;
  parentGeneration?: string | null;
  child: ChildAgent;
};

type ThreadRead = (args: {
  parentStreamId: string;
  childStreamId: string;
  cursor?: string;
}) => Promise<{
  parent_stream_id: string;
  child_stream_id: string;
  parent_generation: string;
  child_generation: string;
  rows: ChildExchangeRow[];
  next_cursor: string | null;
}>;

function targetKey(target: AgentThreadHistoryTarget | null) {
  if (!target) return '';
  return [target.parentStreamId, target.parentGeneration || '', target.child.stream_id, target.child.session_generation].join(':');
}

function prependUnique(existing: readonly ChildExchangeRow[], page: readonly ChildExchangeRow[]) {
  const seen = new Set(existing.map((row) => row.row_id));
  return [...page.filter((row) => !seen.has(row.row_id)), ...existing];
}

export function AgentThreadHistoryModal({
  target,
  connected,
  readThread,
  onClose,
  onBackToChats,
  onRowsRendered,
}: {
  target: AgentThreadHistoryTarget | null;
  connected: boolean;
  readThread: ThreadRead;
  onClose: () => void;
  onBackToChats?: () => void;
  onRowsRendered?: (input: { parentStreamId: string; childStreamId: string; rows: readonly ChildExchangeRow[]; nextCursor: string | null }) => void;
}) {
  const key = targetKey(target);
  const [rows, setRows] = useState<readonly ChildExchangeRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestEpoch = useRef(0);
  const targetRef = useRef(target);
  const wasConnected = useRef(connected);

  useEffect(() => {
    targetRef.current = target;
  }, [target]);

  const close = useCallback(() => {
    requestEpoch.current += 1;
    onClose();
  }, [onClose]);

  const load = useCallback(async (cursor?: string, reset = false) => {
    const current = targetRef.current;
    if (!current) return;
    const expected = targetKey(current);
    const epoch = ++requestEpoch.current;
    setLoading(true);
    setError(null);
    try {
      const result = await readThread({
        parentStreamId: current.parentStreamId,
        childStreamId: current.child.stream_id,
        ...(cursor ? { cursor } : {}),
      });
      if (epoch !== requestEpoch.current || targetKey(targetRef.current) !== expected) return;
      if (
        result.parent_stream_id !== current.parentStreamId ||
        result.child_stream_id !== current.child.stream_id ||
        (current.parentGeneration && result.parent_generation !== current.parentGeneration) ||
        result.child_generation !== current.child.session_generation
      ) {
        throw new Error('Thread history changed. Reopen the direct child from the current roster.');
      }
      setRows((prior) => reset ? result.rows : prependUnique(prior, result.rows));
      setNextCursor(result.next_cursor);
    } catch (reason) {
      if (epoch === requestEpoch.current && targetKey(targetRef.current) === expected) {
        const message = reason instanceof Error ? reason.message : 'Thread history could not be loaded.';
        if (/pair[_ ]closed/i.test(message)) {
          setRows([]);
          setNextCursor(null);
          setError('Thread history is unavailable because this direct-child pairing closed.');
        } else {
          setError(message);
        }
      }
    } finally {
      if (epoch === requestEpoch.current && targetKey(targetRef.current) === expected) setLoading(false);
    }
  }, [readThread]);

  useEffect(() => {
    requestEpoch.current += 1;
    setRows([]);
    setNextCursor(null);
    setError(null);
    if (target) void load(undefined, true);
  }, [key, load, target]);

  useEffect(() => {
    const reconnected = connected && !wasConnected.current;
    wasConnected.current = connected;
    if (reconnected && targetRef.current) void load(undefined, true);
  }, [connected, load]);

  useEffect(() => {
    if (!target || loading || error) return;
    onRowsRendered?.({ parentStreamId: target.parentStreamId, childStreamId: target.child.stream_id, rows, nextCursor });
  }, [error, loading, nextCursor, onRowsRendered, rows, target]);

  if (!target) return null;
  return (
    <Modal transparent visible animationType="slide" onRequestClose={close}>
      <View testID="agent-thread-modal" style={styles.scrim}>
        <View style={styles.card}>
          <View style={styles.header}>
            <View>
              <Text style={styles.eyebrow}>UPDATES · STATUS · CHAT</Text>
              <Text style={styles.title} numberOfLines={1}>{target.child.display_name}</Text>
              <Text style={styles.objective} numberOfLines={2}>{target.child.objective || 'Objective unavailable.'}</Text>
            </View>
            <View style={styles.headerActions}>
              <Pressable testID="agent-thread-back" accessibilityRole="button" accessibilityLabel={onBackToChats ? 'Back to chats' : 'Back to status'} onPress={onBackToChats || close} style={styles.back}>
                <Text style={styles.backText}>{onBackToChats ? 'CHATS' : 'BACK'}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Close thread history" onPress={close} style={styles.close}>
                <Text style={styles.closeText}>×</Text>
              </Pressable>
            </View>
          </View>
          {loading ? <ActivityIndicator testID="agent-thread-loading" color={Tokens.palette.green} /> : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {!loading && !error && rows.length === 0 ? <Text style={styles.empty}>No parent/child exchange rows yet.</Text> : null}
          {rows.map((row) => (
            <View key={row.row_id} style={styles.row}>
              <Text style={styles.meta}>{row.direction === 'parent_to_child' ? 'PARENT → CHILD' : 'CHILD → PARENT'} · {row.kind.toUpperCase()} · {row.ts}</Text>
              <Text style={styles.text}>{row.text}{row.truncated ? ' …' : ''}</Text>
            </View>
          ))}
          {nextCursor ? (
            <Pressable testID="agent-thread-load-more" accessibilityRole="button" accessibilityLabel="Load older thread history" disabled={loading} onPress={() => void load(nextCursor)} style={styles.more}>
              <Text style={styles.moreText}>LOAD OLDER</Text>
            </Pressable>
          ) : null}
          <Pressable testID="agent-thread-back-status" accessibilityRole="button" accessibilityLabel="Back to status" onPress={close} style={styles.more}>
            <Text style={styles.moreText}>BACK TO STATUS</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.66)' },
  card: { maxHeight: '78%', padding: 18, gap: 10, borderTopWidth: 1, borderColor: `${Tokens.palette.green}88`, backgroundColor: Tokens.palette.panel },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  eyebrow: { color: Tokens.palette.muted, fontSize: 10, letterSpacing: 1 },
  title: { color: Tokens.palette.text, fontWeight: '700', fontSize: 18 },
  objective: { color: Tokens.palette.muted, fontSize: 12, maxWidth: 230 },
  back: { padding: 6 },
  backText: { color: Tokens.palette.green, fontSize: 11, fontWeight: '700' },
  close: { padding: 5 },
  closeText: { color: Tokens.palette.text, fontSize: 24 },
  error: { color: Tokens.palette.amber },
  empty: { color: Tokens.palette.muted },
  row: { borderLeftWidth: 2, borderColor: `${Tokens.palette.green}88`, paddingLeft: 10, gap: 3 },
  meta: { color: Tokens.palette.muted, fontSize: 10 },
  text: { color: Tokens.palette.text, fontSize: 14, lineHeight: 20 },
  more: { alignSelf: 'flex-start', paddingVertical: 7, paddingHorizontal: 10, borderWidth: 1, borderColor: `${Tokens.palette.green}99` },
  moreText: { color: Tokens.palette.green, fontWeight: '700', fontSize: 11 },
});
