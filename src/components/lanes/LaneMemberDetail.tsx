import React from "react";
import { Pressable, Text, View } from "react-native";
import type { WorkLaneMember } from "pentacle-chat-core";
import { Fonts } from "@/constants/Colors";
import { body, Icon, label, mono, p, SpecGlyph, laneTime } from "./LaneAtoms";
import { formatLaneFreshness } from "../../services/workLanes";
export function memberTitle(member: WorkLaneMember) {
  return member.title || member.spec_id;
}
export function memberEstimate(member: WorkLaneMember) {
  const e = member.estimate;
  return e ? `${e.p25}–${e.p75}h${e.provisional ? " · provisional" : ""}` : "—";
}
export function memberAcceptance(member: WorkLaneMember) {
  return member.ac_checked != null && member.ac_total != null
    ? `${member.ac_checked}/${member.ac_total}`
    : "—";
}
export function ObservationMarker({ member }: { member: WorkLaneMember }) {
  const o = member.observation;
  if (!o || o.quality === "fresh") return null;
  const color = o.quality === "stale" ? p.amber : p.red;
  return (
    <View
      style={{
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: `${color}66`,
        borderRadius: 4,
        paddingHorizontal: 9,
        paddingVertical: 7,
        gap: 4,
      }}
    >
      <Text style={{ ...mono, color, fontSize: 10.5 }}>
        {o.quality.toUpperCase()} · observed{" "}
        {o.observed_at ? laneTime(o.observed_at) : "unknown"}
      </Text>
      {o.error ? (
        <Text style={{ ...mono, color, fontSize: 11 }}>{o.error}</Text>
      ) : null}
    </View>
  );
}
export function LaneMemberSummary({ member }: { member: WorkLaneMember }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={label}>
        {(member.status || "unknown").replace(/_/g, " ").toUpperCase()}
      </Text>
      <Text style={{ ...body, color: p.text, fontFamily: Fonts.rajdhani.bold }}>
        {memberTitle(member)}
      </Text>
      <Text style={mono}>
        AC {memberAcceptance(member)} · est. {memberEstimate(member)}
      </Text>
      {member.status_text ? (
        <Text style={body}>{member.status_text}</Text>
      ) : null}
      {member.next_action_text ? (
        <Text style={body}>Next · {member.next_action_text}</Text>
      ) : null}
      <ObservationMarker member={member} />
    </View>
  );
}
export function MemberContent({
  member,
  inline = false,
}: {
  member: WorkLaneMember;
  inline?: boolean;
}) {
  const terminal =
    member.terminal ||
    ["completed", "deprecated"].includes(member.status || "");
  return (
    <View
      testID={`member-detail-${member.spec_id}`}
      style={{ gap: inline ? 6 : 10 }}
    >
      {!inline ? (
        <>
          <View style={{ flexDirection: "row", gap: 7, alignItems: "center" }}>
            <SpecGlyph member={member} />
            <Text style={{ ...label, fontSize: 9.5 }}>
              {(member.status || "unknown").replace(/_/g, " ").toUpperCase()}
            </Text>
            <Text
              accessibilityLabel={`Spec ${member.spec_id}, observed ${member.observation?.observed_at || "unknown"}`}
              style={mono}
            >
              · {member.spec_id}
            </Text>
          </View>
          <Text
            style={{
              ...body,
              fontSize: 19,
              fontFamily: Fonts.rajdhani.bold,
              color: p.text,
            }}
          >
            {memberTitle(member)}
          </Text>
        </>
      ) : null}
      <ObservationMarker member={member} />
      {member.status_text ? (
        <Text style={{ ...body, fontSize: inline ? 13.5 : 14, lineHeight: 20 }}>
          {member.status_text}
        </Text>
      ) : null}
      {!terminal && member.next_action_text ? (
        <Text style={{ ...body, color: p.text, lineHeight: 20 }}>
          <Text style={{ ...label, fontSize: 9.5 }}>NEXT </Text>
          {member.next_action_text}
        </Text>
      ) : null}
      {inline ? (
        <Text style={{ ...mono, fontSize: 9.5 }}>
          {member.spec_id}
          {member.estimate ? ` · EST ${memberEstimate(member)}` : ""} · SEEN{" "}
          {member.observation?.observed_at
            ? laneTime(member.observation.observed_at)
            : "unknown"}
        </Text>
      ) : (
        <View
          style={{
            flexDirection: "row",
            gap: 10,
            borderTopWidth: 1,
            borderColor: p.line,
            paddingTop: 10,
          }}
        >
          {[
            ["ACCEPTANCE", memberAcceptance(member)],
            [
              "ESTIMATE",
              member.estimate
                ? `${member.estimate.p25}–${member.estimate.p75}h`
                : "—",
            ],
            [
              "CHANGED",
              member.source_changed_at
                ? Number.isFinite(Date.parse(member.source_changed_at))
                  ? formatLaneFreshness(member.source_changed_at, Date.now())
                  : member.source_changed_at
                : "unknown",
            ],
          ].map(([key, value]) => (
            <View key={key} style={{ flex: 1 }}>
              <Text style={{ ...mono, fontSize: 8.5, letterSpacing: 1.2 }}>
                {key}
              </Text>
              <Text
                accessibilityLabel={
                  key === "CHANGED"
                    ? `CHANGED, source ${member.source_changed_at || "unknown"}`
                    : undefined
                }
                style={{
                  ...mono,
                  fontFamily: Fonts.jetBrainsMono.bold,
                  color: p.text,
                  fontSize: 14,
                  marginTop: 3,
                }}
              >
                {value}
              </Text>
              {key === "ESTIMATE" && member.estimate ? (
                <Text style={{ ...mono, fontSize: 8.5, marginTop: 2 }}>
                  median {member.estimate.median}h
                  {member.estimate.provisional ? " · provisional" : ""}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
export default function LaneMemberDetail({
  member,
  laneTitle,
  onBack,
  bottom = 18,
}: {
  member: WorkLaneMember;
  laneTitle: string;
  onBack(): void;
  bottom?: number;
}) {
  return (
    <View style={{ gap: 10, paddingBottom: bottom }}>
      <Pressable
        testID="member-detail-back"
        accessibilityRole="button"
        accessibilityLabel={`Back to ${laneTitle}`}
        onPress={onBack}
        style={{
          flexDirection: "row",
          gap: 4,
          alignItems: "center",
          minHeight: 30,
        }}
      >
        <Icon kind="back" size={13} />
        <Text style={{ ...body, fontFamily: Fonts.rajdhani.bold }}>
          {laneTitle}
        </Text>
      </Pressable>
      <MemberContent member={member} />
    </View>
  );
}
