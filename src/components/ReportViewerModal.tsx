import React, { useEffect, useMemo, useRef, useState } from "react";
import { logTelemetry } from "pentacle-chat-core";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Fonts, Tokens } from "@/constants/Colors";
import Starfield from "@/src/components/Starfield";
import {
  addReportComment,
  AssetComment,
  deleteReport,
  deleteReportComment,
  getReport,
  listReportComments,
  listReports,
  isReportSessionClosed,
  markReportRead,
  parseReportBody,
  PentacleReport,
  reportBlockText,
  reportRunText,
  ReportBlock,
  ReportRun,
  sendReportCommentsToChat,
  useSessionReports,
} from "@/src/services/pentacleAssets";

type Props = {
  visible: boolean;
  streamId: string;
  onClose: () => void;
  accent?: string;
  e2eTableTargets?: boolean;
};
type ActiveBlock = { assetId: string; sectionId: string; block: ReportBlock };
type Tone = "ok" | "warn" | "stop" | "info";

const RPT = {
  bg: "#0b120e",
  card: "#101a14",
  chipBg: "#17241c",
  chipBg2: "#141f19",
  line: "rgba(255,255,255,0.08)",
  lineSoft: "rgba(255,255,255,0.055)",
  head: "#e9f5ee",
  body: "#c8d9cf",
  body2: "#b9cec2",
  dim: "#93a89b",
  soft: "#68806f",
  ok: "#4ee38a",
  okText: "#7ee79f",
  warn: "#efc77b",
  stop: "#ff8b7c",
  info: "#6aa8ff",
  infoText: "#a9c9ff",
};
const T = {
  ink: "#080b0a",
  panel: "#0d1411",
  text: "#e6fff2",
  muted: "#7fa896",
  dim: "#9dc4b3",
  line: "rgba(120,255,160,0.16)",
  red: "#ff2e3e",
};

const REPORT_TABLE_MIN_WIDTH = 430;
const REPORT_TABLE_CELL_WIDTH = 143;
const REPORT_TABLE_METRICS = "report:table_metrics" as Parameters<typeof logTelemetry>[0];
const REPORT_TABLE_SCROLLED = "report:table_scrolled" as Parameters<typeof logTelemetry>[0];
const REPORT_TABLE_GESTURE = "report:table_gesture" as Parameters<typeof logTelemetry>[0];
const REPORT_COMMENT_KEYBOARD = "report:comment_keyboard" as Parameters<typeof logTelemetry>[0];
const REPORT_COMMENT_CONFIRMED = "report:comment_confirmed" as Parameters<typeof logTelemetry>[0];
const REPORT_COMMENT_FAILED = "report:comment_failed" as Parameters<typeof logTelemetry>[0];
const REPORT_COMMENTS_SENT = "report:comments_sent_to_chat" as Parameters<typeof logTelemetry>[0];
const REPORT_COMMENTS_SEND_FAILED = "report:comments_send_failed" as Parameters<typeof logTelemetry>[0];

function scenarioRunIdForBlock(blockId: string) {
  const separator = blockId.indexOf("--");
  return separator >= 0 ? blockId.slice(separator + 2) : "";
}
const TONE: Record<Tone, { color: string; bg: string; border: string }> = {
  ok: {
    color: RPT.ok,
    bg: "rgba(78,227,138,0.10)",
    border: "rgba(78,227,138,0.28)",
  },
  warn: {
    color: RPT.warn,
    bg: "rgba(239,199,123,0.11)",
    border: "rgba(239,199,123,0.30)",
  },
  stop: {
    color: RPT.stop,
    bg: "rgba(255,139,124,0.11)",
    border: "rgba(255,139,124,0.30)",
  },
  info: {
    color: RPT.info,
    bg: "rgba(106,168,255,0.11)",
    border: "rgba(106,168,255,0.30)",
  },
};
const STATUS: Record<string, [string, Tone]> = {
  dispatched: ["Dispatched", "ok"],
  in_progress: ["In progress", "warn"],
  stalled: ["Stalled", "stop"],
  blocked: ["Blocked", "stop"],
  reference: ["Reference", "info"],
  fixed: ["Fixed", "ok"],
  verified: ["Verified", "ok"],
  done: ["Done", "ok"],
  attention: ["Review", "warn"],
};

