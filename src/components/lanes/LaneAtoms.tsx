import { useLastLaneUpdate } from "./useLastLaneUpdate";
import type { ReadWorkLaneShow } from "./useWorkLaneShow";
import React from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  View,
  type TextStyle,
} from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { Fonts, Tokens, MACHINES } from "@/constants/Colors";
import { getHostMachineName } from "../../config/local";
import ArcaneRingFrame from "../ArcaneRingFrame";
import MachineSigil from "../MachineSigil";
import { Spinner } from "../ArcaneAtoms";
import type { LaneCardViewModel } from "../../services/workLanes";
import type { WorkLaneMember } from "pentacle-chat-core";
export const p = Tokens.palette;
export const mono: TextStyle = {
  fontFamily: Fonts.jetBrainsMono.regular,
  color: p.muted,
  fontSize: 9.5,
};
export const label: TextStyle = {
  ...mono,
  fontFamily: Fonts.jetBrainsMono.bold,
  color: p.green,
  letterSpacing: 1.4,
  fontSize: 10.5,
  textTransform: "uppercase",
};
export const body: TextStyle = {
  fontFamily: Fonts.rajdhani.medium,
  fontSize: 14,
  color: p.dim,
};
export function LeafText({
  id,
  text,
  style,
}: {
  id: string;
  text: string;
  style?: TextStyle | TextStyle[];
}) {
  return (
    <View
      testID={id}
      accessible
      collapsable={false}
      accessibilityRole="text"
      accessibilityLabel={text}
    >
      <Text accessible={false} style={style}>
        {text}
      </Text>
    </View>
  );
}
export function LeafLoading({ id, text }: { id: string; text: string }) {
  return (
    <View
      testID={id}
      accessible
      collapsable={false}
      accessibilityRole="progressbar"
      accessibilityState={{ busy: true }}
      accessibilityLabel={text}
    >
      <ActivityIndicator accessible={false} color={p.green} />
    </View>
  );
}
export function LaneMark({
  model,
  size = 32,
}: {
  model: LaneCardViewModel;
  size?: number;
}) {
  const meta = MACHINES[getHostMachineName(model.leadHost || "")];
  const monogram = meta.kind === "djinni";
  const color = monogram ? p.muted : meta.accent;
  return (
    <ArcaneRingFrame size={size} color={color} identity>
      {monogram ? (
        <Text
          style={{
            fontFamily: Fonts.cinzel.bold,
            fontSize: size * 0.38,
            color: p.dim,
          }}
        >
          B
        </Text>
      ) : (
        <MachineSigil kind={meta.kind} size={size * 0.62} color={color} />
      )}
    </ArcaneRingFrame>
  );
}
export function Icon({
  kind,
  size = 16,
  color = p.dim,
}: {
  kind: "list" | "map" | "close" | "chevron" | "back";
  size?: number;
  color?: string;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === "list" ? (
        <Path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
      ) : kind === "map" ? (
        <>
          <Circle cx={12} cy={12} r={3} />
          <Circle cx={12} cy={3.5} r={1.8} />
          <Circle cx={20} cy={15.5} r={1.8} />
          <Circle cx={4} cy={15.5} r={1.8} />
          <Path d="M12 6v3M18.4 14.6l-3.8-1.6M5.6 14.6l3.8-1.6" />
        </>
      ) : (
        <Path
          d={
            kind === "close"
              ? "M6 6l12 12M18 6L6 18"
              : kind === "back"
                ? "M15 6l-6 6 6 6"
                : "M9 6l6 6-6 6"
          }
        />
      )}
    </Svg>
  );
}
export function Bang({
  question = false,
  color = p.amber,
  size = 12,
}: {
  question?: boolean;
  color?: string;
  size?: number;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 1.6,
        borderColor: color,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        accessible={false}
        allowFontScaling={false}
        style={{
          ...mono,
          fontFamily: Fonts.jetBrainsMono.bold,
          color,
          fontSize: size * 0.7,
          lineHeight: size * 0.85,
        }}
      >
        {question ? "?" : "!"}
      </Text>
    </View>
  );
}
export function Pause({ size = 12 }: { size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        flexDirection: "row",
        gap: size * 0.22,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {[0, 1].map((k) => (
        <View
          key={k}
          style={{
            width: size * 0.22,
            height: size * 0.8,
            borderRadius: 1,
            backgroundColor: p.muted,
          }}
        />
      ))}
    </View>
  );
}
export function LaneGlyph({
  model,
  size = 12,
}: {
  model: LaneCardViewModel;
  size?: number;
}) {
  if (model.waitingOnYou) return <Bang question size={size} />;
  if (model.lane.state === "blocked") return <Bang size={size} />;
  if (model.lane.state === "paused") return <Pause size={size} />;
  return model.lane.lead?.presence.working ? (
    <Spinner
      size={size}
      color={p.green}
      strokeWidth={2}
      segmentFraction={0.25}
    />
  ) : (
    <View
      style={{
        width: size - 1,
        height: size - 1,
        borderRadius: size / 2,
        borderWidth: 1.6,
        borderColor: p.green,
        opacity: 0.7,
      }}
    />
  );
}
export function memberTone(member: WorkLaneMember, model?: LaneCardViewModel) {
  if (
    ["missing", "ambiguous"].includes(member.status || "") ||
    ["missing", "ambiguous"].includes(member.observation?.quality || "")
  )
    return p.red;
  if (member.status === "completed") return p.green;
  if (member.status === "needs_qa") return p.text;
  if (member.status === "in_progress")
    return model ? p[model.stateTone] : p.green;
  return ["ready_for_dev", "analysis"].includes(member.status || "")
    ? p.dim
    : p.muted;
}
export function SpecGlyph({
  member,
  model,
  size = 12,
}: {
  member: WorkLaneMember;
  model?: LaneCardViewModel;
  size?: number;
}) {
  const color = memberTone(member, model),
    status = member.status;
  if (
    ["missing", "ambiguous"].includes(member.observation?.quality || "") ||
    status === "missing" ||
    status === "ambiguous"
  )
    return <Bang color={p.red} size={size} />;
  if (status === "completed")
    return (
      <Svg width={size} height={size} viewBox="0 0 12 12">
        <Circle cx={6} cy={6} r={6} fill={p.green} />
        <Path
          d="M3.3 6.2l1.8 1.8 3.6-3.8"
          stroke={p.ink}
          strokeWidth={1.6}
          fill="none"
        />
      </Svg>
    );
  if (status === "in_progress") {
    if (model?.lane.state === "blocked" || model?.waitingOnYou)
      return <Bang question={!!model.waitingOnYou} size={size} />;
    if (
      model &&
      (model.lane.state === "paused" || !model.lane.lead?.presence.working)
    )
      return <Pause size={size} />;
    return (
      <Spinner
        size={size}
        color={p.green}
        strokeWidth={2}
        segmentFraction={0.25}
      />
    );
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 1.4,
        borderColor: color,
        borderStyle: status === "backlog" ? "dotted" : "solid",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      {status === "needs_qa" ? (
        <View
          style={{
            width: size * 0.35,
            height: size * 0.35,
            borderRadius: size,
            backgroundColor: color,
          }}
        />
      ) : null}
    </View>
  );
}
export function ProgressRing({
  size,
  fraction,
  color,
}: {
  size: number;
  fraction: number;
  color: string;
}) {
  const r = 44.8,
    c = Math.PI * 2 * r;
  return (
    <Svg
      pointerEvents="none"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      style={{ position: "absolute", transform: [{ rotate: "-90deg" }] }}
    >
      <Circle
        cx={50}
        cy={50}
        r={r}
        stroke={color}
        opacity={0.16}
        strokeWidth={5.2}
        fill="none"
      />
      <Circle
        cx={50}
        cy={50}
        r={r}
        stroke={color}
        strokeWidth={5.2}
        strokeDasharray={`${Math.max(0, Math.min(1, fraction)) * c} ${c}`}
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}
export function Segments({
  model,
  height = 5,
}: {
  model: LaneCardViewModel;
  height?: number;
}) {
  return (
    <View style={{ flexDirection: "row", gap: 3 }}>
      {model.segments.map((segment) => (
        <View
          key={segment.specId}
          testID={`lane-segment-${model.lane.lane_id}-${segment.specId}`}
          accessibilityLabel={`${segment.status}, ${Math.round(segment.fraction * 100)} percent`}
          style={{
            flex: 1,
            height,
            backgroundColor: segment.unresolved ? `${p.red}44` : "#14211b",
            borderRadius: 2,
            overflow: "hidden",
          }}
        >
          <View
            style={{
              height: "100%",
              width: `${segment.fraction * 100}%`,
              backgroundColor:
                segment.status === "completed" && model.lane.state !== "paused"
                  ? p.green
                  : p[segment.tone],
              opacity: segment.status === "completed" ? 0.9 : 0.75,
            }}
          />
        </View>
      ))}
    </View>
  );
}
export const progressValue = (model: LaneCardViewModel) =>
  model.progressLabel.replace(/^est\. open work /, "");
export const blockerText = (model: LaneCardViewModel) =>
  model.waitingOnYou
    ? `Waiting on you: ${model.waitingOnYou} ${model.waitingOnYou === 1 ? "question" : "questions"}`
    : model.blockerLabel;
export function TypeChip({ type }: { type: string }) {
  const color = ["blocked", "lane_blocked"].includes(type)
    ? p.amber
    : [
          "milestone",
          "completed",
          "unblocked",
          "lane_completed",
          "lane_unblocked",
        ].includes(type)
      ? p.green
      : p.dim;
  return (
    <Text
      style={{
        ...mono,
        color,
        fontSize: 9,
        letterSpacing: 1,
        fontFamily: Fonts.jetBrainsMono.bold,
        borderWidth: 1,
        borderColor: `${color}55`,
        borderRadius: 3,
        paddingHorizontal: 5,
        paddingVertical: 1,
        textTransform: "uppercase",
      }}
    >
      {(
        {
          lane_started: "started",
          lane_blocked: "blocked",
          major_decision: "decision",
          lane_completed: "completed",
        } as Record<string, string>
      )[type] || type}
    </Text>
  );
}
export function UpdateRow({
  model,
  id,
  onPress,
  connected = true,
  readShow,
  showCount = false,
}: {
  model: LaneCardViewModel;
  id: string;
  onPress(): void;
  connected?: boolean;
  readShow?: ReadWorkLaneShow;
  showCount?: boolean;
}) {
  const { text, count } = useLastLaneUpdate(model, connected, readShow);
  return (
    <Pressable
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={`View log for ${model.lane.title}`}
      onPress={onPress}
      style={{
        flexDirection: "row",
        gap: 8,
        alignItems: "center",
        borderWidth: 1,
        borderColor: p.line,
        borderRadius: 4,
        paddingHorizontal: 9,
        paddingVertical: 8,
        backgroundColor: "rgba(255,255,255,0.025)",
      }}
    >
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ flexDirection: "row", gap: 7, alignItems: "center" }}>
          <TypeChip type={model.lane.last_update?.kind || "LOG"} />
          {model.lane.last_update ? (
            <Text style={mono}>
              {laneTime(model.lane.last_update.ts)}
              {showCount && count != null ? ` · ${count} UPDATES` : ""}
            </Text>
          ) : null}
        </View>
        <Text
          numberOfLines={2}
          style={{ ...body, fontSize: 13.5, lineHeight: 19 }}
        >
          {text || "No updates yet"}
        </Text>
      </View>
      <Icon kind="chevron" size={13} />
    </Pressable>
  );
}

export function laneTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
