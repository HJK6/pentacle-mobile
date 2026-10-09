import React, { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { WorkLanesInventory } from "pentacle-chat-core";
import { Fonts } from "@/constants/Colors";
import ArcaneRingFrame from "../ArcaneRingFrame";
import MachineSigil from "../MachineSigil";
import StatusTag from "../StatusTag";
import Starfield from "../Starfield";
import Bevel from "../Bevel";
import type {
  LaneCardViewModel,
  LaneUpdateEntry,
} from "../../services/workLanes";
import LaneCard, { type ListVariant } from "./LaneCard";
import LaneLog from "./LaneLog";
import LanesMap from "./LanesMap";
import {
  laneTime,
  body,
  Icon,
  label,
  LaneGlyph,
  LaneMark,
  LeafText,
  mono,
  p,
} from "./LaneAtoms";
import { emitHarnessUiTrace } from "./lanesTelemetry";
import type { ReadWorkLaneShow } from "./useWorkLaneShow";
export function AssistantMark({ size = 38 }: { size?: number }) {
  return (
    <ArcaneRingFrame size={size} color={p.green}>
      <MachineSigil kind="djinni" size={size * 0.64} color={p.green} />
    </ArcaneRingFrame>
  );
}
export function LatestUpdate({
  updates,
  onPress,
  map = false,
}: {
  updates: LaneUpdateEntry[];
  onPress(): void;
  map?: boolean;
}) {
  const latest = updates[0];
  return (
    <View style={{ gap: 8 }}>
      {!map ? (
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Text style={[label, { flex: 1 }]}>Latest update</Text>
          <Pressable
            testID="lanes-all-updates"
            accessibilityRole="button"
            accessibilityLabel="All updates"
            onPress={onPress}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 3,
              padding: 2,
            }}
          >
            <Text
              style={{
                ...body,
                fontSize: 13.5,
                fontFamily: Fonts.rajdhani.bold,
              }}
            >
              All updates · {updates.length}
            </Text>
            <Icon kind="chevron" size={13} />
          </Pressable>
        </View>
      ) : null}
      <Pressable
        testID="lanes-latest-update"
        accessibilityRole="button"
        accessibilityLabel="Open update log"
        onPress={onPress}
      >
        <Bevel
          cut={10}
          fill={`${p.green}0c`}
          stroke={`${p.green}33`}
          contentStyle={{ paddingHorizontal: 13, paddingVertical: 11, gap: 4 }}
        >
          <View style={{ flexDirection: "row", gap: 7, alignItems: "center" }}>
            <Text
              style={{
                ...mono,
                fontSize: 10,
                letterSpacing: 1,
                color: p.green,
                fontFamily: Fonts.jetBrainsMono.bold,
              }}
            >
              {map ? "LATEST · " : ""}
              {laneTime(latest?.update.ts)}
            </Text>
            <View
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: p.green,
              }}
            />
          </View>
          <Text
            style={{ ...body, color: p.text, fontSize: 14.5, lineHeight: 22 }}
          >
            {latest?.update.summary || "No updates yet"}
          </Text>
        </Bevel>
      </Pressable>
    </View>
  );
}
export default function LanesOverlay({
  lanes,
  inventory,
  assistantName,
  connected,
  updates,
  top,
  bottom,
  onChat,
  onClose,
  readShow,
  listVariant = "compact",
}: {
  lanes: LaneCardViewModel[];
  inventory: WorkLanesInventory | null | undefined;
  assistantName: string;
  connected: boolean;
  updates: LaneUpdateEntry[];
  top: number;
  bottom: number;
  onChat(model: LaneCardViewModel): void;
  onClose(): void;
  readShow?: ReadWorkLaneShow;
  listVariant?: ListVariant;
}) {
  const [view, setView] = useState<"list" | "map">("list"),
    [focus, setFocus] = useState<string | null>(null),
    [logId, setLogId] = useState<string | null>(null),
    [allUpdates, setAllUpdates] = useState(false);
  const mapBack = useRef<() => void>(() => setFocus(null));
  const focused =
    view === "map" ? lanes.find((m) => m.lane.lane_id === focus) : undefined;
  const log = lanes.find((m) => m.lane.lane_id === logId);
  useEffect(() => {
    if (logId && !log) setLogId(null);
  }, [logId, log]);
  useEffect(() => {
    if (inventory)
      emitHarnessUiTrace("work_lanes_inventory_applied", {
        wire:
          inventory.lanes.some((l) => l.members !== undefined) ||
          inventory.work_index !== undefined
            ? "inc1"
            : "v1",
        lane_ids: inventory.lanes.map((l) => l.lane_id),
        counts: inventory.counts,
        lanes_with_members: inventory.lanes.filter(
          (l) => l.members !== undefined,
        ).length,
      });
  }, [inventory]);
  useEffect(() => {
    if (!logId) emitHarnessUiTrace("work_lanes_view", { view });
  }, [view, logId]);
  const openLog = (model: LaneCardViewModel) => setLogId(model.lane.lane_id);
  const hidden = !!log || allUpdates;
  return (
    <View testID="lanes-overlay" style={{ flex: 1, backgroundColor: p.ink }}>
      <Starfield />
      <View
        style={[{ flex: 1 }, log && styles.hidden]}
        accessibilityElementsHidden={!!log}
        importantForAccessibility={log ? "no-hide-descendants" : "auto"}
      >
        <View
          style={{
            paddingTop: top,
            paddingHorizontal: 12,
            paddingBottom: 12,
            borderBottomWidth: 1,
            borderColor: `${p.green}33`,
            gap: 8,
          }}
        >
          <View style={{ flexDirection: "row", gap: 9, alignItems: "center" }}>
            {focused ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Back"
                onPress={() => mapBack.current()}
                style={styles.round}
              >
                <Icon kind="back" />
              </Pressable>
            ) : null}
            {allUpdates ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Back"
                onPress={() => setAllUpdates(false)}
                style={styles.round}
              >
                <Icon kind="back" />
              </Pressable>
            ) : null}
            {focused ? (
              <LaneMark model={focused} size={38} />
            ) : (
              <AssistantMark />
            )}
            <View style={{ flex: 1 }}>
              <Text
                numberOfLines={1}
                style={{
                  ...body,
                  color: p.text,
                  fontFamily: Fonts.rajdhani.bold,
                  fontSize: 17,
                  lineHeight: 19,
                }}
              >
                {focused?.lane.title || assistantName}
              </Text>
              <View
                style={{
                  flexDirection: "row",
                  gap: 9,
                  alignItems: "center",
                  marginTop: 3,
                }}
              >
                {focused ? (
                  <>
                    <LaneGlyph model={focused} size={10} />
                    <Text
                      style={{
                        ...mono,
                        color: p[focused.stateTone],
                        letterSpacing: 1,
                      }}
                    >
                      {focused.stateLabel}
                    </Text>
                  </>
                ) : (
                  <>
                    <StatusTag status={connected ? "working" : "idle"} />
                    <Text style={{ ...mono, letterSpacing: 0.5 }}>
                      {inventory?.counts.open ?? lanes.length} LANES
                    </Text>
                  </>
                )}
              </View>
            </View>
            {!allUpdates ? (
              <View
                testID="lanes-view-toggle"
                accessibilityValue={{ text: view }}
                style={{
                  flexDirection: "row",
                  gap: 2,
                  borderWidth: 1,
                  borderColor: p.line,
                  padding: 2,
                  borderRadius: 4,
                }}
              >
                {(["list", "map"] as const).map((value) => (
                  <Pressable
                    key={value}
                    testID={`lanes-view-${value}`}
                    accessibilityRole="button"
                    accessibilityLabel={`${value === "list" ? "List" : "Map"} view`}
                    accessibilityState={{ selected: view === value }}
                    onPress={() => setView(value)}
                    style={{
                      width: 34,
                      height: 30,
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: 3,
                      backgroundColor:
                        view === value ? `${p.green}22` : "transparent",
                    }}
                  >
                    <Icon
                      kind={value}
                      color={view === value ? p.green : p.muted}
                    />
                  </Pressable>
                ))}
              </View>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close lanes"
              onPress={onClose}
              style={styles.round}
            >
              <Icon kind="close" />
            </Pressable>
          </View>
          {inventory?.work_index?.available === false ? (
            <LeafText
              id="lanes-index-banner"
              text={`DATA AS OF ${inventory.work_index.snapshot_at || "unknown"}`}
              style={{ ...mono, color: p.amber, letterSpacing: 1 }}
            />
          ) : null}
        </View>
        <View
          style={[{ flex: 1 }, hidden && styles.hidden]}
          accessibilityElementsHidden={hidden}
          importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}
        >
          <View
            style={[{ flex: 1 }, view !== "list" && styles.hidden]}
            accessibilityElementsHidden={view !== "list"}
            importantForAccessibility={
              view !== "list" ? "no-hide-descendants" : "auto"
            }
          >
            <ScrollView
              contentContainerStyle={{
                paddingTop: 16,
                paddingHorizontal: 14,
                paddingBottom: Math.max(28, bottom),
                gap: 20,
              }}
            >
              <LatestUpdate
                updates={updates}
                onPress={() => setAllUpdates(true)}
              />
              <View style={{ gap: 10 }}>
                <Text style={label}>
                  OPEN LANES ·{" "}
                  {inventory?.truncated
                    ? `${lanes.length} OF ${inventory.counts.open}`
                    : (inventory?.counts.open ?? lanes.length)}
                </Text>
                {!lanes.length ? <Text style={body}>No open lanes</Text> : null}
                {lanes.map((model) => (
                  <LaneCard
                    key={model.lane.lane_id}
                    model={model}
                    connected={connected}
                    readShow={readShow}
                    variant={listVariant}
                    onOpenMember={(m, member) =>
                      emitHarnessUiTrace("work_lanes_view", {
                        view: "member_detail",
                        lane_id: m.lane.lane_id,
                        spec_id: member.spec_id,
                      })
                    }
                    onShowAll={(m) =>
                      emitHarnessUiTrace("work_lanes_view", {
                        view: "members",
                        lane_id: m.lane.lane_id,
                      })
                    }
                    onLog={openLog}
                    onChat={onChat}
                  />
                ))}
              </View>
            </ScrollView>
          </View>
          {view === "map" ? (
            <LanesMap
              onBackHandler={(handler) => {
                mapBack.current = handler;
              }}
              lanes={lanes}
              assistantName={assistantName}
              focusedLaneId={focus}
              onFocusLane={setFocus}
              page={0}
              onPageChange={() => {}}
              onOpenMember={(m, member) =>
                emitHarnessUiTrace("work_lanes_view", {
                  view: "member_detail",
                  lane_id: m.lane.lane_id,
                  spec_id: member.spec_id,
                })
              }
              onShowAll={() => setView("list")}
              onLog={openLog}
              onChat={onChat}
              updates={updates}
              onAllUpdates={() => setAllUpdates(true)}
              connected={connected}
              readShow={readShow}
            />
          ) : null}
        </View>
        {allUpdates ? (
          <ScrollView
            testID="lanes-update-log"
            contentContainerStyle={{ padding: 16, gap: 14 }}
          >
            <Text style={label}>Update log</Text>
            {updates.map((entry, i) => (
              <View key={entry.update.update_id} style={{ gap: 5 }}>
                <Text style={{ ...mono, color: i === 0 ? p.green : p.muted }}>
                  {laneTime(entry.update.ts)}
                </Text>
                <Text
                  style={{
                    ...body,
                    color: i === 0 ? p.text : p.dim,
                    borderWidth: 1,
                    borderColor: i === 0 ? `${p.green}33` : p.line,
                    backgroundColor: i === 0 ? `${p.green}0c` : "transparent",
                    padding: 12,
                    lineHeight: 22,
                  }}
                >
                  {entry.update.summary}
                </Text>
              </View>
            ))}
          </ScrollView>
        ) : null}
      </View>
      {log ? (
        <LaneLog
          model={log}
          connected={connected}
          updates={updates}
          onBack={() => setLogId(null)}
          onClose={onClose}
          readShow={readShow}
          bottom={bottom}
          top={top}
        />
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  round: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: p.line,
    alignItems: "center",
    justifyContent: "center",
  },
  hidden: { display: "none" },
});
