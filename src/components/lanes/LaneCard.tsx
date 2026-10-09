import { useLaneMembers } from "./useLaneMembers";
import { traceMemberList } from "./lanesTelemetry";
import React, { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { WorkLaneMember } from "pentacle-chat-core";
import Bevel from "../Bevel";
import { Fonts } from "@/constants/Colors";
import type { LaneCardViewModel } from "../../services/workLanes";
import {
  MemberContent,
  memberAcceptance,
  memberTitle,
} from "./LaneMemberDetail";
import {
  body,
  blockerText,
  Icon,
  LaneGlyph,
  LaneMark,
  LeafLoading,
  LeafText,
  mono,
  p,
  progressValue,
  Segments,
  SpecGlyph,
  UpdateRow,
} from "./LaneAtoms";
import { useWorkLaneShow, type ReadWorkLaneShow } from "./useWorkLaneShow";
export type ListVariant = "current" | "bars" | "compact";
export function StepRow({
  member,
  model,
  open,
  onPress,
  id,
  bars = false,
  chevron = false,
}: {
  member: WorkLaneMember;
  model: LaneCardViewModel;
  open?: boolean;
  onPress(): void;
  id: string;
  bars?: boolean;
  chevron?: boolean;
}) {
  const q = member.observation?.quality,
    terminal =
      !!member.terminal ||
      ["completed", "deprecated"].includes(member.status || "");
  return (
    <View>
      <Pressable
        testID={id}
        accessibilityRole="button"
        accessibilityLabel={`${memberTitle(member)}, ${member.status || "unknown"}`}
        accessibilityState={{ expanded: !!open }}
        onPress={onPress}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 9,
          paddingVertical: chevron ? 9 : 6,
          borderTopWidth: chevron ? 1 : 0,
          borderColor: p.line,
        }}
      >
        <View style={{ width: 14, alignItems: "center" }}>
          <SpecGlyph member={member} model={model} />
        </View>
        <Text
          numberOfLines={1}
          style={{
            ...body,
            fontFamily: terminal ? Fonts.rajdhani.medium : Fonts.rajdhani.bold,
            color: terminal ? p.muted : p.text,
            flex: 1,
          }}
        >
          {memberTitle(member)}
        </Text>
        {q && q !== "fresh" ? (
          <Text
            style={{
              ...mono,
              fontFamily: Fonts.jetBrainsMono.bold,
              fontSize: 8.5,
              letterSpacing: 1,
              color: q === "stale" ? p.amber : p.red,
            }}
          >
            {q.toUpperCase()}
          </Text>
        ) : !chevron && !terminal && member.status !== "in_progress" ? (
          <Text style={{ ...mono, fontSize: 9, letterSpacing: 0.6 }}>
            {(member.status === "ready_for_dev" ? "ready" : member.status || "")
              .replace(/_/g, " ")
              .toUpperCase()}
          </Text>
        ) : null}
        {bars &&
        ["in_progress", "needs_qa"].includes(member.status || "") &&
        member.ac_total ? (
          <View
            style={{
              width: 44,
              height: 4,
              backgroundColor: "#14211b",
              borderRadius: 2,
              overflow: "hidden",
            }}
          >
            <View
              style={{
                width: `${((member.ac_checked || 0) / member.ac_total) * 100}%`,
                height: 4,
                backgroundColor: p[model.stateTone],
              }}
            />
          </View>
        ) : null}
        <Text
          style={{ ...mono, fontSize: 10.5, minWidth: 28, textAlign: "right" }}
        >
          {chevron && member.ac_total == null
            ? (
                {
                  analysis: "Analysis",
                  backlog: "Backlog",
                  ready_for_dev: "Ready",
                  missing: "Missing",
                  ambiguous: "Ambiguous",
                } as Record<string, string>
              )[member.status || ""] || "—"
            : memberAcceptance(member)}
        </Text>
        {chevron ? <Icon kind="chevron" size={13} /> : null}
      </Pressable>
      {open ? (
        <View
          style={{
            marginLeft: 23,
            marginBottom: 6,
            borderWidth: 1,
            borderColor: p.line,
            borderRadius: 4,
            paddingHorizontal: 10,
            paddingVertical: 8,
          }}
        >
          <MemberContent member={member} inline />
        </View>
      ) : null}
    </View>
  );
}
export default function LaneCard({
  model,
  onOpenMember,
  onShowAll,
  onLog,
  onChat,
  connected = true,
  readShow,
  variant = "compact",
}: {
  model: LaneCardViewModel;
  onOpenMember(model: LaneCardViewModel, member: WorkLaneMember): void;
  onShowAll(model: LaneCardViewModel): void;
  onLog(model: LaneCardViewModel): void;
  onChat(model: LaneCardViewModel): void;
  connected?: boolean;
  readShow?: ReadWorkLaneShow;
  variant?: ListVariant;
}) {
  const [expanded, setExpanded] = useState(false),
    [selected, setSelected] = useState<string | null>(null);
  const needsShow = model.membersTotal > model.members.length;
  const { data, loading, error, retry } = useWorkLaneShow(
    model.lane.lane_id,
    connected,
    expanded && needsShow,
    readShow,
  );
  const members = useLaneMembers(model.members, data),
    total = data?.projection?.members_total ?? model.membersTotal;
  const incomplete = data && members.length < total;
  const current = members.filter(
    (m) => m.status === "in_progress" || m.status === "needs_qa",
  );
  const shown = expanded ? members : variant === "compact" ? [] : current;
  const { lane } = model,
    blocker = blockerText(model);
  useEffect(() => {
    if (selected && !members.some((m) => m.spec_id === selected))
      setSelected(null);
  }, [members, selected]);
  useEffect(() => {
    if (expanded && !loading && !error && !incomplete)
      traceMemberList(lane.lane_id, members);
  }, [
    expanded,
    loading,
    error,
    !!incomplete,
    lane.lane_id,
    members.map((m) => m.spec_id).join("|"),
  ]);
  const truncated = needsShow && (!data || incomplete);
  const compact = variant === "compact";
  const toggleId = `lane-card-${truncated ? "show-all" : "toggle"}-${lane.lane_id}`;
  const toggle = () => {
    setExpanded((v) => !v);
    if (truncated) onShowAll(model);
  };
  return (
    <View
      testID={`lane-card-${lane.lane_id}`}
      style={{ opacity: lane.state === "paused" ? 0.88 : 1 }}
    >
      <Bevel
        cut={10}
        fill={lane.state === "paused" ? "transparent" : "rgba(13,20,17,0.72)"}
        stroke={lane.state === "blocked" ? `${p.amber}44` : p.line}
        contentStyle={{
          paddingTop: 12,
          paddingHorizontal: 13,
          paddingBottom: 10,
          gap: 9,
        }}
      >
        <Pressable
          testID={`lane-card-chat-${lane.lane_id}`}
          accessibilityRole="button"
          accessibilityLabel={`See chat for ${lane.title}`}
          disabled={model.tap.action === "unavailable"}
          accessibilityState={{ disabled: model.tap.action === "unavailable" }}
          onPress={() => onChat(model)}
          style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}
        >
          <LaneMark model={model} />
          <View style={{ flex: 1 }}>
            <Text
              style={{
                ...body,
                fontSize: 15.5,
                lineHeight: 19,
                fontFamily: Fonts.rajdhani.bold,
                color: p.text,
              }}
            >
              {lane.title}
            </Text>
            <View
              style={{
                flexDirection: "row",
                gap: 6,
                alignItems: "center",
                marginTop: 4,
                flexWrap: "nowrap",
              }}
            >
              <LaneGlyph model={model} size={10} />
              <Text
                testID={`lane-card-state-${lane.lane_id}`}
                style={{
                  ...mono,
                  fontFamily: Fonts.jetBrainsMono.bold,
                  letterSpacing: 1,
                  color: p[model.stateTone],
                }}
              >
                {model.stateLabel}
              </Text>
              <Text numberOfLines={1} style={{ ...mono, flex: 1, minWidth: 0 }}>
                · {model.leadHost || "no lead"} · {model.freshnessLabel}
                {model.tap.action === "unavailable"
                  ? " · chat unavailable"
                  : ""}
              </Text>
            </View>
          </View>
          <View style={{ alignItems: "flex-end", maxWidth: 115 }}>
            <Text
              testID={`lane-card-progress-${lane.lane_id}`}
              style={{
                ...mono,
                color: lane.state === "active" ? p.text : p.muted,
                fontSize: progressValue(model).length > 14 ? 10 : 13,
                fontFamily: Fonts.jetBrainsMono.bold,
              }}
            >
              {progressValue(model)}
            </Text>
            <Text
              style={{ ...mono, fontSize: 8.5, letterSpacing: 1, marginTop: 2 }}
            >
              EST WORK
            </Text>
          </View>
        </Pressable>
        {!model.membersPending && !lane.no_spec_reason ? (
          <Pressable
            testID={compact ? toggleId : undefined}
            accessibilityRole={compact ? "button" : undefined}
            accessibilityLabel={
              compact
                ? `${expanded ? "Hide" : "Show"} specs for ${lane.title}`
                : undefined
            }
            accessibilityState={compact ? { expanded } : undefined}
            onPress={compact ? toggle : undefined}
            style={{ gap: 5 }}
          >
            <Segments model={model} height={compact ? 7 : 5} />
            <View style={{ flexDirection: "row", gap: 6 }}>
              <Text style={{ ...mono, flex: 1, letterSpacing: 0.5 }}>
                {model.completed}/{model.total} SPECS DONE
                {compact && current.length
                  ? ` · ${current.length} IN PROGRESS`
                  : ""}
                {lane.items_unresolved
                  ? ` · ${lane.items_unresolved} UNRESOLVED`
                  : ""}
              </Text>
              <Text style={mono}>
                AC {lane.ac_checked ?? "—"}/{lane.ac_total ?? "—"}
              </Text>
              {compact ? (
                <View
                  style={{
                    transform: [{ rotate: expanded ? "-90deg" : "90deg" }],
                  }}
                >
                  <Icon kind="chevron" size={13} />
                </View>
              ) : null}
            </View>
          </Pressable>
        ) : null}
        {blocker ? (
          <View style={{ flexDirection: "row", gap: 7 }}>
            <LaneGlyph model={model} />
            <Text
              style={{
                ...body,
                flex: 1,
                fontSize: 13.5,
                lineHeight: 19,
                fontFamily: Fonts.rajdhani.bold,
                color: p.amber,
              }}
            >
              {blocker}
            </Text>
          </View>
        ) : null}
        {!compact || expanded || model.membersPending || lane.no_spec_reason ? (
          <View
            style={{
              borderTopWidth: 1,
              borderColor: "rgba(255,255,255,0.05)",
              paddingTop: 4,
            }}
          >
            {lane.no_spec_reason ? (
              <Text style={body}>{lane.no_spec_reason}</Text>
            ) : model.membersPending ? (
              <LeafText
                id={`lane-card-members-pending-${lane.lane_id}`}
                text="Specs arrive when the daemon updates"
                style={{ ...body, color: p.muted, fontSize: 13 }}
              />
            ) : (
              <>
                {shown.map((member) => (
                  <StepRow
                    key={member.spec_id}
                    member={member}
                    model={model}
                    bars={variant !== "current"}
                    id={`lane-card-member-${lane.lane_id}-${member.spec_id}`}
                    open={selected === member.spec_id}
                    onPress={() => {
                      setSelected((v) =>
                        v === member.spec_id ? null : member.spec_id,
                      );
                      onOpenMember(model, member);
                    }}
                  />
                ))}
                {loading ? (
                  <LeafLoading
                    id="lane-members-loading"
                    text="Loading lane members"
                  />
                ) : null}
                {error || incomplete ? (
                  <View testID="lane-members-error">
                    <Text style={{ ...body, color: p.red }}>
                      {error || "Incomplete member list. Please retry."}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Retry members"
                      onPress={() => void retry()}
                    >
                      <Text style={body}>Retry</Text>
                    </Pressable>
                  </View>
                ) : null}
                {!compact && (total > current.length || expanded) ? (
                  <Pressable
                    testID={`lane-card-${truncated ? "show-all" : "toggle"}-${lane.lane_id}`}
                    accessibilityRole="button"
                    accessibilityLabel={`${expanded ? "Hide" : "Show"} specs for ${lane.title}`}
                    accessibilityState={{ expanded }}
                    onPress={toggle}
                    style={{
                      alignSelf: "flex-start",
                      flexDirection: "row",
                      gap: 4,
                      alignItems: "center",
                      paddingTop: 5,
                      paddingBottom: 2,
                      paddingLeft: 23,
                    }}
                  >
                    <Text
                      style={{
                        ...body,
                        fontSize: 13,
                        fontFamily: Fonts.rajdhani.bold,
                      }}
                    >
                      {expanded ? "Show current only" : `All ${total} specs`}
                    </Text>
                    <View
                      style={{
                        transform: [{ rotate: expanded ? "-90deg" : "90deg" }],
                      }}
                    >
                      <Icon kind="chevron" size={13} />
                    </View>
                  </Pressable>
                ) : null}
              </>
            )}
          </View>
        ) : null}
        {!compact ? (
          <UpdateRow
            connected={connected}
            readShow={readShow}
            model={model}
            id={`lane-card-log-${lane.lane_id}`}
            onPress={() => onLog(model)}
          />
        ) : null}
      </Bevel>
    </View>
  );
}
