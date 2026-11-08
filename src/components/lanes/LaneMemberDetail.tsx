import HeaderVoiceMic from '../voice/HeaderVoiceMic';
import React from "react";
import { Pressable, Text, View } from "react-native";
import type { LaneCardViewModel } from "../../services/workLanes";
import type { WorkLaneMember } from "pentacle-chat-core";
import { Fonts } from "@/constants/Colors";
import { body, Icon, label, mono, p, SpecGlyph, laneTime } from "./LaneAtoms";
import { formatLaneFreshness, specDetailModel } from "../../services/workLanes";
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
/** Seat lines for the spec's assigned seats, e.g. "LEAD · working · hosta". Activity is never progress. */
export function memberSeatLines(member: WorkLaneMember): string[] {
  const seats = member.seats ?? [];
  const lines = seats.map((seat) =>
    [(seat.role || "seat").toUpperCase(), seat.activity, seat.host].filter(Boolean).join(" · "));
  const hidden = (member.seats_total ?? seats.length) - seats.length;
  return hidden > 0 ? [...lines, `+${hidden} more`] : lines;
}
export function memberWaitingOnYou(member: WorkLaneMember): string | null {
  const count = member.open_questions?.count ?? 0;
  return count > 0 ? `WAITING ON YOU (${count})` : null;
}
export function MemberAttribution({ member }: { member: WorkLaneMember }) {
  const lines = memberSeatLines(member);
  const waiting = memberWaitingOnYou(member);
  if (!lines.length && !waiting) return null;
  return (
    <View testID={`member-attribution-${member.spec_id}`} style={{ gap: 3 }}>
      {waiting ? <Text style={{ ...mono, color: p.amber, fontSize: 10.5 }}>{waiting}</Text> : null}
      {lines.map((line, i) => (
        <Text key={`${i}:${line}`} style={{ ...mono, fontSize: 10.5 }}>{line}</Text>
      ))}
    </View>
  );
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
  model,
}: {
  member: WorkLaneMember;
  inline?: boolean;
  model?: LaneCardViewModel;
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
            <SpecGlyph member={member} model={model} />
            <Text style={{ ...label, fontSize: 9.5, color: member.status === "missing" ? p.red : label.color }}>
              {(member.status || "unknown").replace(/_/g, " ").toUpperCase()}
            </Text>
            <Text
              accessibilityLabel={`Spec ${member.spec_id}, observed ${member.observation?.observed_at || "unknown"}`}
              style={mono}
            >
              · {member.spec_id}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Text
            numberOfLines={1}
            style={{
              ...body,
              flexShrink: 1,
              fontSize: 19,
              fontFamily: Fonts.rajdhani.bold,
              color: p.text,
            }}
          >
            {memberTitle(member)}
          </Text><HeaderVoiceMic /></View>
        </>
      ) : null}
      <ObservationMarker member={member} />
      <MemberAttribution member={member} />
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
  model,
}: {
  member: WorkLaneMember;
  laneTitle: string;
  onBack(): void;
  bottom?: number;
  model?: LaneCardViewModel;
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
      <StructuredMemberContent member={member} model={model} />
    </View>
  );
}

