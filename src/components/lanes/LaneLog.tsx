import Bevel from "../Bevel";
import type { WorkLaneSpecChange } from "pentacle-chat-core";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { Fonts, Tokens } from "@/constants/Colors";
import type {
  LaneCardViewModel,
  LaneUpdateEntry,
} from "../../services/workLanes";
import { laneStyles as s } from "./laneStyles";
import {
  laneTime,
  body,
  Icon,
  label,
  LaneGlyph,
  LaneMark,
  LeafLoading,
  LeafText,
  mono,
  p,
  TypeChip,
} from "./LaneAtoms";
import { emitHarnessUiTrace } from "./lanesTelemetry";
import { useWorkLaneShow, type ReadWorkLaneShow } from "./useWorkLaneShow";

export type LaneLogTab = "updates" | "spec-changes" | "events";
export const LANE_LOG_PAGE_SIZE = 50;
const TABS: { id: LaneLogTab; label: string }[] = [
  { id: "updates", label: "Updates" },
  { id: "spec-changes", label: "Spec changes" },
  { id: "events", label: "Events" },
];

export default function LaneLog({
  model,
  connected,
  updates = [],
  onBack,
  onClose,
  readShow,
  bottom = 18,
  top = 0,
}: {
  model: LaneCardViewModel;
  connected: boolean;
  updates?: LaneUpdateEntry[];
  onBack(): void;
  onClose?(): void;
  top?: number;
  readShow?: ReadWorkLaneShow;
  bottom?: number;
}) {
  const [tab, setTab] = useState<LaneLogTab>("updates");
  const [page, setPage] = useState(0);
  const { data, loading, error, retry } = useWorkLaneShow(
    model.lane.lane_id,
    connected,
    true,
    readShow,
  );
  useEffect(() => {
    setPage(0);
  }, [data, tab]);
  const rows = useMemo<
    {
      key: string | number;
      at: string;
      label: string;
      text: string;
      change?: WorkLaneSpecChange;
    }[]
  >(() => {
    if (!data) return [];
    if (tab === "spec-changes")
      return data.spec_changes.map((row) => ({
        key: `${row.event_id}:${row.spec_id}:${row.field}`,
        at: row.created_at,
        label: `${row.title} · ${row.field}`,
        text: `${row.before} → ${row.after}`,
        change: row,
      }));
    if (tab === "events")
      return data.events.map((row) => ({
        key: row.event_id,
        at: row.created_at,
        label: row.operation,
        text: row.summary || `${row.operation} · ${row.created_at}`,
      }));
    const published = new Map<string, string>();
    for (const entry of updates) {
      if (
        entry.update.lane_id === model.lane.lane_id &&
        !published.has(entry.update.update_id)
      ) {
        published.set(entry.update.update_id, entry.update.summary);
      }
    }
    const showUpdates = data.updates.length
      ? data.updates
      : model.lane.last_update
        ? [
            {
              ...model.lane.last_update,
              created_at: model.lane.last_update.ts,
              summary: null,
            },
          ]
        : [];
    return showUpdates.map((row) => ({
      key: row.update_id,
      at: row.created_at || row.ts,
      label: row.kind,
      text:
        row.summary ||
        published.get(row.update_id) ||
        `${row.kind} · ${row.created_at || row.ts}`,
    }));
  }, [data, model.lane.lane_id, model.lane.last_update, tab, updates]);
  const pageCount = Math.max(1, Math.ceil(rows.length / LANE_LOG_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const shown = rows.slice(
    currentPage * LANE_LOG_PAGE_SIZE,
    (currentPage + 1) * LANE_LOG_PAGE_SIZE,
  );
  useEffect(() => {
    emitHarnessUiTrace("work_lanes_view", {
      view: "log",
      lane_id: model.lane.lane_id,
      tab,
    });
  }, [model.lane.lane_id, tab]);
  useEffect(() => {
    if (data)
      emitHarnessUiTrace("work_lanes_log_rendered", {
        lane_id: model.lane.lane_id,
        tab,
        rows_rendered: shown.length,
        rows_total: rows.length,
      });
  }, [data, model.lane.lane_id, tab, currentPage, shown.length, rows.length]);
  return (
    <View
      testID={`lane-log-${model.lane.lane_id}`}
      style={[s.root, { backgroundColor: "transparent" }]}
    >
      <View style={{ paddingTop: top, paddingHorizontal: 16 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingBottom: 10,
          }}
        >
          <Pressable
            testID="lane-log-back"
            accessibilityRole="button"
            accessibilityLabel={`Back to ${model.lane.title}`}
            onPress={onBack}
            style={{
              width: 26,
              height: 30,
              marginLeft: -4,
              justifyContent: "center",
            }}
          >
            <Icon kind="back" size={13} />
          </Pressable>
          <LaneMark model={model} size={30} />
          <View style={{ flex: 1 }}>
            <Text
              numberOfLines={1}
              style={{
                ...body,
                color: p.text,
                fontSize: 16,
                fontFamily: Fonts.rajdhani.bold,
              }}
            >
              {model.lane.title}
            </Text>
            <View
              style={{
                flexDirection: "row",
                gap: 6,
                alignItems: "center",
                marginTop: 2,
              }}
            >
              <LaneGlyph model={model} size={10} />
              <Text
                style={{ ...mono, color: p[model.stateTone], letterSpacing: 1 }}
              >
                {model.stateLabel}
              </Text>
            </View>
          </View>
          {onClose ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close lanes"
              onPress={onClose}
              style={{
                width: 34,
                height: 34,
                borderRadius: 17,
                borderWidth: 1,
                borderColor: p.line,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon kind="close" />
            </Pressable>
          ) : null}
        </View>
        <View
          style={{
            flexDirection: "row",
            gap: 6,
            borderBottomWidth: 1,
            borderColor: p.line,
          }}
        >
          {TABS.map((item) => (
            <Pressable
              key={item.id}
              testID={`lane-log-tab-${item.id}`}
              accessibilityRole="button"
              accessibilityLabel={item.label}
              accessibilityState={{ selected: tab === item.id }}
              onPress={() => {
                setTab(item.id);
                setPage(0);
              }}
              style={{
                paddingVertical: 8,
                paddingHorizontal: 6,
                borderBottomWidth: 2,
                borderColor: tab === item.id ? p.green : "transparent",
              }}
            >
              <Text
                style={{
                  ...body,
                  fontSize: 13.5,
                  fontFamily: Fonts.rajdhani.bold,
                  color: tab === item.id ? p.text : p.muted,
                }}
              >
                {item.label}
                {item.id === "updates" && data
                  ? ` · ${data.updates.length}`
                  : item.id === "spec-changes" && data
                    ? ` · ${data.spec_changes.length}`
                    : ""}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      <ScrollView
        key={`${tab}:${currentPage}`}
        contentContainerStyle={{
          paddingTop: 14,
          paddingHorizontal: 16,
          paddingBottom: bottom,
          gap: 12,
        }}
      >
        {loading ? (
          <LeafLoading id="lane-log-loading" text="Loading lane log" />
        ) : null}
        {error ? (
          <View testID="lane-log-error">
            <Text style={s.error}>{error}</Text>
            <Pressable
              testID="lane-log-retry"
              accessibilityRole="button"
              accessibilityLabel="Retry lane log"
              onPress={() => void retry()}
              style={s.button}
            >
              <Text style={s.buttonText}>Retry</Text>
            </Pressable>
          </View>
        ) : null}
        {!connected ? (
          <Text style={s.muted}>Waiting for connection…</Text>
        ) : null}
        {data && !loading && !error && rows.length === 0 ? (
          <LeafText
            id="lane-log-empty"
            text={`No ${TABS.find((item) => item.id === tab)?.label.toLowerCase()}`}
            style={s.muted}
          />
        ) : null}
        {shown.map((row, index) => (
          <View
            key={row.key}
            testID={`lane-log-row-${currentPage * LANE_LOG_PAGE_SIZE + index}`}
            accessible
            accessibilityLabel={`${row.label}, ${row.text}`}
            style={{ gap: 5 }}
          >
            {tab === "updates" ? (
              <>
                <View
                  style={{ flexDirection: "row", gap: 7, alignItems: "center" }}
                >
                  <TypeChip type={row.label} />
                  <Text
                    style={{
                      ...mono,
                      fontSize: 10,
                      color: index === 0 ? p.green : p.muted,
                      letterSpacing: 1,
                    }}
                  >
                    {laneTime(row.at)}
                  </Text>
                  {index === 0 ? (
                    <View
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: p.green,
                      }}
                    />
                  ) : null}
                </View>
                <Bevel
                  cut={10}
                  fill={index === 0 ? `${p.green}0c` : "transparent"}
                  stroke={index === 0 ? `${p.green}33` : p.line}
                  contentStyle={{ paddingVertical: 10, paddingHorizontal: 12 }}
                >
                  <Text
                    style={{
                      ...body,
                      fontSize: 14.5,
                      lineHeight: 22,
                      color: index === 0 ? p.text : p.dim,
                    }}
                  >
                    {row.text}
                  </Text>
                </Bevel>
              </>
            ) : (
              <View
                style={{
                  flexDirection: "row",
                  gap: 10,
                  paddingBottom: 11,
                  borderBottomWidth: 1,
                  borderColor: "rgba(255,255,255,0.05)",
                }}
              >
                <Text
                  style={{
                    ...mono,
                    width: tab === "events" ? 70 : 56,
                    fontSize: 10,
                  }}
                >
                  {laneTime(row.at)}
                </Text>
                <View style={{ flex: 1 }}>
                  {tab === "spec-changes" && row.change ? (
                    <>
                      <Text
                        style={{
                          ...body,
                          fontSize: 14.5,
                          fontFamily: Fonts.rajdhani.bold,
                          color: p.text,
                        }}
                      >
                        {row.change.title}
                      </Text>
                      <View
                        style={{
                          flexDirection: "row",
                          gap: 6,
                          marginTop: 3,
                          flexWrap: "wrap",
                          alignItems: "center",
                        }}
                      >
                        <Text
                          style={{
                            ...mono,
                            fontSize: 9.5,
                            letterSpacing: 0.8,
                            textTransform: "uppercase",
                          }}
                        >
                          {row.change.field}
                        </Text>
                        <Text
                          style={{
                            ...mono,
                            fontSize: 11,
                            textDecorationLine: "line-through",
                          }}
                        >
                          {row.change.before}
                        </Text>
                        <Text style={{ ...mono, fontSize: 11 }}>→</Text>
                        <Text
                          style={{
                            ...mono,
                            fontSize: 11,
                            color: p.green,
                            fontFamily: Fonts.jetBrainsMono.bold,
                          }}
                        >
                          {row.change.after}
                        </Text>
                      </View>
                    </>
                  ) : (
                    <Text style={{ ...mono, fontSize: 11.5, color: p.dim }}>
                      {row.text}
                    </Text>
                  )}
                </View>
              </View>
            )}
          </View>
        ))}
        {currentPage + 1 < pageCount ? (
          <Pressable
            testID="lane-log-older"
            accessibilityRole="button"
            accessibilityLabel="Load older lane log rows"
            onPress={() => setPage(currentPage + 1)}
            style={s.button}
          >
            <Text style={s.buttonText}>
              Older · {currentPage + 1}/{pageCount}
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}
