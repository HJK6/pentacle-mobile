import { useLaneMembers } from "./useLaneMembers";
import React, { useEffect, useState, useRef } from "react";
import {
  Animated,
  Easing,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
  Platform,
} from "react-native";
import Svg, { Circle, Ellipse, Line } from "react-native-svg";
import type { WorkLaneMember } from "pentacle-chat-core";
import { Fonts, type MachineSigilKind } from "@/constants/Colors";
import Bevel from "../Bevel";
import ArcaneRingFrame from "../ArcaneRingFrame";
import MachineSigil from "../MachineSigil";
import { Spinner } from "../ArcaneAtoms";
import type {
  LaneCardViewModel,
  LaneUpdateEntry,
} from "../../services/workLanes";
import LaneMemberDetail, { memberTitle } from "./LaneMemberDetail";
import { StepRow } from "./LaneCard";
import {
  laneTime,
  Bang,
  Pause,
  body,
  blockerText,
  Icon,
  label,
  LaneGlyph,
  LaneMark,
  LeafLoading,
  LeafText,
  memberTone,
  mono,
  p,
  ProgressRing,
  progressValue,
  Segments,
  SpecGlyph,
  UpdateRow,
} from "./LaneAtoms";
import { emitHarnessUiTrace, traceMemberList } from "./lanesTelemetry";
import { useWorkLaneShow, type ReadWorkLaneShow } from "./useWorkLaneShow";

