import React, { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { WorkLanesInventory } from "pentacle-chat-core";
import { Fonts } from "@/constants/Colors";
import HeaderVoiceMic from "../voice/HeaderVoiceMic";
import { compactHeaderLayout } from "../headerLayout";
import { useVoiceSurface } from "../../services/voicePresentation";
import ArcaneRingFrame from "../ArcaneRingFrame";
import MachineSigil from "../MachineSigil";
import Starfield from "../Starfield";
import type {
  LaneCardViewModel,
  LaneUpdateEntry,
} from "../../services/workLanes";
import type { ListVariant } from "./LaneCard";
import LaneLog from "./LaneLog";
import LanesMap from "./LanesMap";
import {
  body,
  Icon,
  label,
  LaneGlyph,
  LaneMark,
  LeafText,
  mono,
  p,
  laneTime,
} from "./LaneAtoms";
import { emitHarnessUiTrace } from "./lanesTelemetry";
import type { ReadWorkLaneShow } from "./useWorkLaneShow";
import type { SheetSnap } from "./LanesSheet";
export { LatestUpdate } from "./LatestUpdate";

export function AssistantMark({ size = 38 }: { size?: number }) {
  return (
    <ArcaneRingFrame size={size} color={p.green}>
      <MachineSigil kind="djinni" size={size * 0.64} color={p.green} />
    </ArcaneRingFrame>
  );
}
function HeaderRing({ lanes }: { lanes: LaneCardViewModel[] }) {
  return (
    <View
      testID="lanes-header-mini-ring"
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
    >
      {lanes.map((model, i) => {
        const angle =
          -Math.PI / 2 + (2 * Math.PI * i) / Math.max(lanes.length, 1);
        return (
          <View
            key={model.lane.lane_id}
            style={{
              position: "absolute",
              width: 4,
              height: 4,
              borderRadius: 2,
              left: 17 + 22 * Math.cos(angle),
              top: 17 + 22 * Math.sin(angle),
              backgroundColor: p[model.stateTone],
            }}
          />
        );
      })}
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
  active = true,
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
  active?: boolean;
}) {
  const [focus, setFocus] = useState<string | null>(null),
    [snap, setSnap] = useState<SheetSnap>("peek");
  const [logId, setLogId] = useState<string | null>(null),
    [allUpdates, setAllUpdates] = useState(false),
    [unavailableLog, setUnavailableLog] = useState<string | null>(null);
  const mapBack = useRef<() => void>(() => setFocus(null));
  const focused = lanes.find((m) => m.lane.lane_id === focus),
    log = lanes.find((m) => m.lane.lane_id === logId);
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
  const closeGlobalLog = () => {
    setAllUpdates(false);
    setUnavailableLog(null);
  };
  const openLog = (model: LaneCardViewModel) => setLogId(model.lane.lane_id);
  const hidden = !!log || allUpdates;
  useVoiceSurface(
    {
      page_id: hidden ? "updates" : focused ? "lane" : "lanes",
      title:
        log?.lane.title ||
        (allUpdates ? "Update log" : focused?.lane.title || "Work lanes"),
      ...(log || focused ? { entity_id: (log || focused)!.lane.lane_id } : {}),
    },
    active,
    { priority: 1, bottom: bottom + 10, top: top + 72 },
  );
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
            {focused || allUpdates ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Back"
                onPress={allUpdates ? closeGlobalLog : () => mapBack.current()}
                style={styles.round}
              >
                <Icon kind="back" />
              </Pressable>
            ) : null}
            <View style={compactHeaderLayout.identity}>
              {focused ? (
                <LaneMark model={focused} size={38} />
              ) : (
                <View>
                  <AssistantMark />
                  {snap === "full" ? <HeaderRing lanes={lanes} /> : null}
                </View>
              )}
              <View style={compactHeaderLayout.copy}>
                <Text
                  numberOfLines={1}
                  style={{
                    ...body,
                    color: p.text,
                    fontFamily: Fonts.rajdhani.bold,
                    fontSize: 17,
                    lineHeight: 19,
                    flexShrink: 1,
                  }}
                >
                  {focused?.lane.title || assistantName}
                </Text>
                <View
                  style={{
                    flexDirection: "row",
                    gap: 7,
                    alignItems: "center",
                    marginTop: 3,
                  }}
                >
                  {focused ? (
                    <>
                      <LaneGlyph model={focused} size={10} />
                      <Text
                        numberOfLines={1}
                        style={{
                          ...mono,
                          color: p[focused.stateTone],
                          letterSpacing: 1,
                          flexShrink: 1,
                        }}
                      >
                        {focused.stateLabel} ·{" "}
                        {focused.leadHost ||
                          focused.lane.visible_chat.stream_id.split(":")[0]}
                      </Text>
                    </>
                  ) : (
                    <Text
                      numberOfLines={1}
                      style={{ ...mono, letterSpacing: 0.5 }}
                    >
                      {inventory?.counts.open ?? lanes.length} LANES
                      {inventory?.counts.blocked
                        ? ` · ${inventory.counts.blocked} BLOCKED`
                        : ""}
                    </Text>
                  )}
                </View>
              </View>
              <HeaderVoiceMic />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close lanes"
              onPress={allUpdates ? closeGlobalLog : onClose}
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
          <LanesMap
            active={active && !hidden}
            bottom={bottom}
            voiceBottom={bottom + 10}
            voiceTop={top + 72}
            onBackHandler={(handler) => {
              mapBack.current = handler;
            }}
            lanes={lanes}
            assistantName={assistantName}
            focusedLaneId={focus}
            onFocusLane={setFocus}
            onSnapChange={setSnap}
            onOpenMember={(m, member) =>
              emitHarnessUiTrace("work_lanes_view", {
                view: "member_detail",
                lane_id: m.lane.lane_id,
                spec_id: member.spec_id,
              })
            }
            onLog={openLog}
            onChat={onChat}
            updates={updates}
            onAllUpdates={() => setAllUpdates(true)}
            connected={connected}
            readShow={readShow}
          />
        </View>
        {allUpdates ? (
          <ScrollView
            testID="lanes-update-log"
            contentContainerStyle={{ padding: 16, gap: 14 }}
          >
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
            >
              <Text style={label}>Update log</Text>
              <HeaderVoiceMic />
            </View>
            {unavailableLog ? (
              <LeafText
                id="lanes-update-log-unavailable"
                text={`Lane log unavailable: ${unavailableLog} is not in the current open lanes`}
                style={{ ...body, color: p.amber }}
              />
            ) : null}
            {updates.map((entry, i) => (
              <Pressable
                key={entry.update.update_id}
                testID={`lanes-update-log-row-${entry.update.update_id}`}
                accessibilityRole="button"
                accessibilityLabel={`Open lane log: ${entry.update.summary}`}
                onPress={() => {
                  const model = lanes.find(
                    (m) => m.lane.lane_id === entry.update.lane_id,
                  );
                  setUnavailableLog(model ? null : entry.update.lane_id);
                  if (model) openLog(model);
                }}
                style={{ gap: 5 }}
              >
                <Text style={{ ...mono, color: i === 0 ? p.green : p.muted }}>
                  {laneTime(entry.update.ts)}
                </Text>
                <Text
                  style={{
                    ...body,
                    color: i === 0 ? p.text : p.dim,
                    borderWidth: 1,
                    borderColor: i === 0 ? `${p.green}33` : p.line,
                    padding: 12,
                    lineHeight: 22,
                  }}
                >
                  {entry.update.summary}
                </Text>
              </Pressable>
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