function DetailField({
  name,
  children,
  id,
}: {
  name: string;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <View testID={id} style={{ gap: 5 }}>
      <Text style={label}>{name}</Text>
      {children}
    </View>
  );
}
export function AcceptanceBar({
  checked,
  total,
  color = p.green,
}: {
  checked?: number | null;
  total?: number | null;
  color?: string;
}) {
  const fraction = total ? Math.max(0, Math.min(1, (checked ?? 0) / total)) : 0;
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: total ?? 0, now: checked ?? 0 }}
      style={{
        height: 5,
        backgroundColor: p.line,
        borderRadius: 3,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          height: "100%",
          width: `${fraction * 100}%`,
          backgroundColor: color,
        }}
      />
    </View>
  );
}
/** Detail field order follows approved frames; absent observations never become invented values. */
export function StructuredMemberContent({
  member,
  model,
}: {
  member: WorkLaneMember;
  model?: LaneCardViewModel;
}) {
  const detail = specDetailModel(member),
    worked = member.worked,
    lead = member.lead_seat;
  return (
    <View testID={`member-detail-${member.spec_id}`} style={{ gap: 16 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          flexWrap: "wrap",
        }}
      >
        <SpecGlyph member={member} model={model} />
        <Text style={label}>
          {(member.status ?? "unknown").replace(/_/g, " ").toUpperCase()}
        </Text>
        {detail.since ? (
          <Text testID="member-since" style={mono}>
            · {detail.since}
          </Text>
        ) : null}
        {member.source_changed_at ? (
          <Text testID="member-changed" style={mono}>
            · changed{" "}
            {formatLaneFreshness(member.source_changed_at, Date.now())}
          </Text>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <Text
          style={{
            ...body,
            flex: 1,
            fontFamily: Fonts.rajdhani.bold,
            fontSize: 21,
            lineHeight: 25,
            color: p.text,
          }}
        >
          {memberTitle(member)}
        </Text>
        <HeaderVoiceMic />
      </View>
      {member.transitions?.length ? (
        <Text testID="member-lifecycle" style={{ ...mono, lineHeight: 17 }}>
          {member.transitions
            .map((t) => `${t.status.replace(/_/g, " ").toUpperCase()} ${t.at}`)
            .join(" › ")}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: 12 }}>
        {member.ac_checked != null && member.ac_total != null ? (
          <View testID="member-acceptance" style={{ flex: 1, gap: 4 }}>
            <Text style={mono}>ACCEPTANCE</Text>
            <Text
              style={{
                ...body,
                color: p.text,
                fontSize: 24,
                fontFamily: Fonts.rajdhani.bold,
              }}
            >
              {memberAcceptance(member)}
            </Text>
          </View>
        ) : null}
        {member.estimate ? (
          <View testID="member-estimate" style={{ flex: 1, gap: 4 }}>
            <Text style={mono}>ESTIMATE</Text>
            <Text
              style={{
                ...body,
                color: p.text,
                fontSize: 24,
                fontFamily: Fonts.rajdhani.bold,
              }}
            >
              {member.estimate.p25}–{member.estimate.p75}h
            </Text>
            <Text style={{ ...mono, lineHeight: 15 }}>
              median {member.estimate.median}h
              {member.estimate.provisional ? " · provisional" : ""}
            </Text>
          </View>
        ) : null}
        {worked ? (
          <View testID="member-worked" style={{ flex: 1, gap: 4 }}>
            <Text style={mono}>WORKED</Text>
            {worked.elapsed_h != null ? (
              <Text
                style={{
                  ...body,
                  color: p.text,
                  fontSize: 24,
                  fontFamily: Fonts.rajdhani.bold,
                }}
              >
                {worked.elapsed_h}h{worked.censored ? "+" : ""}
              </Text>
            ) : null}
            <Text style={{ ...mono, lineHeight: 15 }}>
              {worked.active_h != null ? `${worked.active_h}h active · ` : ""}
              {worked.seats} seats · {worked.qa_rounds} QA
            </Text>
          </View>
        ) : null}
      </View>
      {member.ac_checked != null && member.ac_total != null ? (
        <AcceptanceBar
          checked={member.ac_checked}
          total={member.ac_total}
          color={member.status === "blocked" ? p.amber : p.green}
        />
      ) : null}
      {lead ? (
        <View
          testID="member-lead"
          style={{
            padding: 12,
            borderWidth: 1,
            borderColor: p.line,
            borderRadius: 9,
            gap: 5,
          }}
        >
          <Text
            style={{ ...body, color: p.text, fontFamily: Fonts.rajdhani.bold }}
          >
            Lead · {lead.host}
            {lead.provider ? ` · ${lead.provider}` : ""}
          </Text>
          <Text style={{ ...mono, lineHeight: 17 }}>
            {lead.activity.toUpperCase()}
            {lead.eta_at ? ` · ETA ${laneTime(lead.eta_at)}` : ""}
            {lead.active_step ? ` · ${lead.active_step}` : ""}
          </Text>
        </View>
      ) : null}
      {(member.open_questions?.count ?? 0) > 0 ? (
        <View
          testID="member-open-questions"
          style={{
            padding: 12,
            borderWidth: 1,
            borderColor: `${p.amber}88`,
            borderRadius: 9,
          }}
        >
          <Text style={{ ...body, color: p.amber }}>
            ? {member.open_questions!.count} open{" "}
            {member.open_questions!.count === 1 ? "question" : "questions"}
          </Text>
        </View>
      ) : null}
      {detail.status ? (
        <DetailField name="STATUS" id="member-status">
          <Text
            style={{ ...body, color: p.text, fontSize: 16, lineHeight: 23 }}
          >
            {detail.status}
          </Text>
        </DetailField>
      ) : null}
      {detail.next ? (
        <DetailField name="NEXT" id="member-next">
          <Text
            style={{ ...body, color: p.text, fontSize: 16, lineHeight: 23 }}
          >
            {detail.next}
          </Text>
        </DetailField>
      ) : null}
      {detail.criteria.length ? (
        <DetailField
          name={`ACCEPTANCE · ${detail.criteria.filter((c) => c.disposition === "open").length} OPEN · ${detail.criteria.filter((c) => c.disposition === "done").length} DONE`}
          id="member-criteria"
        >
          {detail.criteria.map((criterion, index) => (
            <View
              key={`${index}:${criterion.title}`}
              testID={`member-criterion-${index}`}
              style={{
                flexDirection: "row",
                gap: 9,
                paddingVertical: 9,
                borderBottomWidth: 1,
                borderColor: p.line,
              }}
            >
              <Text
                style={{
                  ...body,
                  color: criterion.disposition === "done" ? p.green : p.dim,
                }}
              >
                {criterion.disposition === "done" ? "✓" : "○"}
              </Text>
              <Text
                style={{
                  ...body,
                  flex: 1,
                  color: criterion.disposition === "done" ? p.dim : p.text,
                }}
              >
                {criterion.title}
              </Text>
              {criterion.disposition !== "open" &&
              criterion.disposition !== "done" ? (
                <Text style={mono}>{criterion.disposition}</Text>
              ) : null}
            </View>
          ))}
        </DetailField>
      ) : null}
      <ObservationMarker member={member} />
    </View>
  );
}