function useLoop(duration: number, native: boolean, enabled = true) {
  const phase = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!enabled) {
      phase.setValue(0);
      return;
    }
    const animation = Animated.loop(
      Animated.timing(phase, {
        toValue: 1,
        duration,
        easing: Easing.linear,
        useNativeDriver: native,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [duration, native, enabled, phase]);
  return phase;
}
const AnimatedLine = Animated.createAnimatedComponent(Line);
function FlowSpoke({
  working,
  id,
  ...props
}: React.ComponentProps<typeof Line> & { working: boolean; id: string }) {
  const phase = useLoop(1800, false, working);
  return working ? (
    <AnimatedLine
      {...props}
      testID={id}
      strokeDashoffset={phase.interpolate({
        inputRange: [0, 1],
        outputRange: [0, -36],
      })}
    />
  ) : (
    <Line {...props} />
  );
}
function WorkingOrbit({ id, size }: { id: string; size: number }) {
  const phase = useLoop(9000, true);
  return (
    <Animated.View
      testID={id}
      pointerEvents="none"
      style={{
        position: "absolute",
        left: -7,
        top: -7,
        right: -7,
        bottom: -7,
        borderRadius: size,
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: `${p.green}66`,
        transform: [
          {
            rotate: phase.interpolate({
              inputRange: [0, 1],
              outputRange: ["0deg", "360deg"],
            }),
          },
        ],
      }}
    />
  );
}

type Props = {
  lanes: LaneCardViewModel[];
  assistantName: string;
  assistantSigil?: MachineSigilKind;
  focusedLaneId: string | null;
  onFocusLane(id: string | null): void;
  page: number;
  onPageChange(page: number): void;
  onOpenMember(model: LaneCardViewModel, member: WorkLaneMember): void;
  onShowAll(model: LaneCardViewModel): void;
  onLog(model: LaneCardViewModel): void;
  onChat(model: LaneCardViewModel): void;
  updates?: LaneUpdateEntry[];
  onAllUpdates?(): void;
  connected?: boolean;
  readShow?: ReadWorkLaneShow;
  onBackHandler?(handler: () => void): void;
};
export const laneAttentionRank = (model: LaneCardViewModel) =>
  model.lane.state === "blocked"
    ? 0
    : model.lane.state === "active" && model.lane.lead?.presence.working
      ? 1
      : model.lane.state === "active"
        ? 2
        : 3;
export function groupMapMembers(members: WorkLaneMember[]) {
  if (members.length <= 6)
    return {
      live: members,
      pending: [] as WorkLaneMember[],
      done: [] as WorkLaneMember[],
    };
  const pending = members.filter((m) =>
    ["ready_for_dev", "analysis", "backlog"].includes(m.status || ""),
  );
  const done = members.filter((m) =>
    ["completed", "deprecated"].includes(m.status || ""),
  );
  return {
    live: members.filter((m) => !pending.includes(m) && !done.includes(m)),
    pending,
    done,
  };
}
type Point = {
  x: number;
  y: number;
  size: number;
  small?: boolean;
  labels?: boolean;
};
function LaneNode({
  model,
  point,
  selected,
  width,
  onPress,
}: {
  model: LaneCardViewModel;
  point: Point;
  selected: boolean;
  width: number;
  onPress(): void;
}) {
  const { x, y, size, small, labels = true } = point,
    color = p[model.stateTone];
  const lw = small ? 100 : 112,
    labelLeft =
      Math.max(4, Math.min(width - lw - 4, x - lw / 2)) - (x - size / 2);
  const fraction = model.lane.ac_total
    ? (model.lane.ac_checked || 0) / model.lane.ac_total
    : model.total
      ? model.completed / model.total
      : 0;
  const working =
    model.lane.state === "active" && model.lane.lead?.presence.working;
  return (
    <Pressable
      testID={`lanes-map-lane-${model.lane.lane_id}`}
      accessibilityRole="button"
      accessibilityLabel={`${model.lane.title}, ${model.stateLabel}, ${model.membersPending ? "—/—" : `${model.completed}/${model.total}`}`}
      accessibilityHint={model.waitingOnYouLabel || undefined}
      accessibilityState={{ selected }}
      hitSlop={Math.max(0, (44 - size) / 2)}
      onPress={onPress}
      style={{
        position: "absolute",
        left: x - size / 2,
        top: y - size / 2,
        width: size,
        height: size,
        zIndex: 3,
        opacity: labels || selected ? 1 : 0.55,
      }}
    >
      {working ? (
        <WorkingOrbit
          id={`lanes-map-working-${model.lane.lane_id}`}
          size={size}
        />
      ) : null}
      {selected ? (
        <View
          style={{
            position: "absolute",
            left: -12,
            top: -12,
            right: -12,
            bottom: -12,
            borderRadius: size,
            backgroundColor: `${color}12`,
          }}
        />
      ) : null}
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: p.ink,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {!model.membersPending ? (
          <ProgressRing size={size} fraction={fraction} color={color} />
        ) : null}
        {size >= 30 ? (
          <View style={{ opacity: model.lane.state === "paused" ? 0.55 : 1 }}>
            <LaneMark model={model} size={size * 0.62} />
          </View>
        ) : (
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: color,
            }}
          />
        )}
      </View>
      {size >= 30 && (model.lane.state !== "active" || model.waitingOnYou) ? (
        <View
          testID={
            model.waitingOnYou
              ? `lanes-map-waiting-${model.lane.lane_id}`
              : undefined
          }
          style={{
            position: "absolute",
            right: -2,
            top: -2,
            width: 19,
            height: 19,
            borderRadius: 10,
            backgroundColor: p.ink,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <LaneGlyph model={model} size={13} />
        </View>
      ) : null}
      {labels ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: size + (small ? 5 : 8),
            left: labelLeft,
            width: lw,
          }}
        >
          <Text
            numberOfLines={2}
            textBreakStrategy="balanced"
            lineBreakStrategyIOS="standard"
            style={{
              ...body,
              ...(Platform.OS === "web" ? { textWrap: "balance" } : {}),
              fontFamily: Fonts.rajdhani.bold,
              fontSize: small ? 11 : 13,
              lineHeight: small ? 12.5 : 14.5,
              textAlign: "center",
              color: small ? p.dim : p.text,
            }}
          >
            {model.lane.title}
          </Text>
          <Text
            numberOfLines={1}
            style={{
              ...mono,
              fontSize: small ? 8.5 : 9.5,
              marginTop: small ? 2 : 3,
              color,
              textAlign: "center",
              letterSpacing: 0.5,
            }}
          >
            {model.lane.state === "active"
              ? progressValue(model)
              : model.lane.state.toUpperCase()}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}
function SpecNode({
  member,
  model,
  point,
  selected,
  dense,
  onPress,
}: {
  member: WorkLaneMember;
  model: LaneCardViewModel;
  point: Point;
  selected: boolean;
  dense: boolean;
  onPress(): void;
}) {
  const size = dense ? 32 : 42,
    color = memberTone(member, model),
    quality = member.observation?.quality;
  return (
    <Pressable
      testID={`lanes-map-member-${member.spec_id}`}
      accessibilityRole="button"
      accessibilityLabel={`${memberTitle(member)}, ${(member.status || "unknown").replace(/_/g, " ")}`}
      accessibilityState={{ selected }}
      hitSlop={Math.max(0, (44 - size) / 2)}
      onPress={onPress}
      style={{
        position: "absolute",
        left: point.x - size / 2,
        top: point.y - size / 2,
        width: size,
        height: size,
        zIndex: 4,
        transform: [{ scale: selected ? 1.18 : 1 }],
      }}
    >
      {selected ? (
        <View
          style={{
            position: "absolute",
            left: -6,
            top: -6,
            right: -6,
            bottom: -6,
            borderRadius: size,
            borderWidth: 1.5,
            borderColor: color,
            opacity: 0.7,
          }}
        />
      ) : null}
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: p.panel,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: quality && quality !== "fresh" ? 1.5 : 0,
          borderStyle: "dashed",
          borderColor: quality === "stale" ? p.amber : p.red,
        }}
      >
        {member.ac_total != null ? (
          <ProgressRing
            size={size}
            color={color}
            fraction={
              member.ac_total ? (member.ac_checked || 0) / member.ac_total : 0
            }
          />
        ) : null}
        <SpecGlyph member={member} model={model} size={dense ? 12 : 15} />
      </View>
      {!dense || selected ? (
        <Text
          textBreakStrategy="balanced"
          lineBreakStrategyIOS="standard"
          style={{
            ...body,
            ...(Platform.OS === "web" ? { textWrap: "balance" } : {}),
            position: "absolute",
            top: size + 5,
            left: size / 2 - 45,
            width: 90,
            textAlign: "center",
            fontSize: 11.5,
            lineHeight: 13,
            fontFamily: Fonts.rajdhani.bold,
            color: member.terminal ? p.muted : p.text,
          }}
        >
          {memberTitle(member)}
        </Text>
      ) : null}
    </Pressable>
  );
}
function StackNode({
  kind,
  count,
  point,
  laneId,
  onPress,
}: {
  kind: "pending" | "done";
  count: number;
  point: Point;
  laneId: string;
  onPress(): void;
}) {
  const color = kind === "done" ? p.green : p.dim,
    size = point.size;
  return (
    <Pressable
      testID={
        kind === "pending"
          ? `lanes-map-more-${laneId}`
          : `lanes-map-done-stack-${laneId}`
      }
      accessibilityRole="button"
      accessibilityLabel={`${kind === "done" ? "Done" : "Pending"}, ${count} specs`}
      hitSlop={Math.max(0, (44 - size) / 2)}
      onPress={onPress}
      style={{
        position: "absolute",
        left: point.x - size / 2,
        top: point.y - size / 2,
        width: size,
        height: size,
        zIndex: 4,
      }}
    >
      {[2, 1, 0].map((k) => (
        <View
          key={k}
          style={{
            position: "absolute",
            width: size,
            height: size,
            left: k * 3,
            top: -k * 3,
            borderRadius: size / 2,
            borderWidth: k ? 1 : 2,
            borderStyle: kind === "done" ? "solid" : "dashed",
            borderColor: color,
            opacity: k ? 0.3 : 1,
            backgroundColor: p.panel,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {k === 0 ? (
            <Text
              style={{
                ...mono,
                fontSize: 14,
                fontFamily: Fonts.jetBrainsMono.bold,
                color,
              }}
            >
              {count}
            </Text>
          ) : null}
        </View>
      ))}
      <Text
        style={{
          ...body,
          position: "absolute",
          top: size + 5,
          left: size / 2 - 45,
          width: 90,
          textAlign: "center",
          fontSize: 11.5,
          fontFamily: Fonts.rajdhani.bold,
          color: p.muted,
        }}
      >
        {kind === "done" ? "Done" : "Pending"}
      </Text>
    </Pressable>
  );
}
export default function LanesMap({
  lanes,
  assistantName,
  assistantSigil = "djinni",
  focusedLaneId,
  onFocusLane,
  onOpenMember,
  onShowAll,
  onLog,
  onChat,
  updates = [],
  onAllUpdates = () => {},
  connected = true,
  readShow,
  onBackHandler,
}: Props) {
  const dimensions = useWindowDimensions(),
    [measured, setMeasured] = useState<{
      width: number;
      height: number;
    } | null>(null);
  const width = measured?.width || dimensions.width,
    height = measured?.height || Math.max(600, dimensions.height - 104),
    scale = width / 402;
  const [selected, setSelected] = useState<string | null>(null),
    [stack, setStack] = useState<"pending" | "done" | null>(null);
  const open = lanes.filter((m) => m.lane.state !== "done"),
    ordered =
      open.length > 6
        ? [...open].sort((a, b) => laneAttentionRank(a) - laneAttentionRank(b))
        : open;
  const visible = ordered.slice(0, 16),
    focused = open.find((m) => m.lane.lane_id === focusedLaneId);
  const needsShow = !!focused && focused.membersTotal > focused.members.length;
  const show = useWorkLaneShow(
    focused?.lane.lane_id || "",
    connected,
    needsShow,
    readShow,
  );
  const loadedMembers = useLaneMembers(focused?.members || [], show.data);
  const members =
    focused?.lane.no_spec_reason || focused?.membersPending
      ? []
      : loadedMembers;
  const group = groupMapMembers(members),
    stackList = stack ? group[stack] : null;
  const nodes: (
    { member: WorkLaneMember } | { kind: "pending" | "done"; count: number }
  )[] = stackList
    ? stackList.map((member) => ({ member }))
    : [
        ...group.live.map((member) => ({ member })),
        ...(group.pending.length
          ? [{ kind: "pending" as const, count: group.pending.length }]
          : []),
        ...(group.done.length
          ? [{ kind: "done" as const, count: group.done.length }]
          : []),
      ];
  const dense = nodes.length > 8,
    selMember = members.find((m) => m.spec_id === selected);
  const outer = visible.length > 6,
    cx = 201,
    cy = outer ? 330 : 238,
    rx = outer ? 100 : 132,
    ry = outer ? 140 : 132,
    fx = 201,
    fy = 212,
    sr = 122;
  const positions = new Map<string, Point>();
  const inner = visible.slice(0, 6),
    outside = visible.slice(6);
  inner.forEach((m, i) => {
    const a = ((-90 + (i * 360) / inner.length) * Math.PI) / 180;
    positions.set(m.lane.lane_id, {
      x: cx + rx * Math.cos(a),
      y: cy + ry * Math.sin(a),
      size: (outer ? 46 : 50) + Math.min(m.membersTotal, 6) * (outer ? 2 : 3),
    });
  });
  outside.forEach((m, i) => {
    const a = ((-90 + (i * 360) / outside.length) * Math.PI) / 180;
    positions.set(m.lane.lane_id, {
      x: cx + 182 * Math.cos(a),
      y: cy + 240 * Math.sin(a),
      size: 34,
      small: true,
    });
  });
  const others = visible.filter((m) => m !== focused),
    gap = Math.min(34, 290 / Math.max(1, others.length - 1));
  const lanePoint = (m: LaneCardViewModel): Point =>
    !focused
      ? positions.get(m.lane.lane_id)!
      : m === focused
        ? { x: fx, y: fy, size: 74, labels: false }
        : {
            x: 231 - ((others.length - 1) * gap) / 2 + others.indexOf(m) * gap,
            y: 26,
            size: gap < 30 ? 20 : 22,
            labels: false,
          };
  const nodePoints = nodes.map((_, i) => {
    const a = ((-90 + (i * 360) / nodes.length) * Math.PI) / 180;
    return {
      x: fx + sr * Math.cos(a),
      y: fy + sr * Math.sin(a),
      size: dense ? 32 : 42,
    };
  });
  const actualLanes =
    focused && !visible.includes(focused) ? [...visible, focused] : visible;
  const moreCount = stack ? 0 : group.pending.length + group.done.length;
  useEffect(() => {
    setSelected(null);
    setStack(null);
  }, [focusedLaneId]);
  useEffect(() => {
    if (focusedLaneId && !focused) onFocusLane(null);
  }, [focusedLaneId, focused, onFocusLane]);
  useEffect(() => {
    if (selected && !selMember) setSelected(null);
  }, [selected, selMember]);
  useEffect(() => {
    emitHarnessUiTrace("work_lanes_map_render", {
      page: 1,
      page_count: 1,
      lane_nodes: actualLanes.length,
      focused_lane_id: focused?.lane.lane_id || null,
      member_nodes: focused ? nodes.length : 0,
      more_count: focused ? moreCount : 0,
    });
  }, [
    actualLanes.map((m) => m.lane.lane_id).join("|"),
    focused?.lane.lane_id,
    nodes.length,
    moreCount,
  ]);
  useEffect(() => {
    if (focused && !selMember && (stackList || dense))
      traceMemberList(focused.lane.lane_id, stackList || group.live);
  }, [
    focused?.lane.lane_id,
    selMember?.spec_id,
    stack,
    dense,
    members.map((m) => m.spec_id).join("|"),
  ]);
  const select = (member: WorkLaneMember) => {
    setSelected((v) => (v === member.spec_id ? null : member.spec_id));
    if (focused) onOpenMember(focused, member);
  };
  const back = () => {
    if (selected) setSelected(null);
    else if (stack) setStack(null);
    else onFocusLane(null);
  };
  useEffect(() => {
    onBackHandler?.(back);
  }, [selected, stack, focusedLaneId, onBackHandler]);
  const color = focused ? p[focused.stateTone] : p.green;
  return (
    <View
      testID="lanes-map"
      style={{ flex: 1 }}
      onLayout={(e) =>
        setMeasured({
          width: e.nativeEvent.layout.width,
          height: e.nativeEvent.layout.height,
        })
      }
    >
      <ScrollView
        contentContainerStyle={{
          minHeight: Math.max(
            height,
            outer && !focused ? 770 * scale : 650 * scale,
          ),
        }}
      >
        <View
          testID="lanes-map-orbit"
          style={{
            width: 402,
            height: focused ? 410 : outer ? 650 : 490,
            transform: [{ scale }],
            transformOrigin: "top left",
          }}
        >
          <Svg
            pointerEvents="none"
            width={402}
            height={650}
            style={{ position: "absolute" }}
          >
            {!focused ? (
              <>
                <Ellipse
                  cx={cx}
                  cy={cy}
                  rx={rx}
                  ry={ry}
                  stroke={p.green}
                  opacity={0.12}
                  strokeDasharray="2 5"
                  fill="none"
                />
                {outer ? (
                  <Ellipse
                    cx={cx}
                    cy={cy}
                    rx={182}
                    ry={240}
                    stroke={p.muted}
                    opacity={0.14}
                    strokeDasharray="1 6"
                    fill="none"
                  />
                ) : null}
                {visible.map((m) => {
                  const pt = positions.get(m.lane.lane_id)!;
                  return (
                    <FlowSpoke
                      key={m.lane.lane_id}
                      id={`lanes-map-flow-${m.lane.lane_id}`}
                      working={
                        m.lane.state === "active" &&
                        !!m.lane.lead?.presence.working
                      }
                      x1={cx}
                      y1={cy}
                      x2={pt.x}
                      y2={pt.y}
                      stroke={p[m.stateTone]}
                      opacity={
                        pt.small
                          ? 0.1
                          : m.lane.state === "active" &&
                              m.lane.lead?.presence.working
                            ? 0.55
                            : 0.2
                      }
                      strokeWidth={1.2}
                      strokeDasharray={
                        m.lane.state === "active" &&
                        m.lane.lead?.presence.working
                          ? "3 6"
                          : "2 4"
                      }
                    />
                  );
                })}
              </>
            ) : (
              <>
                <Circle
                  cx={fx}
                  cy={fy}
                  r={sr}
                  stroke={
                    stack ? (stack === "pending" ? p.dim : p.green) : color
                  }
                  opacity={0.14}
                  strokeDasharray="2 5"
                  fill="none"
                />
                {nodes.map((node, i) => (
                  <Line
                    key={i}
                    x1={fx}
                    y1={fy}
                    x2={nodePoints[i].x}
                    y2={nodePoints[i].y}
                    stroke={
                      "member" in node && node.member.spec_id === selected
                        ? memberTone(node.member)
                        : stack
                          ? stack === "pending"
                            ? p.dim
                            : p.green
                          : color
                    }
                    strokeDasharray={
                      "member" in node && node.member.status === "in_progress"
                        ? "3 5"
                        : undefined
                    }
                    opacity={
                      "member" in node && node.member.spec_id === selected
                        ? 0.8
                        : 0.3
                    }
                    strokeWidth={1}
                  />
                ))}
              </>
            )}
          </Svg>
          {!focused ? (
            <Pressable
              testID="lanes-map-assistant"
              accessibilityRole="button"
              accessibilityLabel={assistantName}
              onPress={() => onFocusLane(null)}
              style={{
                position: "absolute",
                left: cx - 34,
                top: cy - 34,
                width: 68,
                height: 68,
              }}
            >
              <ArcaneRingFrame size={68} color={p.green}>
                <MachineSigil kind={assistantSigil} size={44} color={p.green} />
              </ArcaneRingFrame>
            </Pressable>
          ) : null}
          {actualLanes.map((m) => (
            <LaneNode
              key={m.lane.lane_id}
              model={m}
              point={lanePoint(m)}
              width={402}
              selected={m === focused}
              onPress={() => {
                setSelected(null);
                setStack(null);
                onFocusLane(m.lane.lane_id);
              }}
            />
          ))}
          {!focused && open.length > 16 ? (
            <Pressable
              testID="lanes-map-overflow"
              accessibilityRole="button"
              accessibilityLabel={`Show all ${open.length} lanes`}
              onPress={() => onShowAll(open[0])}
              style={{
                position: "absolute",
                left: 340,
                top: 570,
                borderWidth: 1,
                borderColor: p.line,
                borderRadius: 20,
                padding: 10,
              }}
            >
              <Text style={body}>+{open.length - visible.length}</Text>
            </Pressable>
          ) : null}
          {focused
            ? nodes.map((node, i) =>
                "member" in node ? (
                  <SpecNode
                    key={node.member.spec_id}
                    member={node.member}
                    model={focused}
                    point={nodePoints[i]}
                    dense={dense}
                    selected={node.member.spec_id === selected}
                    onPress={() => select(node.member)}
                  />
                ) : (
                  <StackNode
                    key={node.kind}
                    kind={node.kind}
                    count={node.count}
                    point={nodePoints[i]}
                    laneId={focused.lane.lane_id}
                    onPress={() => {
                      setSelected(null);
                      setStack(node.kind);
                    }}
                  />
                ),
              )
            : null}
          {focused ? (
            <Pressable
              testID="lanes-map-back"
              accessibilityRole="button"
              accessibilityLabel="Back to all lanes"
              onPress={back}
              style={{
                position: "absolute",
                left: 12,
                top: 52,
                zIndex: 6,
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                borderWidth: 1,
                borderColor: p.line,
                borderRadius: 14,
                maxWidth: 140,
                paddingVertical: 5,
                paddingHorizontal: 10,
                backgroundColor: p.ink,
              }}
            >
              <Icon kind="back" size={13} />
              <Text
                numberOfLines={1}
                style={{
                  ...body,
                  fontSize: 12.5,
                  fontFamily: Fonts.rajdhani.bold,
                }}
              >
                {selected
                  ? stack
                    ? stack === "done"
                      ? "Done"
                      : "Pending"
                    : focused.lane.title
                  : stack
                    ? focused.lane.title
                    : "All lanes"}
              </Text>
            </Pressable>
          ) : null}
          {stack && focused ? (
            <Pressable
              testID="lanes-map-stack-close"
              accessibilityRole="button"
              accessibilityLabel={`Close ${stack}`}
              onPress={() => {
                setSelected(null);
                setStack(null);
              }}
              style={{
                position: "absolute",
                right: 12,
                top: 52,
                zIndex: 6,
                flexDirection: "row",
                gap: 6,
                borderWidth: 1,
                borderStyle: stack === "done" ? "solid" : "dashed",
                borderColor: stack === "done" ? `${p.green}88` : p.dim,
                borderRadius: 14,
                paddingVertical: 5,
                paddingHorizontal: 10,
                backgroundColor: p.ink,
              }}
            >
              <Text
                style={{
                  ...mono,
                  fontSize: 10,
                  letterSpacing: 1,
                  color: stack === "done" ? p.green : p.dim,
                }}
              >
                {stack.toUpperCase()} · {stackList?.length}
              </Text>
              <Icon kind="close" size={12} />
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
      {!focused ? (
        <View
          style={{
            position: "absolute",
            left: 14,
            right: 14,
            bottom: 22,
            gap: 12,
          }}
        >
          {!open.length ? <Text style={body}>No open lanes</Text> : null}
          <View
            style={{ flexDirection: "row", gap: 10, justifyContent: "center" }}
          >
            {(["active", "blocked", "paused"] as const).map((state) => (
              <View
                key={state}
                style={{ flexDirection: "row", alignItems: "center", gap: 5 }}
              >
                {state === "active" ? (
                  <Spinner
                    size={10}
                    color={p.green}
                    strokeWidth={1.7}
                    segmentFraction={0.25}
                  />
                ) : state === "blocked" ? (
                  <Bang size={10} />
                ) : (
                  <Pause size={10} />
                )}
                <Text style={{ ...mono, letterSpacing: 0.8 }}>
                  {open.filter((m) => m.lane.state === state).length}{" "}
                  {state.toUpperCase()}
                </Text>
              </View>
            ))}
          </View>
          <Pressable
            testID="lanes-latest-update"
            accessibilityRole="button"
            accessibilityLabel="Open update log"
            onPress={onAllUpdates}
          >
            <Bevel
              cut={10}
              fill="rgba(8,11,10,0.92)"
              stroke={`${p.green}33`}
              contentStyle={{
                paddingHorizontal: 13,
                paddingVertical: 11,
                gap: 4,
              }}
            >
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 7 }}
              >
                <Text style={{ ...label, fontSize: 10 }}>
                  LATEST · {laneTime(updates[0]?.update.ts)}
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
              <View
                style={{ flexDirection: "row", gap: 8, alignItems: "center" }}
              >
                <Text
                  style={{ ...body, color: p.text, lineHeight: 20, flex: 1 }}
                >
                  {updates[0]?.update.summary || "No updates yet"}
                </Text>
                <Icon kind="chevron" size={13} />
              </View>
            </Bevel>
          </Pressable>
        </View>
      ) : (
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            top: Math.min(410 * scale, height * 0.6),
            backgroundColor: "rgba(10,16,13,0.97)",
            borderTopWidth: 1,
            borderColor: `${color}44`,
            borderTopLeftRadius: 14,
            borderTopRightRadius: 14,
          }}
        >
          <View
            style={{
              width: 36,
              height: 4,
              borderRadius: 2,
              backgroundColor: p.line,
              alignSelf: "center",
              marginTop: 8,
            }}
          />
          <ScrollView
            contentContainerStyle={{
              paddingHorizontal: 16,
              paddingTop: 10,
              paddingBottom: 24,
              gap: 11,
            }}
          >
            {selMember ? (
              <LaneMemberDetail
                model={focused}
                member={selMember}
                laneTitle={focused.lane.title}
                onBack={() => setSelected(null)}
              />
            ) : stackList ? (
              <View testID={`lane-members-${focused.lane.lane_id}`}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Back to ${focused.lane.title}`}
                  onPress={() => {
                    setSelected(null);
                    setStack(null);
                  }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                    paddingBottom: 10,
                  }}
                >
                  <Icon kind="back" size={13} />
                  <Text
                    style={{
                      ...body,
                      fontSize: 13,
                      fontFamily: Fonts.rajdhani.bold,
                    }}
                  >
                    {focused.lane.title}
                  </Text>
                </Pressable>
                <Text style={[label, { paddingBottom: 6, color: p.muted }]}>
                  {stack} · {stackList.length}
                </Text>
                {stackList.map((member) => (
                  <StepRow
                    chevron
                    key={member.spec_id}
                    id={`lane-members-row-${member.spec_id}`}
                    member={member}
                    model={focused}
                    onPress={() => select(member)}
                  />
                ))}
              </View>
            ) : (
              <>
                <View
                  style={{ flexDirection: "row", gap: 6, alignItems: "center" }}
                >
                  <LaneGlyph model={focused} size={11} />
                  <Text style={{ ...mono, letterSpacing: 1, color }}>
                    {focused.stateLabel}
                  </Text>
                  <Text style={mono}>· {focused.freshnessLabel}</Text>
                </View>
                <View>
                  <Text
                    style={{
                      ...body,
                      fontSize: 19,
                      fontFamily: Fonts.rajdhani.bold,
                      color: p.text,
                    }}
                  >
                    {focused.lane.title}
                  </Text>
                  {focused.lane.summary ? (
                    <Text
                      style={{
                        ...body,
                        fontSize: 13.5,
                        lineHeight: 19,
                        marginTop: 3,
                      }}
                    >
                      {focused.lane.summary}
                    </Text>
                  ) : null}
                </View>
                {blockerText(focused) ? (
                  <View style={{ flexDirection: "row", gap: 7 }}>
                    <LaneGlyph model={focused} />
                    <Text
                      style={{
                        ...body,
                        color: p.amber,
                        fontFamily: Fonts.rajdhani.bold,
                        flex: 1,
                      }}
                    >
                      {blockerText(focused)}
                    </Text>
                  </View>
                ) : null}
                <View style={{ flexDirection: "row", gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={mono}>SPECS</Text>
                    <Text
                      style={{
                        ...mono,
                        color: p.text,
                        fontSize: 15,
                        fontFamily: Fonts.jetBrainsMono.bold,
                        marginTop: 3,
                      }}
                    >
                      {focused.completed}/{focused.total}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={mono}>ACCEPTANCE</Text>
                    <Text
                      style={{
                        ...mono,
                        color: p.text,
                        fontSize: 15,
                        fontFamily: Fonts.jetBrainsMono.bold,
                        marginTop: 3,
                      }}
                    >
                      {focused.lane.ac_checked ?? "—"}/
                      {focused.lane.ac_total ?? "—"}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={mono}>EST WORK</Text>
                    <LeafText
                      id={`lanes-map-progress-${focused.lane.lane_id}`}
                      text={progressValue(focused)}
                      style={{
                        ...mono,
                        color: p.text,
                        fontSize: 15,
                        fontFamily: Fonts.jetBrainsMono.bold,
                        marginTop: 3,
                      }}
                    />
                    <Text
                      style={{
                        ...mono,
                        fontSize: 8.5,
                        marginTop: 2,
                        lineHeight: 11,
                      }}
                    >
                      {focused.progressLabel.startsWith("est. open work ") &&
                      focused.lane.open_estimate_h
                        ? focused.lane.estimate_complete
                          ? `median ${focused.lane.open_estimate_h.median}h`
                          : focused.lane.open_estimated != null &&
                              focused.lane.items_open != null
                            ? `${focused.lane.open_estimated} of ${focused.lane.items_open} open specs estimated`
                            : ""
                        : ""}
                    </Text>
                  </View>
                </View>
                {focused.membersPending ? (
                  <LeafText
                    id={`lanes-map-members-pending-${focused.lane.lane_id}`}
                    text="Specs arrive when the daemon updates"
                    style={body}
                  />
                ) : focused.lane.no_spec_reason ? (
                  <Text style={body}>{focused.lane.no_spec_reason}</Text>
                ) : (
                  <Segments model={focused} />
                )}
                <UpdateRow
                  connected={connected}
                  readShow={readShow}
                  model={focused}
                  showCount
                  id={`lanes-map-log-${focused.lane.lane_id}`}
                  onPress={() => onLog(focused)}
                />
                {focused.tap.action === "unavailable" ? (
                  <Text style={mono}>CHAT UNAVAILABLE</Text>
                ) : (
                  <Pressable
                    testID={`lanes-map-chat-${focused.lane.lane_id}`}
                    accessibilityRole="button"
                    accessibilityLabel={
                      focused.tap.action === "history"
                        ? "View closed chat"
                        : `Open ${focused.leadHost || "lead"} chat`
                    }
                    onPress={() => onChat(focused)}
                    style={{
                      borderWidth: 1,
                      borderColor: color,
                      borderRadius: 4,
                      padding: 11,
                      backgroundColor:
                        focused.tap.action === "history"
                          ? "transparent"
                          : color,
                    }}
                  >
                    <Text
                      style={{
                        ...body,
                        fontSize: 15,
                        fontFamily: Fonts.rajdhani.bold,
                        color: focused.tap.action === "history" ? color : p.ink,
                        textAlign: "center",
                      }}
                    >
                      {focused.tap.action === "history"
                        ? "View closed chat"
                        : `Open ${focused.leadHost || "lead"} chat`}
                    </Text>
                  </Pressable>
                )}
                {dense ? (
                  <View testID={`lane-members-${focused.lane.lane_id}`}>
                    <Text style={label}>Live specs · {group.live.length}</Text>
                    {group.live.map((member) => (
                      <StepRow
                        chevron
                        key={member.spec_id}
                        id={`lane-members-row-${member.spec_id}`}
                        member={member}
                        model={focused}
                        onPress={() => select(member)}
                      />
                    ))}
                  </View>
                ) : null}
              </>
            )}
            {show.loading ? (
              <LeafLoading
                id="lane-members-loading"
                text="Loading lane members"
              />
            ) : null}
            {show.error ||
            (show.data &&
              show.data.members.length <
                (show.data.projection?.members_total ??
                  focused.membersTotal)) ? (
              <View testID="lane-members-error">
                <Text style={{ ...body, color: p.red }}>
                  {show.error || "Incomplete member list. Please retry."}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Retry members"
                  onPress={() => void show.retry()}
                >
                  <Text style={body}>Retry</Text>
                </Pressable>
              </View>
            ) : null}
          </ScrollView>
        </View>
      )}
    </View>
  );
}