function reportAge(value?: string) {
  const time = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) return "unknown age";
  const mins = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / (24 * 60))}d ago`;
}

function statusMeta(status?: string): [string, Tone] {
  return STATUS[status || ""] || [status || "Reference", "info"];
}

function StatusChip({ status }: { status: string }) {
  const [label, tone] = statusMeta(status);
  const palette = TONE[tone];
  return (
    <View
      style={[
        styles.statusChip,
        { backgroundColor: palette.bg, borderColor: palette.border },
      ]}
    >
      <View style={[styles.toneDot, { backgroundColor: palette.color }]} />
      <Text style={[styles.statusText, { color: palette.color }]}>{label}</Text>
    </View>
  );
}

function Runs({ runs = [] }: { runs?: ReportRun[] }) {
  return (
    <Text style={styles.inlineText}>
      {runs.map((run, index) => {
        const value = reportRunText(run);
        const item = typeof run === "string" ? null : run;
        const type = item?.type || (item?.chip ? "chip" : "text");
        const tone = item?.status && TONE[item.status as Tone];
        const glyph =
          item?.kind === "epic"
            ? "◆ "
            : item?.kind === "branch"
              ? "⎇ "
              : item?.kind === "db"
                ? "⛁ "
                : item?.kind === "story"
                  ? "◇ "
                  : item?.kind === "file"
                    ? "⌗ "
                    : "";
        const link = Boolean(
          item?.href && (type === "link" || item?.variant === "link"),
        );
        return (
          <Text
            key={index}
            onPress={link ? () => void Linking.openURL(item!.href!) : undefined}
            style={
              type === "chip"
                ? [
                    styles.inlineChip,
                    tone && {
                      color: tone.color,
                      backgroundColor: tone.bg,
                      borderColor: tone.border,
                    },
                  ]
                : type === "code"
                  ? styles.codeRun
                  : link
                    ? styles.linkRun
                    : undefined
            }
          >
            {glyph}
            {value}
            {link ? " ↗" : ""}
          </Text>
        );
      })}
    </Text>
  );
}

function BlockBody({ block, e2eTableTargets = false }: { block: ReportBlock; e2eTableTargets?: boolean }) {
  if (block.type === "list")
    return (
      <View style={styles.list}>
        {(block.items || []).map((item, index) => (
          <View key={index} style={styles.listRow}>
            <Text style={block.ordered ? styles.listNumber : styles.listBullet}>
              {block.ordered ? index + 1 : "●"}
            </Text>
            <Runs runs={typeof item === "string" ? [item] : item} />
          </View>
        ))}
      </View>
    );
  if (block.type === "table") {
    const scenarioRunId = block.id.startsWith("wide-matrix--")
      ? block.id.slice("wide-matrix--".length)
      : "";
    const columns = (block.columns || []).map((column) =>
      typeof column === "string" ? column : column.label || column.key || "",
    );
    const tableWidth = Math.max(
      REPORT_TABLE_MIN_WIDTH,
      columns.length * REPORT_TABLE_CELL_WIDTH,
    );
    return (
      <ScrollView
        testID={e2eTableTargets ? undefined : `report-table-scroll-${block.id}`}
        contentContainerStyle={styles.tableScrollContent}
        horizontal
        pagingEnabled
        style={styles.tableScroll}
        showsHorizontalScrollIndicator={false}
        onLayout={(event) =>
          logTelemetry(REPORT_TABLE_METRICS, {
            block_id: block.id,
            content_width: tableWidth,
            viewport_width: event.nativeEvent.layout.width,
            scenario_run_id: scenarioRunId,
          })
        }
        onTouchMove={() =>
          logTelemetry(REPORT_TABLE_GESTURE, {
            block_id: block.id,
            scenario_run_id: scenarioRunId,
          })
        }
        onScroll={(event) =>
          logTelemetry(REPORT_TABLE_SCROLLED, {
            block_id: block.id,
            offset_x: event.nativeEvent.contentOffset.x,
            scenario_run_id: scenarioRunId,
          })
        }
        scrollEventThrottle={16}
      >
        <View testID={e2eTableTargets ? undefined : `report-table-content-${block.id}`} style={[styles.table, { width: tableWidth }]}>
          {e2eTableTargets ? (
            <View
              accessible
              accessibilityLabel="Report table content geometry"
              collapsable={false}
              pointerEvents="none"
              testID={`report-table-content-${block.id}`}
              style={styles.tableHarnessContentGeometry}
            />
          ) : null}
          {e2eTableTargets ? (
            <View
              accessible
              accessibilityLabel="Report table right-edge geometry"
              collapsable={false}
              pointerEvents="none"
              testID={`report-table-right-edge-${block.id}`}
              style={styles.tableHarnessRightEdgeGeometry}
            />
          ) : null}
          {columns.length ? (
            <View style={styles.tableRow}>
              {columns.map((column, index) => (
                <Text
                  key={index}
                  accessible={e2eTableTargets ? false : undefined}
                  testID={index === columns.length - 1 && !e2eTableTargets ? `report-table-right-edge-${block.id}` : undefined}
                  style={[styles.tableCell, styles.tableHeader]}
                >
                  {column}
                </Text>
              ))}
            </View>
          ) : null}
          {(block.rows || []).map((row, rowIndex) => (
            <View
              key={rowIndex}
              style={[styles.tableRow, rowIndex > 0 && styles.tableDivider]}
            >
              {row.map((cell, index) => (
                <View key={index} style={styles.tableCell}>
                  <Runs runs={cell} />
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    );
  }
  if (block.type === "callout") {
    const tone =
      (block as ReportBlock & { tone?: string }).tone === "warn"
        ? TONE.warn
        : TONE.info;
    return (
      <View
        style={[
          styles.callout,
          {
            backgroundColor:
              tone === TONE.warn
                ? "rgba(239,199,123,0.07)"
                : "rgba(106,168,255,0.07)",
            borderColor:
              tone === TONE.warn
                ? "rgba(239,199,123,0.26)"
                : "rgba(106,168,255,0.24)",
          },
        ]}
      >
        <Text style={[styles.calloutTitle, { color: tone.color }]}>
          {tone === TONE.warn ? "⚠ " : "ℹ "}
          {block.title}
        </Text>
        <Runs runs={block.runs} />
      </View>
    );
  }
  return <Runs runs={block.runs} />;
}

function ThreadSheet({
  active,
  comments,
  accent,
  e2eTargets,
  onClose,
  onAdd,
  onDelete,
  onSend,
  readOnly,
}: {
  active: ActiveBlock | null;
  comments: AssetComment[];
  accent: string;
  e2eTargets: boolean;
  onClose: () => void;
  onAdd: (body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onSend: () => Promise<void>;
  readOnly: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const commentListRef = useRef<ScrollView>(null);
  const commentInputRef = useRef<TextInput>(null);
  const blockComments = active
    ? comments.filter(
        (comment) =>
          comment.section_id === active.sectionId &&
          comment.block_id === active.block.id,
      )
    : [];
  useEffect(
    () => setDraft(""),
    [active?.assetId, active?.sectionId, active?.block.id],
  );
  useEffect(() => {
    if (!active) return;
    const subscription = Keyboard.addListener("keyboardDidShow", (event) => {
      commentInputRef.current?.measureInWindow((_x, y, _width, height) => {
        const keyboardTop = event.endCoordinates.screenY;
        const inputBottom = y + height;
        logTelemetry(REPORT_COMMENT_KEYBOARD, {
          block_id: active.block.id,
          scenario_run_id: scenarioRunIdForBlock(active.block.id),
          keyboard_top: keyboardTop,
          input_bottom: inputBottom,
          unobscured: inputBottom <= keyboardTop,
        });
      });
    });
    return () => subscription.remove();
  }, [active]);
  if (!active) return null;
  const persistDraft = async () => {
    const body = draft.trim();
    if (!body) return true;
    setDraft("");
    try {
      await onAdd(body);
      return true;
    } catch (error) {
      setDraft(body);
      Alert.alert(
        "Comment not sent",
        error instanceof Error ? error.message : "Try again.",
      );
      return false;
    }
  };
  const submit = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    try {
      await persistDraft();
    } finally {
      setSending(false);
    }
  };
  const canSendToChat =
    !readOnly && (comments.length > 0 || Boolean(draft.trim()));
  const sendToChat = async () => {
    if (readOnly || !canSendToChat || sending) return;
    setSending(true);
    try {
      if (!(await persistDraft())) return;
      await onSend();
    } finally {
      setSending(false);
    }
  };
  return (
    <View style={styles.modalLayer}>
      <KeyboardAvoidingView
        testID="report-comment-keyboard-avoider"
        style={styles.keyboardAvoider}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        enabled={Platform.OS === "ios"}
      >
        <View style={styles.sheetModal} testID="report-comment-sheet">
        <Pressable style={styles.sheetBackdrop} onPress={onClose} />
        <View style={styles.threadSheet}>
          <View style={styles.threadHeader}>
            <View style={styles.threadHeading}>
              <Text style={styles.threadEyebrow}>COMMENT THREAD</Text>
              <Text style={styles.blockPreview} numberOfLines={2}>
                {reportBlockText(active.block)}
              </Text>
            </View>
            <Pressable onPress={onClose} style={styles.threadClose}>
              <Text style={styles.threadCloseText}>✕</Text>
            </Pressable>
          </View>
          <ScrollView
            ref={commentListRef}
            testID="report-comment-list"
            style={styles.commentList}
            contentContainerStyle={styles.commentListContent}
            automaticallyAdjustKeyboardInsets={false}
            keyboardShouldPersistTaps="handled"
          >
            {blockComments.length ? (
              blockComments.map((comment) => {
                const own = comment.author.startsWith("operator@");
                return (
                  <View
                    key={comment.comment_id}
                    style={styles.commentCard}
                  >
                    {e2eTargets ? (
                      <View
                        accessible
                        accessibilityLabel="Confirmed report comment"
                        collapsable={false}
                        pointerEvents="none"
                        style={StyleSheet.absoluteFillObject}
                        testID={`report-comment-${comment.comment_id}`}
                      />
                    ) : null}
                    <View style={styles.commentHeader}>
                      <View
                        style={[
                          styles.avatar,
                          {
                            backgroundColor: own
                              ? "rgba(78,227,138,0.16)"
                              : "rgba(106,168,255,0.14)",
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.avatarText,
                            { color: own ? RPT.okText : RPT.infoText },
                          ]}
                        >
                          {own ? "Y" : "A"}
                        </Text>
                      </View>
                      <Text
                        style={
                          own ? styles.commentAuthorYou : styles.commentAuthor
                        }
                      >
                        {own ? "You" : comment.author}
                      </Text>
                      <Text style={styles.commentTime}>
                        {comment.created_at
                          ? reportAge(comment.created_at)
                          : "now"}
                      </Text>
                      {own &&
                      !readOnly &&
                      !comment.comment_id.startsWith("optimistic:") ? (
                        <Pressable
                          testID={`delete-comment-${comment.comment_id}`}
                          onPress={() => void onDelete(comment.comment_id)}
                        >
                          <Text style={styles.deleteComment}>delete</Text>
                        </Pressable>
                      ) : null}
                    </View>
                    <Text style={styles.commentBody}>{comment.body}</Text>
                  </View>
                );
              })
            ) : (
              <Text style={styles.emptyThread}>
                No comments yet. Add the first one below.
              </Text>
            )}
          </ScrollView>
          {!readOnly ? (
            <Pressable
              testID="report-thread-send-to-chat"
              style={[
                styles.sendToChat,
                { backgroundColor: `${accent}16`, borderColor: `${accent}55` },
                (!canSendToChat || sending) && styles.commentButtonDisabled,
              ]}
              disabled={!canSendToChat || sending}
              onPress={() => void sendToChat()}
            >
              <Text
                style={[styles.sendToChatText, { color: accent }]}
              >
                {sending ? "Sending…" : "Send comments to chat ✈"}
              </Text>
            </Pressable>
          ) : null}
          {readOnly ? (
            <Text style={styles.closedThread}>
              This session is closed. Existing comments remain readable.
            </Text>
          ) : (
            <View style={styles.composer}>
              <TextInput
                ref={commentInputRef}
                testID="report-comment-input"
                value={draft}
                onChangeText={setDraft}
                onFocus={() =>
                  commentListRef.current?.scrollToEnd({ animated: true })
                }
                placeholder="Add a comment"
                placeholderTextColor={RPT.soft}
                style={styles.commentInput}
                multiline
              />
              <Pressable
                testID="report-comment-send"
                style={[
                  styles.commentButton,
                  (!draft.trim() || sending) && styles.commentButtonDisabled,
                ]}
                onPress={() => void submit()}
                disabled={!draft.trim() || sending}
              >
                <Text
                  style={[
                    styles.commentButtonText,
                    (!draft.trim() || sending) &&
                      styles.commentButtonTextDisabled,
                  ]}
                >
                  {sending ? "…" : "Comment"}
                </Text>
              </Pressable>
            </View>
          )}
        </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

export default function ReportViewerModal({
  visible,
  streamId,
  onClose,
  accent = Tokens.palette.green,
  e2eTableTargets = false,
}: Props) {
  const reports = useSessionReports(streamId);
  const sessionClosed = isReportSessionClosed(streamId);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [fullReport, setFullReport] = useState<PentacleReport | null>(null);
  const [comments, setComments] = useState<AssetComment[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [activeBlock, setActiveBlock] = useState<ActiveBlock | null>(null);
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeMeta =
    reports.find((report) => report.asset_id === activeId) ||
    reports[0] ||
    null;
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    listReports(streamId)
      .then((items) => {
        if (!cancelled)
          setActiveId((current) =>
            items.some((item) => item.asset_id === current)
              ? current
              : (
                  items.find((item) => item.read !== true && !item.read_at) ||
                  items[0]
                )?.asset_id || null,
          );
      })
      .catch(
        (cause) =>
          !cancelled &&
          setError(
            cause instanceof Error ? cause.message : "Could not load reports",
          ),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [visible, streamId]);
  useEffect(() => {
    if (activeBlock && activeBlock.assetId !== activeId) setActiveBlock(null);
  }, [activeBlock, activeId]);
  useEffect(() => {
    if (!visible || !activeMeta) {
      if (visible && reports.length === 0) setFullReport(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all([
      getReport(streamId, activeMeta),
      listReportComments(streamId, activeMeta),
    ])
      .then(([report, next]) => {
        if (!cancelled) {
          setFullReport(report);
          setComments(next);
          setError(null);
          void markReportRead(streamId, report).catch(() => undefined);
        }
      })
      .catch(
        (cause) =>
          !cancelled &&
          setError(
            cause instanceof Error ? cause.message : "Could not open report",
          ),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [visible, streamId, activeMeta?.asset_id, activeMeta?.updated_at]);
  useEffect(() => {
    if (
      visible &&
      reports.length > 0 &&
      activeId &&
      !reports.some((report) => report.asset_id === activeId)
    )
      setActiveId(reports[0]?.asset_id || null);
    if (visible && reports.length === 0 && !loading) onClose();
  }, [activeId, loading, onClose, reports, visible]);
  const body = useMemo(() => {
    try {
      return fullReport ? parseReportBody(fullReport) : null;
    } catch {
      return null;
    }
  }, [fullReport]);
  const countByBlock = useMemo(
    () =>
      comments.reduce((counts, comment) => {
        const key = `${comment.section_id}:${comment.block_id}`;
        counts.set(key, (counts.get(key) || 0) + 1);
        return counts;
      }, new Map<string, number>()),
    [comments],
  );
  const addComment = async (text: string) => {
    if (
      !fullReport ||
      !activeBlock ||
      activeBlock.assetId !== fullReport.asset_id
    )
      return;
    const temp: AssetComment = {
      comment_id: `optimistic:${Date.now()}`,
      asset_id: fullReport.asset_id,
      section_id: activeBlock.sectionId,
      block_id: activeBlock.block.id,
      excerpt: reportBlockText(activeBlock.block),
      body: text,
      author: "operator@mobile",
    };
    setComments((current) => [...current, temp]);
    try {
      const confirmed = await addReportComment({
        streamId,
        report: fullReport,
        sectionId: activeBlock.sectionId,
        blockId: activeBlock.block.id,
        excerpt: temp.excerpt,
        body: text,
      });
      setComments((current) =>
        current.map((comment) =>
          comment.comment_id === temp.comment_id ? confirmed : comment,
        ),
      );
      logTelemetry(REPORT_COMMENT_CONFIRMED, {
        block_id: activeBlock.block.id,
        comment_id: confirmed.comment_id,
        body: confirmed.body,
        scenario_run_id: scenarioRunIdForBlock(activeBlock.block.id),
      });
    } catch (cause) {
      setComments((current) =>
        current.filter((comment) => comment.comment_id !== temp.comment_id),
      );
      logTelemetry(REPORT_COMMENT_FAILED, {
        block_id: activeBlock.block.id,
        detail: cause instanceof Error ? cause.message : String(cause),
        scenario_run_id: scenarioRunIdForBlock(activeBlock.block.id),
      });
      throw cause;
    }
  };
  const removeComment = async (id: string) => {
    if (!fullReport) return;
    await deleteReportComment(streamId, fullReport, id);
    setComments((current) =>
      current.filter((comment) => comment.comment_id !== id),
    );
  };
  const sendComments = async () => {
    if (!fullReport) return;
    try {
      const result = await sendReportCommentsToChat(streamId, fullReport);
      logTelemetry(REPORT_COMMENTS_SENT, {
        asset_id: fullReport.asset_id,
        sent_count: Number((result as { sent_count?: number }).sent_count ?? comments.length),
        scenario_run_id: activeBlock ? scenarioRunIdForBlock(activeBlock.block.id) : "",
      });
      Alert.alert("Comments sent", "Report comments were sent to the chat.");
    } catch (cause) {
      logTelemetry(REPORT_COMMENTS_SEND_FAILED, {
        asset_id: fullReport.asset_id,
        detail: cause instanceof Error ? cause.message : String(cause),
        scenario_run_id: activeBlock ? scenarioRunIdForBlock(activeBlock.block.id) : "",
      });
      Alert.alert(
        "Comments not sent",
        cause instanceof Error ? cause.message : "Try again.",
      );
    }
  };
  const performDelete = async () => {
    if (!fullReport) return;
    setDeleteConfirmVisible(false);
    try {
      await deleteReport(streamId, fullReport);
    } catch (cause) {
      Alert.alert(
        "Report not deleted",
        cause instanceof Error ? cause.message : "Try again.",
      );
    }
  };
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <View style={styles.overlay} testID="report-viewer">
        <Starfield />
        <View style={styles.readerFrame}>
          <View
            style={[styles.readerHeader, { borderBottomColor: `${accent}33` }]}
          >
            <Pressable
              testID="report-close"
              onPress={onClose}
              style={styles.closeButton}
            >
              <Text style={styles.closeGlyph}>×</Text>
            </Pressable>
            <View style={styles.headerCopy}>
              <Text
                testID="report-reader-title"
                style={styles.readerTitle}
                numberOfLines={1}
              >
                {body?.title || fullReport?.title || "Reports"}
              </Text>
              {fullReport ? (
                <Text
                  testID="report-header-meta"
                  style={styles.readerMeta}
                  numberOfLines={1}
                >
                  {fullReport.producer || "child agent"} ·{" "}
                  {reportAge(fullReport.updated_at || fullReport.created_at)}
                </Text>
              ) : null}
            </View>
            {fullReport && !sessionClosed ? (
              <Pressable
                testID="report-delete"
                onPress={() => setDeleteConfirmVisible(true)}
                style={styles.deleteButton}
              >
                <Text style={styles.trashGlyph}>⌫</Text>
              </Pressable>
            ) : (
              <View style={styles.deleteButton} />
            )}
          </View>
          <ScrollView
            testID="report-chip-rail"
            horizontal
            style={[styles.rail, { borderBottomColor: `${accent}22` }]}
            contentContainerStyle={styles.railContent}
            showsHorizontalScrollIndicator={false}
          >
            {reports.map((report) => {
              const unread =
                (typeof report.read === "boolean" ||
                  report.read_at !== undefined) &&
                report.read !== true &&
                !report.read_at;
              return (
                <Pressable
                  key={report.asset_id}
                  testID={`report-chip-${report.asset_id}`}
                  style={[
                    styles.chip,
                    {
                      borderColor:
                        activeMeta?.asset_id === report.asset_id
                          ? accent
                          : T.line,
                      backgroundColor:
                        activeMeta?.asset_id === report.asset_id
                          ? `${accent}16`
                          : "transparent",
                    },
                  ]}
                  onPress={() => setActiveId(report.asset_id)}
                >
                  {unread ? (
                    <View style={styles.unreadWrap}>
                      <View
                        style={[styles.unreadPing, { borderColor: accent }]}
                      />
                      <View
                        style={[styles.unreadDot, { backgroundColor: accent }]}
                      />
                    </View>
                  ) : null}
                  <Text
                    style={[
                      styles.chipText,
                      {
                        color:
                          activeMeta?.asset_id === report.asset_id
                            ? accent
                            : T.dim,
                      },
                    ]}
                    numberOfLines={1}
                  >
                    {report.title}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
          {loading && !body ? (
            <ActivityIndicator testID="report-body-loading" style={styles.loader} color={RPT.ok} />
          ) : null}
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          {sessionClosed ? (
            <Text style={styles.closedText}>Session closed · read only</Text>
          ) : null}
          {!loading && reports.length === 0 ? (
            <Text style={styles.emptyText}>
              No reports from child agents yet.
            </Text>
          ) : null}
          {body ? (
            <ScrollView
              key={fullReport?.asset_id}
              style={styles.document}
              contentContainerStyle={styles.documentContent}
            >
              {
                <View style={styles.kickerRow}>
                  <View style={styles.kickerRule} />
                  <Text style={styles.kicker}>AGENT REPORT</Text>
                </View>
              }
              <Text testID="report-document-title" style={styles.documentTitle}>
                {body.title}
              </Text>
              {body.sections.map((section, sectionIndex) => {
                const sectionKey = `${activeMeta?.asset_id || ""}:${section.id}`;
                const closed = collapsed.has(sectionKey);
                return (
                  <View key={section.id} style={styles.section}>
                    <Pressable
                      testID={`report-section-${section.id}`}
                      style={styles.sectionHeader}
                      onPress={() =>
                        setCollapsed((current) => {
                          const next = new Set(current);
                          next.has(sectionKey)
                            ? next.delete(sectionKey)
                            : next.add(sectionKey);
                          return next;
                        })
                      }
                    >
                      <Text style={[styles.caret, !closed && styles.caretOpen]}>
                        ▸
                      </Text>
                      <Text style={styles.sectionNumber}>
                        {String(sectionIndex + 1).padStart(2, "0")}
                      </Text>
                      <Text style={styles.sectionTitle}>{section.title}</Text>
                      {section.status ? (
                        <StatusChip status={section.status} />
                      ) : null}
                    </Pressable>
                    {!closed
                      ? section.blocks.map((block) => {
                        const count =
                          countByBlock.get(`${section.id}:${block.id}`) || 0;
                        const openThread = () =>
                          setActiveBlock({
                            assetId: activeMeta?.asset_id || "",
                            sectionId: section.id,
                            block,
                          });
                        if (block.type === "table") {
                          return (
                            <View
                              key={block.id}
                              testID={`report-block-${block.id}`}
                              style={[
                                styles.block,
                                count > 0 && styles.commentedBlock,
                              ]}
                            >
                              <View style={styles.tableInteractionRegion}>
                                <BlockBody block={block} e2eTableTargets={e2eTableTargets} />
                                {e2eTableTargets ? (
                                  <View
                                    accessible
                                    accessibilityLabel="Report table horizontal scroll viewport"
                                    collapsable={false}
                                    pointerEvents="none"
                                    testID={`report-table-scroll-${block.id}`}
                                    style={styles.tableHarnessViewport}
                                  />
                                ) : null}
                              </View>
                              <Pressable
                                accessibilityLabel="Comment on report table"
                                accessibilityRole="button"
                                onPress={openThread}
                                style={styles.tableCommentAction}
                                testID={`report-table-comment-${block.id}`}
                              >
                                <Text style={styles.tableCommentActionText}>
                                  {count ? `COMMENTS ${count}` : "COMMENT"}
                                </Text>
                              </Pressable>
                            </View>
                          );
                        }
                        if (e2eTableTargets) {
                          return (
                            <View
                              collapsable={false}
                              key={block.id}
                              pointerEvents="box-none"
                              testID={`report-block-harness-${block.id}`}
                            >
                              <Pressable
                                accessible={false}
                                onPress={openThread}
                                style={[
                                  styles.block,
                                  count > 0 && styles.commentedBlock,
                                ]}
                                testID={`report-block-interaction-${block.id}`}
                              >
                                {count ? (
                                  <Text style={styles.commentBadge}>{count}</Text>
                                ) : null}
                                <BlockBody block={block} e2eTableTargets />
                              </Pressable>
                              <View
                                accessible
                                accessibilityLabel="Report block comment target"
                                collapsable={false}
                                pointerEvents="none"
                                style={StyleSheet.absoluteFillObject}
                                testID={`report-block-${block.id}`}
                              />
                            </View>
                          );
                        }
                        return (
                          <Pressable
                            key={block.id}
                            onPress={openThread}
                            style={[
                              styles.block,
                              count > 0 && styles.commentedBlock,
                            ]}
                            testID={`report-block-${block.id}`}
                          >
                            {count ? (
                              <Text style={styles.commentBadge}>{count}</Text>
                            ) : null}
                            <BlockBody block={block} />
                          </Pressable>
                        );
                        })
                      : null}
                  </View>
                );
              })}
            </ScrollView>
          ) : null}
        </View>
        {deleteConfirmVisible ? (
          <View style={styles.sheetModal}>
            <Pressable style={styles.confirmBackdrop} onPress={() => setDeleteConfirmVisible(false)} />
            <View style={styles.confirmSheet}>
              <View style={styles.deleteBadge}>
                <Text style={styles.deleteBadgeText}>⌫</Text>
              </View>
              <Text style={styles.confirmTitle}>Delete this report?</Text>
              <Text style={styles.confirmText}>
                “{fullReport?.title}” from{" "}
                {fullReport?.producer || "this agent"} is removed from this
                session. The child agent’s copy stays in the ledger.
              </Text>
              <View style={styles.confirmButtons}>
                <Pressable
                  testID="report-delete-cancel"
                  style={styles.cancelButton}
                  onPress={() => setDeleteConfirmVisible(false)}
                >
                  <Text style={styles.cancelText}>Cancel</Text>
                </Pressable>
                <Pressable
                  testID="report-delete-confirm"
                  style={styles.destructiveButton}
                  onPress={() => void performDelete()}
                >
                  <Text style={styles.destructiveText}>Delete</Text>
                </Pressable>
              </View>
            </View>
          </View>
        ) : null}
        <ThreadSheet
          active={activeBlock}
          comments={comments}
          accent={accent}
          e2eTargets={e2eTableTargets}
          onClose={() => setActiveBlock(null)}
          onAdd={addComment}
          onDelete={removeComment}
          onSend={sendComments}
          readOnly={sessionClosed}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: T.ink },
  readerFrame: { flex: 1, backgroundColor: T.panel },
  readerHeader: {
    minHeight: 97,
    paddingTop: 52,
    paddingHorizontal: 12,
    paddingBottom: 11,
    borderBottomWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: T.ink,
  },
  closeButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: T.line,
    alignItems: "center",
    justifyContent: "center",
  },
  closeGlyph: { color: T.dim, fontSize: 22, lineHeight: 24 },
  headerCopy: { flex: 1 },
  readerTitle: {
    color: T.text,
    fontFamily: Fonts.rajdhani.bold,
    fontSize: 16.5,
    lineHeight: 19,
  },
  readerMeta: {
    marginTop: 2,
    color: T.muted,
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 10,
    letterSpacing: 0.5,
  },
  deleteButton: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  trashGlyph: { color: T.dim, fontSize: 20 },
  rail: { flexGrow: 0, borderBottomWidth: 1, backgroundColor: T.ink },
  railContent: { gap: 8, paddingVertical: 10, paddingHorizontal: 14 },
  chip: {
    maxWidth: 150,
    minHeight: 30,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 7,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  chipText: { fontFamily: Fonts.rajdhani.bold, fontSize: 13 },
  unreadWrap: {
    width: 8,
    height: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  unreadDot: { width: 6, height: 6, borderRadius: 3 },
  unreadPing: {
    position: "absolute",
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1,
    opacity: 0.65,
    transform: [{ scale: 1.5 }],
  },
  loader: { marginTop: 28 },
  errorText: {
    margin: 20,
    color: RPT.stop,
    fontFamily: Fonts.report.bodyMedium,
  },
  closedText: {
    padding: 10,
    backgroundColor: RPT.chipBg2,
    color: RPT.warn,
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 11,
    textAlign: "center",
  },
  emptyText: {
    padding: 24,
    color: RPT.soft,
    fontFamily: Fonts.report.bodyRegular,
    textAlign: "center",
  },
  document: { flex: 1, backgroundColor: RPT.bg },
  documentContent: { paddingTop: 20, paddingHorizontal: 16, paddingBottom: 46 },
  documentTitle: {
    marginBottom: 12,
    color: RPT.head,
    fontFamily: Fonts.report.displaySemiBold,
    fontSize: 25,
    lineHeight: 28,
    letterSpacing: -0.5,
  },
  kickerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 14,
  },
  kickerRule: { width: 18, height: 1, backgroundColor: RPT.ok, opacity: 0.6 },
  kicker: {
    color: RPT.ok,
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 11,
    letterSpacing: 1.32,
  },
  section: {
    borderBottomWidth: 1,
    borderBottomColor: RPT.lineSoft,
    paddingBottom: 12,
    marginBottom: 8,
  },
  sectionHeader: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  caret: { color: RPT.soft, fontSize: 10, transform: [{ rotate: "0deg" }] },
  caretOpen: { transform: [{ rotate: "90deg" }] },
  sectionNumber: {
    color: RPT.ok,
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 12,
  },
  sectionTitle: {
    flex: 1,
    color: RPT.head,
    fontFamily: Fonts.report.displaySemiBold,
    fontSize: 18,
  },
  statusChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1,
    borderRadius: 20,
    paddingTop: 2,
    paddingRight: 9,
    paddingBottom: 2,
    paddingLeft: 8,
  },
  toneDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontFamily: Fonts.jetBrainsMono.medium, fontSize: 11 },
  block: {
    position: "relative",
    marginTop: 1,
    marginHorizontal: -8,
    marginBottom: 6,
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderRadius: 9,
  },
  commentedBlock: {
    paddingRight: 38,
    backgroundColor: "rgba(106,168,255,0.05)",
    borderLeftWidth: 2,
    borderLeftColor: "rgba(106,168,255,0.55)",
  },
  commentBadge: {
    position: "absolute",
    right: 8,
    top: 5,
    minWidth: 24,
    height: 24,
    paddingHorizontal: 5,
    paddingTop: 3,
    overflow: "hidden",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(106,168,255,0.4)",
    backgroundColor: "rgba(106,168,255,0.16)",
    color: RPT.infoText,
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 12,
    textAlign: "center",
  },
  inlineText: {
    color: RPT.body,
    fontFamily: Fonts.report.bodyRegular,
    fontSize: 15,
    lineHeight: 26,
  },
  inlineChip: {
    marginHorizontal: 2,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: "hidden",
    borderRadius: 6,
    borderWidth: 1,
    borderColor: RPT.chipBg,
    backgroundColor: RPT.chipBg,
    color: RPT.body2,
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 12,
  },
  codeRun: {
    paddingHorizontal: 4,
    borderRadius: 3,
    backgroundColor: RPT.chipBg,
    color: RPT.body2,
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 12,
  },
  linkRun: { color: RPT.okText, textDecorationLine: "underline" },
  list: { gap: 10 },
  listRow: { flexDirection: "row", gap: 9 },
  listNumber: {
    width: 24,
    height: 24,
    borderRadius: 7,
    paddingTop: 4,
    overflow: "hidden",
    backgroundColor: "rgba(78,227,138,0.12)",
    color: RPT.okText,
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 12.5,
    textAlign: "center",
  },
  listBullet: {
    width: 14,
    color: RPT.ok,
    fontSize: 9,
    paddingTop: 7,
    opacity: 0.8,
  },
  table: {
    minWidth: REPORT_TABLE_MIN_WIDTH,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: RPT.line,
    borderRadius: 12,
    backgroundColor: RPT.card,
  },
  tableScroll: { width: "100%", maxWidth: "100%", alignSelf: "stretch" },
  tableScrollContent: { paddingRight: 12 },
  tableInteractionRegion: { position: "relative" },
  tableCommentAction: {
    alignSelf: "flex-end",
    marginTop: 5,
    paddingVertical: 5,
    paddingHorizontal: 8,
  },
  tableCommentActionText: {
    color: RPT.soft,
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 10,
  },
  tableHarnessViewport: {
    ...StyleSheet.absoluteFillObject,
  },
  tableHarnessContentGeometry: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    height: 1,
  },
  tableHarnessRightEdgeGeometry: {
    position: "absolute",
    right: 0,
    top: 0,
    width: 4,
    height: 38,
  },
  tableRow: { flexDirection: "row" },
  tableDivider: { borderTopWidth: 1, borderTopColor: RPT.lineSoft },
  tableCell: {
    width: REPORT_TABLE_CELL_WIDTH,
    minHeight: 38,
    paddingVertical: 9,
    paddingHorizontal: 13,
    justifyContent: "center",
  },
  tableHeader: {
    color: RPT.soft,
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 10.5,
    letterSpacing: 1.05,
    textTransform: "uppercase",
    borderBottomWidth: 1,
    borderBottomColor: RPT.line,
  },
  callout: {
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 15,
  },
  calloutTitle: {
    marginBottom: 5,
    fontFamily: Fonts.report.displaySemiBold,
    fontSize: 13.5,
  },
  modalLayer: { ...StyleSheet.absoluteFillObject, zIndex: 10 },
  keyboardAvoider: { flex: 1 },
  sheetModal: { flex: 1, justifyContent: "flex-end" },
  sheetBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  threadSheet: {
    maxHeight: "80%",
    minHeight: 60,
    overflow: "hidden",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.1)",
    backgroundColor: "#0e1611",
  },
  threadHeader: {
    paddingTop: 16,
    paddingHorizontal: 18,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: RPT.line,
    flexDirection: "row",
    gap: 12,
  },
  threadHeading: { flex: 1 },
  threadEyebrow: {
    color: RPT.info,
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 10.5,
    letterSpacing: 1.26,
  },
  blockPreview: {
    marginTop: 5,
    color: RPT.dim,
    fontFamily: Fonts.report.bodyRegular,
    fontSize: 12.5,
    lineHeight: 18,
  },
  threadClose: {
    width: 28,
    height: 28,
    borderWidth: 1,
    borderColor: RPT.line,
    borderRadius: 8,
    backgroundColor: RPT.chipBg,
    alignItems: "center",
    justifyContent: "center",
  },
  threadCloseText: { color: RPT.dim, fontSize: 14 },
  commentList: { maxHeight: 270 },
  commentListContent: { padding: 14, paddingHorizontal: 18, gap: 11 },
  emptyThread: {
    minHeight: 60,
    color: RPT.soft,
    fontFamily: Fonts.report.bodyRegular,
    fontSize: 13.5,
    textAlign: "center",
  },
  commentCard: {
    paddingVertical: 12,
    paddingHorizontal: 13,
    borderWidth: 1,
    borderColor: RPT.lineSoft,
    borderRadius: 12,
    backgroundColor: RPT.card,
  },
  commentHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 6,
  },
  avatar: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontFamily: Fonts.jetBrainsMono.medium, fontSize: 11 },
  commentAuthor: {
    color: RPT.infoText,
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 12,
  },
  commentAuthorYou: {
    color: RPT.okText,
    fontFamily: Fonts.report.bodyMedium,
    fontSize: 12,
  },
  commentTime: {
    flex: 1,
    color: RPT.soft,
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 10.5,
  },
  deleteComment: {
    color: RPT.stop,
    fontFamily: Fonts.jetBrainsMono.medium,
    fontSize: 10.5,
  },
  commentBody: {
    color: RPT.body,
    fontFamily: Fonts.report.bodyRegular,
    fontSize: 14,
    lineHeight: 22,
  },
  sendToChat: {
    height: 40,
    marginHorizontal: 18,
    marginTop: 4,
    borderWidth: 1,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  sendToChatText: { fontFamily: Fonts.report.bodyMedium, fontSize: 13.5 },
  closedThread: {
    padding: 18,
    paddingBottom: 26,
    color: RPT.soft,
    fontFamily: Fonts.report.bodyRegular,
    fontSize: 13.5,
    textAlign: "center",
  },
  composer: {
    paddingTop: 12,
    paddingHorizontal: 18,
    paddingBottom: 26,
    borderTopWidth: 1,
    borderTopColor: RPT.line,
  },
  commentInput: {
    minHeight: 48,
    maxHeight: 88,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 10,
    backgroundColor: RPT.bg,
    color: RPT.head,
    fontFamily: Fonts.report.bodyRegular,
    fontSize: 14,
    lineHeight: 22,
  },
  commentButton: {
    alignSelf: "flex-end",
    minHeight: 34,
    marginTop: 8,
    paddingHorizontal: 15,
    borderRadius: 9,
    justifyContent: "center",
    backgroundColor: RPT.ok,
  },
  commentButtonDisabled: { backgroundColor: RPT.chipBg },
  commentButtonText: {
    color: RPT.bg,
    fontFamily: Fonts.report.bodyMedium,
    fontSize: 13,
  },
  commentButtonTextDisabled: { color: RPT.soft },
  confirmBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(3,7,5,0.82)",
  },
  confirmSheet: {
    alignItems: "center",
    padding: 22,
    paddingBottom: 30,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    backgroundColor: T.panel,
  },
  deleteBadge: {
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: 1,
    borderColor: `${T.red}55`,
    backgroundColor: `${T.red}12`,
    alignItems: "center",
    justifyContent: "center",
  },
  deleteBadgeText: { color: T.red, fontSize: 23 },
  confirmTitle: {
    marginTop: 12,
    color: T.text,
    fontFamily: Fonts.cinzel.semiBold,
    fontSize: 19,
  },
  confirmText: {
    marginTop: 10,
    color: T.muted,
    fontFamily: Fonts.rajdhani.medium,
    fontSize: 13.5,
    lineHeight: 19,
    textAlign: "center",
  },
  confirmButtons: {
    width: "100%",
    marginTop: 20,
    flexDirection: "row",
    gap: 10,
  },
  cancelButton: {
    flex: 1,
    alignItems: "center",
    borderWidth: 1,
    borderColor: T.line,
    borderRadius: 4,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  destructiveButton: {
    flex: 1,
    alignItems: "center",
    borderRadius: 4,
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: T.red,
  },
  cancelText: {
    color: T.muted,
    fontFamily: Fonts.rajdhani.bold,
    fontSize: 15.5,
  },
  destructiveText: {
    color: T.ink,
    fontFamily: Fonts.rajdhani.bold,
    fontSize: 15.5,
  },
});
