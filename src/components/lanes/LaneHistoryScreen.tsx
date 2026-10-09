import { LeafLoading, LeafText } from "./LaneAtoms";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { parseLaneUpdateEvent, type PentacleEvent } from "pentacle-chat-core";
import { Fonts, Tokens } from "@/constants/Colors";
import Bevel from "../Bevel";
import LaneUpdateCard from "./LaneUpdateCard";
import {
  LANE_HISTORY_PAGE_LIMIT,
  requestLaneHistory,
} from "../../services/pentacleStream";

export type LaneHistoryTarget = {
  streamId: string;
  generation: string;
  title: string;
};

type ReadHistory = (
  streamId: string,
  generation: string,
  options: { limit: number; beforeDaemonSeq?: number | null },
) => Promise<PentacleEvent[]>;

const USER_KINDS = new Set(["USER"]);
const ASSISTANT_KINDS = new Set(["ASSIST", "ASSIST_TEXT"]);

function rowKey(event: PentacleEvent) {
  return event.message_id || `seq:${event.daemon_seq}`;
}

function mergeRows(existing: PentacleEvent[], incoming: PentacleEvent[]) {
  const seen = new Set<string>();
  const merged: PentacleEvent[] = [];
  for (const event of [...incoming, ...existing]) {
    const kind = String(event.kind || "").toUpperCase();
    if (!USER_KINDS.has(kind) && !ASSISTANT_KINDS.has(kind)) continue;
    if (!String(event.text || "").trim()) continue;
    const key = rowKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
  }
  return merged.sort((a, b) => a.daemon_seq - b.daemon_seq);
}

// Read-only transcript of a closed visible chat that a lane points at. It never
// joins the live session store, so it cannot be mistaken for (or redirected to)
// a running chat, and it has no composer.
export default function LaneHistoryScreen({
  target,
  connected,
  readHistory = requestLaneHistory,
  onClose,
  top,
  bottom,
}: {
  target: LaneHistoryTarget;
  connected: boolean;
  readHistory?: ReadHistory;
  onClose: () => void;
  top: number;
  bottom: number;
}) {
  const [rows, setRows] = useState<PentacleEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [more, setMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const epoch = useRef(0);
  const oldest = useRef<number | null>(null);
  const rawRows = useRef<PentacleEvent[]>([]);

  const load = useCallback(
    async (older: boolean) => {
      const mine = ++epoch.current;
      setLoading(true);
      setError(false);
      try {
        const page = await readHistory(target.streamId, target.generation, {
          limit: LANE_HISTORY_PAGE_LIMIT,
          ...(older && oldest.current !== null
            ? { beforeDaemonSeq: oldest.current }
            : {}),
        });
        if (mine !== epoch.current) return;
        const seqs = page
          .map((event) => event.daemon_seq)
          .filter(Number.isFinite);
        if (seqs.length)
          oldest.current = Math.min(...seqs, oldest.current ?? Infinity);
        rawRows.current = older ? [...page, ...rawRows.current] : page;
        setRows(mergeRows([], rawRows.current));
        setMore(page.length >= LANE_HISTORY_PAGE_LIMIT);
        setLoaded(true);
      } catch {
        if (mine === epoch.current) setError(true);
      } finally {
        if (mine === epoch.current) setLoading(false);
      }
    },
    [readHistory, target.streamId, target.generation],
  );

  useEffect(() => {
    // Every state field resets whenever the target or connection changes, so a
    // stale spinner, error, page cursor or row can never outlive its request.
    oldest.current = null;
    rawRows.current = [];
    setRows([]);
    setMore(false);
    setLoaded(false);
    setLoading(false);
    setError(false);
    if (connected) void load(false);
    return () => {
      epoch.current += 1;
    };
  }, [connected, load]);

  return (
    <View testID="lane-history-screen" style={styles.root}>
      <View style={[styles.header, { paddingTop: top }]}>
        <View style={styles.copy}>
          <Text style={styles.title} numberOfLines={1}>
            {target.title}
          </Text>
          <Text style={styles.caption}>READ-ONLY · CLOSED CHAT</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close history"
          onPress={onClose}
          style={styles.close}
        >
          <Text style={styles.closeText}>✕</Text>
        </Pressable>
      </View>
      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: bottom }]}
      >
        {more && !loading ? (
          <Pressable
            testID="lane-history-earlier"
            accessibilityRole="button"
            accessibilityLabel="Load earlier messages"
            onPress={() => void load(true)}
            style={styles.earlier}
          >
            <Text style={styles.earlierText}>LOAD EARLIER</Text>
          </Pressable>
        ) : null}
        {loading ? (
          <LeafLoading id="lane-history-loading" text="Loading chat history" />
        ) : null}
        {error ? (
          <View style={styles.notice}>
            <Text style={styles.noticeText}>Chat history unavailable</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry history"
              onPress={() => void load(false)}
            >
              <Text style={styles.earlierText}>RETRY</Text>
            </Pressable>
          </View>
        ) : null}
        {!loaded && !loading && !error ? (
          <Text style={styles.noticeText}>Waiting for connection…</Text>
        ) : null}
        {loaded && !loading && !error && rows.length === 0 ? (
          <Text style={styles.noticeText}>No retained messages</Text>
        ) : null}
        {rows.map((event) => {
          const update = parseLaneUpdateEvent(event);
          if (update)
            return <LaneUpdateCard key={rowKey(event)} update={update} />;
          const user = USER_KINDS.has(String(event.kind).toUpperCase());
          return (
            <View
              key={rowKey(event)}
              testID={`lane-history-row-${event.daemon_seq}`}
              style={user ? styles.userRow : styles.agentRow}
            >
              <Bevel
                fill={user ? `${Tokens.palette.green}12` : "transparent"}
                stroke={
                  user ? `${Tokens.palette.green}44` : Tokens.palette.line
                }
                contentStyle={styles.bubble}
              >
                <Text style={styles.text}>{event.text}</Text>
              </Bevel>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Tokens.palette.ink },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: `${Tokens.palette.green}33`,
  },
  copy: { flex: 1, minWidth: 0 },
  title: {
    fontFamily: Fonts.rajdhani.bold,
    fontSize: 17,
    color: Tokens.palette.text,
    lineHeight: 20,
  },
  caption: {
    fontFamily: Fonts.jetBrainsMono.regular,
    fontSize: 9.5,
    letterSpacing: 0.8,
    color: Tokens.palette.muted,
    marginTop: 3,
  },
  close: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: Tokens.palette.line,
    backgroundColor: Tokens.palette.panel,
    alignItems: "center",
    justifyContent: "center",
  },
  closeText: { color: Tokens.palette.muted, fontSize: 18 },
  body: { padding: 16, gap: 10 },
  earlier: { alignSelf: "center", paddingVertical: 8, paddingHorizontal: 12 },
  earlierText: {
    fontFamily: Fonts.jetBrainsMono.bold,
    fontSize: 10.5,
    letterSpacing: 1.2,
    color: Tokens.palette.green,
  },
  notice: { alignItems: "center", gap: 8, paddingVertical: 12 },
  noticeText: {
    fontFamily: Fonts.rajdhani.medium,
    fontSize: 14.5,
    color: Tokens.palette.muted,
    textAlign: "center",
  },
  userRow: { alignItems: "flex-end" },
  agentRow: { alignItems: "flex-start" },
  bubble: { paddingVertical: 9, paddingHorizontal: 12 },
  text: {
    fontFamily: Fonts.rajdhani.medium,
    fontSize: 14.5,
    lineHeight: 21,
    color: Tokens.palette.text,
  },
});
