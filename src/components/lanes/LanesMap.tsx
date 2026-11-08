import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import type { WorkLaneMember } from "pentacle-chat-core";
import { Fonts, type MachineSigilKind } from "@/constants/Colors";
import { useVoiceSurface } from "../../services/voicePresentation";
import {
  formatLaneFreshness,
  formatWorkLaneEstimate,
  laneFlowGroup,
  laneFlowRank,
  laneNeedsYou,
  laneOrbits,
  lanePausedAge,
  laneRingOrder,
  laneWorking,
  laneRowMeta,
  laneRowDetail,
  memberHasLiveSeat,
  specGroups,
  type LaneCardViewModel,
  type LaneUpdateEntry,
} from "../../services/workLanes";
import {
  body,
  Icon,
  label,
  LaneMark,
  LeafLoading,
  LeafText,
  mono,
  p,
  SpecGlyph,
} from "./LaneAtoms";
import LaneMemberDetail, {
  AcceptanceBar,
  memberAcceptance,
  memberTitle,
} from "./LaneMemberDetail";
import LanesConstellation, {
  type ConstellationNode,
} from "./LanesConstellation";
import LanesSheet, { type SheetSnap } from "./LanesSheet";
import { useWorkingMotion } from "./useWorkingMotion";
import { useWorkLaneShow, type ReadWorkLaneShow } from "./useWorkLaneShow";
import { useLaneMembers } from "./useLaneMembers";
import { emitHarnessUiTrace, traceMemberList } from "./lanesTelemetry";
import { LatestUpdate } from "./LatestUpdate";
import { GoalBar } from './GoalProgress';

type Props = {
  active?: boolean;
  voiceBottom?: number;
  voiceTop?: number;
  bottom?: number;
  lanes: LaneCardViewModel[];
  assistantName: string;
  assistantSigil?: MachineSigilKind;
  focusedLaneId: string | null;
  onFocusLane(id: string | null): void;
  page?: number;
  onPageChange?(page: number): void;
  onOpenMember(model: LaneCardViewModel, member: WorkLaneMember): void;
  onShowAll?(model: LaneCardViewModel): void;
  onLog(model: LaneCardViewModel): void;
  onChat(model: LaneCardViewModel): void;
  updates?: LaneUpdateEntry[];
  onAllUpdates?(): void;
  connected?: boolean;
  readShow?: ReadWorkLaneShow;
  onBackHandler?(handler: () => void): void;
  onSnapChange?(snap: SheetSnap): void;
};
export const laneAttentionRank = (model: LaneCardViewModel) =>
  laneFlowRank(model.lane);
export function groupMapMembers(members: WorkLaneMember[]) {
  const g = specGroups(members);
  return {
    active: g.inProgress,
    pending: [...g.ready, ...g.backlog, ...g.other],
    done: g.done,
  };
}
function LaneRow({
  model,
  onPress,
}: {
  model: LaneCardViewModel;
  onPress(): void;
}) {
  const meta = laneRowMeta(model.lane), detail = laneRowDetail(model);
  return (
    <Pressable
      testID={`lane-row-${model.lane.lane_id}`}
      accessibilityRole="button"
      accessibilityLabel={`Open ${model.lane.title}, ${laneNeedsYou(model.lane) ? 'NEEDS YOU' : model.stateLabel}`}
      onPress={onPress}
      style={{
        flexDirection: "row",
        gap: 11,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderColor: p.line,
        alignItems: "center",
      }}
    >
      <LaneMark model={model} size={31} />
      <View style={{ flex: 1, gap: 5 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          <Text
            numberOfLines={1}
            style={{
              ...body,
              color: p.text,
              fontFamily: Fonts.rajdhani.bold,
              fontSize: 16,
              flex: 1,
            }}
          >
            {model.lane.title}
          </Text>
          <View style={{ flexDirection: 'row', flexShrink: 1, maxWidth: '58%', alignItems: 'baseline', gap: 4 }}>
            {meta.title ? <Text numberOfLines={1} style={{ ...mono, flexShrink: 1 }}>{meta.title}</Text> : null}
            <Text style={{ ...mono, fontFamily: Fonts.jetBrainsMono.bold, flexShrink: 0 }}>{meta.count}</Text>
          </View>
        </View>
        <Text numberOfLines={1} style={{ ...mono, color: p[detail.tone] }}>{detail.text}</Text>
        <GoalBar lane={model.lane} />
      </View>
    </Pressable>
  );
}
function SpecRow({
  member,
  model,
  onPress,
}: {
  member: WorkLaneMember;
  model: LaneCardViewModel;
  onPress(): void;
}) {
  return (
    <Pressable
      testID={`spec-row-${member.spec_id}`}
      accessibilityRole="button"
      accessibilityLabel={`Open ${memberTitle(member)}`}
      onPress={onPress}
      style={{
        paddingVertical: 11,
        gap: 7,
        borderBottomWidth: 1,
        borderColor: p.line,
      }}
    >
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <SpecGlyph member={member} model={model} />
        <Text
          numberOfLines={1}
          style={{
            ...body,
            flex: 1,
            color: p.text,
            fontFamily: Fonts.rajdhani.bold,
            fontSize: 15,
          }}
        >
          {memberTitle(member)}
        </Text>
        <Text style={mono}>{memberAcceptance(member)}</Text>
      </View>
      <Text
        style={{
          ...mono,
          color:
            member.status === "blocked"
              ? p.amber
              : member.status === "completed"
                ? p.dim
                : p.green,
        }}
      >
        {(member.status ?? "unknown").replace(/_/g, " ").toUpperCase()}
      </Text>
      {member.ac_checked != null && member.ac_total != null ? (
        <AcceptanceBar
          checked={member.ac_checked}
          total={member.ac_total}
          color={
            member.status === "blocked"
              ? p.amber
              : member.status === "completed"
                ? p.muted
                : p.green
          }
        />
      ) : null}
    </Pressable>
  );
}

export default function LanesMap({
  active = true,
  voiceBottom = 24,
  voiceTop = 72,
  bottom = 18,
  lanes,
  assistantName,
  assistantSigil,
  focusedLaneId,
  onFocusLane,
  onOpenMember,
  onLog,
  onChat,
  updates = [],
  onAllUpdates,
  connected = true,
  readShow,
  onBackHandler,
  onSnapChange,
}: Props) {
  const dimensions = useWindowDimensions();
  const [bounds, setBounds] = useState({
    width: dimensions.width,
    height: Math.max(400, dimensions.height - 100),
  });
  const [snap, setSnap] = useState<SheetSnap>("peek");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedSnapshot = useRef<WorkLaneMember | null>(null);
  const [dormantOpen, setDormantOpen] = useState(false),
    [doneOpen, setDoneOpen] = useState(false);
  const [outerFocus, setOuterFocus] = useState<string | null>(null);
  const overview = useRef({ snap: "peek" as SheetSnap, offset: 0 }),
    lanePosition = useRef({ snap: "peek" as SheetSnap, offset: 0 });
  const scroll = useRef<ScrollView>(null),
    offset = useRef(0),
    restoreOffset = useRef<number | null>(null);
  const focused = lanes.find((model) => model.lane.lane_id === focusedLaneId);
  const revision = focused?.lane.detail_revision ?? JSON.stringify([
    focused?.lane.version,
    focused?.members.map((m) => [
      m.spec_id,
      m.obs_rev,
      m.source_changed_at,
      m.status,
      m.ac_checked,
      m.ac_total,
    ]),
  ]);
  const show = useWorkLaneShow(
    focusedLaneId ?? "",
    connected,
    !!focused,
    readShow,
    revision,
  );
  const laneData = show.data?.lane_id === focusedLaneId ? show.data : null;
  const observedMembers = useLaneMembers(focused?.members ?? [], laneData);
  const members = focused?.lane.no_spec_reason ? [] : observedMembers;
  const groups = useMemo(() => specGroups(members), [members]);
  const currentSelection = members.find(
    (member) => member.spec_id === selectedId,
  );
  const previousSelection =
    selectedSnapshot.current?.spec_id === selectedId
      ? selectedSnapshot.current
      : undefined;
  const selected = selectedId
    ? currentSelection
      ? currentSelection
      : previousSelection
    : undefined;
  const now = Date.now(),
    orbits = laneOrbits(
      lanes.map((model) => model.lane),
      now,
    );
  const ordered = laneRingOrder(lanes.map((model) => model.lane)).map(
    (lane) => lanes.find((m) => m.lane.lane_id === lane.lane_id)!,
  );
  const changeSnap = useCallback(
    (value: SheetSnap) => {
      setSnap(value);
      onSnapChange?.(value);
    },
    [onSnapChange],
  );
  const openLane = (model: LaneCardViewModel) => {
    overview.current = { snap, offset: offset.current };
    offset.current = 0;
    setSelectedId(null);
    setDoneOpen(false);
    setOuterFocus(null);
    changeSnap("peek");
    onFocusLane(model.lane.lane_id);
  };
  const selectSpec = (member: WorkLaneMember) => {
    if (!focused) return;
    if (!selectedId) lanePosition.current = { snap, offset: offset.current };
    offset.current = 0;
    selectedSnapshot.current = member;
    setSelectedId(member.spec_id);
    onOpenMember(focused, member);
  };
  const back = useCallback(() => {
    if (selectedId) {
      setSelectedId(null);
      changeSnap(lanePosition.current.snap);
      restoreOffset.current = lanePosition.current.offset;
    } else if (focusedLaneId) {
      onFocusLane(null);
      setOuterFocus(null);
      changeSnap(overview.current.snap);
      restoreOffset.current = overview.current.offset;
    }
  }, [selectedId, focusedLaneId, onFocusLane, changeSnap]);
  useEffect(() => {
    onBackHandler?.(back);
  }, [back, onBackHandler]);
  useEffect(() => {
    if (focusedLaneId && !focused) {
      onFocusLane(null);
      setSelectedId(null);
      changeSnap(overview.current.snap);
      restoreOffset.current = overview.current.offset;
    }
  }, [focusedLaneId, focused, onFocusLane, changeSnap]);
  useEffect(() => {
    if (
      selectedId &&
      laneData &&
      show.complete &&
      !laneData.members.some((member) => member.spec_id === selectedId)
    )
      setSelectedId(null);
  }, [selectedId, laneData, show.complete]);
  useEffect(() => {
    if (restoreOffset.current !== null) {
      offset.current = restoreOffset.current;
      scroll.current?.scrollTo({ y: restoreOffset.current, animated: false });
      restoreOffset.current = null;
    }
  }, [focusedLaneId, selectedId]);
  useEffect(() => {
    if (focused && show.data && show.complete) traceMemberList(focused.lane.lane_id, members);
  }, [focused?.lane.lane_id, show.data, show.complete, members]);
  useEffect(() => {
    emitHarnessUiTrace("work_lanes_view", {
      view: selected ? "member_detail" : focused ? "lane_zoom" : "map",
      lane_id: focused?.lane.lane_id,
      spec_id: selected?.spec_id,
      snap,
    });
  }, [focused?.lane.lane_id, selected?.spec_id, snap]);
  useVoiceSurface(
    {
      page_id: selected ? "spec" : focused ? "lane" : "lanes",
      title: selected
        ? memberTitle(selected)
        : focused?.lane.title || "Work lanes",
      ...(focused
        ? { entity_id: selected?.spec_id || focused.lane.lane_id }
        : {}),
    },
    active,
    { priority: 1.5, bottom: voiceBottom, top: voiceTop },
  );
  const specWorking = (m: WorkLaneMember) =>
    groups.inProgress.some((row) => row.spec_id === m.spec_id) &&
    memberHasLiveSeat(m);
  const working = focused
    ? members.some(specWorking)
    : lanes.some((m) => laneWorking(m.lane));
  const motion = useWorkingMotion(active, working);
  const laneNode = (
    model: LaneCardViewModel,
    labelled: boolean,
  ): ConstellationNode => ({
    id: model.lane.lane_id,
    title: model.lane.title,
    state:
      laneNeedsYou(model.lane) && model.lane.state !== "blocked"
        ? "NEEDS YOU"
        : model.stateLabel,
    color:
      model.lane.state === "blocked" || laneNeedsYou(model.lane)
        ? p.amber
        : p[model.stateTone],
    fraction: 0,
    lane: model.lane,
    working: laneWorking(model.lane) && !laneNeedsYou(model.lane),
    labelled,
    onPress: () => {
      if (!labelled) setOuterFocus(model.lane.lane_id);
      openLane(model);
    },
  });
  const specNode = (
    member: WorkLaneMember,
    labelled: boolean,
  ): ConstellationNode => ({
    id: member.spec_id,
    title: memberTitle(member),
    state: `${(member.status ?? "unknown").replace(/_/g, " ").toUpperCase()} · ${memberAcceptance(member)}`,
    color:
      member.status === "blocked"
        ? p.amber
        : ["backlog", "ready_for_dev", "analysis"].includes(member.status ?? "")
          ? p.muted
          : p.green,
    fraction: member.ac_total
      ? (member.ac_checked ?? 0) / member.ac_total
      : member.status === "completed"
        ? 1
        : 0,
    member,
    working: specWorking(member),
    labelled,
    onPress: () => selectSpec(member),
  });
  let inner: ConstellationNode[], outer: ConstellationNode[];
  if (focused) {
    const live = groups.inProgress.slice(0, 6);
    if (selected && !live.some((m) => m.spec_id === selected.spec_id)) {
      if (live.length === 6) live.pop();
      live.push(selected);
    }
    inner = live.map((m) => specNode(m, true));
    outer = [
      ...groups.inProgress,
      ...groups.ready,
      ...groups.backlog,
      ...groups.other,
    ]
      .filter((m) => !live.some((row) => row.spec_id === m.spec_id))
      .map((m) => specNode(m, false));
    if (groups.done.length)
      outer.push({
        id: "done",
        title: `✓${groups.done.length}${show.complete ? '' : ' loaded'}`,
        state: "DONE",
        color: p.muted,
        fraction: 0,
        fold: `✓${groups.done.length}${show.complete ? '' : '+'}`,
        onPress: () => {
          setSelectedId(null);
          setDoneOpen((v) => !v);
          changeSnap("full");
        },
      });
  } else {
    inner = orbits.inner.map((l) =>
      laneNode(lanes.find((m) => m.lane.lane_id === l.lane_id)!, true),
    );
    outer = [...orbits.overflow, ...orbits.paused].map((l) =>
      laneNode(
        lanes.find((m) => m.lane.lane_id === l.lane_id)!,
        l.lane_id === outerFocus,
      ),
    );
    if (orbits.dormant.length)
      outer.push({
        id: "dormant",
        title: `+${orbits.dormant.length}`,
        state: "PAUSED",
        color: p.muted,
        fraction: 0,
        fold: `+${orbits.dormant.length}`,
        onPress: () => {
          setDormantOpen((v) => !v);
          changeSnap("full");
        },
      });
  }
  const incomplete = !show.loading &&
    !!focused &&
    !!laneData && (!show.complete || laneData.members.length !==
      (laneData.members_total ?? laneData.projection?.members_total ?? focused.membersTotal));
  const error =
    show.error ?? (incomplete ? "Incomplete member list. Please retry." : null);
  const latest = selected
    ? laneData?.updates
        .filter((u) => u.spec_id === selected.spec_id)
        .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0]
    : null;
  return (
    <View
      testID={focused ? `lane-zoom-${focused.lane.lane_id}` : "lanes-map"}
      style={{ flex: 1, overflow: "hidden" }}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        if (width > 0 && height > 0) setBounds({ width, height });
      }}
    >
      <View
        style={{ opacity: snap === "full" ? 0 : 1 }}
        pointerEvents={snap === "full" ? "none" : "auto"}
        accessibilityElementsHidden={snap === "full"}
        importantForAccessibility={
          snap === "full" ? "no-hide-descendants" : "auto"
        }
      >
        <LanesConstellation
          width={bounds.width}
          height={bounds.height * 0.6 - 28}
          inner={inner}
          outer={outer}
          selectedId={selectedId}
          centreLane={focused?.lane}
          assistantName={assistantName}
          assistantSigil={assistantSigil}
          centreFraction={
            focused?.lane.ac_total
              ? (focused.lane.ac_checked ?? 0) / focused.lane.ac_total
              : 0
          }
          motion={motion}
          lampWorking={working}
        />
        <Text
          testID="lanes-map-counts"
          numberOfLines={1}
          style={{
            ...mono,
            textAlign: "center",
            letterSpacing: 0.7,
            fontSize: 9,
            marginTop: 2,
          }}
        >
          {focused
            ? `${show.complete ? '' : 'LOADED · '}${groups.inProgress.length} IN PROGRESS   ${groups.ready.length} READY   ${groups.backlog.length} BACKLOG   ✓ ${groups.done.length}`
            : `${lanes.filter((m) => m.lane.state === "active").length} ACTIVE   ! ${lanes.filter((m) => m.lane.state === "blocked").length} BLOCKED   || ${lanes.filter((m) => m.lane.state === "paused").length} PAUSED`}
        </Text>
      </View>
      <LanesSheet height={bounds.height} snap={snap} onSnap={changeSnap}>
        <ScrollView
          ref={scroll}
          key={`${focusedLaneId ?? "overview"}:${selectedId ?? "list"}`}
          testID="lanes-sheet-scroll"
          scrollEventThrottle={16}
          contentOffset={{ x: 0, y: restoreOffset.current ?? offset.current }}
          onScroll={(event) => {
            offset.current = event.nativeEvent.contentOffset.y;
          }}
          onContentSizeChange={() => {
            if (restoreOffset.current !== null)
              scroll.current?.scrollTo({
                y: restoreOffset.current,
                animated: false,
              });
          }}
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingBottom: Math.max(28, bottom),
            gap: 12,
          }}
        >
          {focused ? (
            <>
              {show.loading ? (
                <LeafLoading
                  id="lanes-map-members-loading"
                  text="Loading specs"
                />
              ) : null}
              {error ? (
                <View style={{ gap: 6 }}>
                  <LeafText
                    id="lanes-map-members-error"
                    text={error}
                    style={{ ...body, color: p.amber }}
                  />
                  <Pressable
                    testID="lanes-map-members-retry"
                    onPress={show.retry}
                    accessibilityRole="button"
                  >
                    <Text style={label}>Retry</Text>
                  </Pressable>
                </View>
              ) : null}
              {selected ? (
                <>
                  <LaneMemberDetail
                    member={selected}
                    model={focused}
                    laneTitle={focused.lane.title}
                    onBack={back}
                    bottom={0}
                  />
                  {latest ? (
                    <Pressable
                      testID="member-log"
                      onPress={() => onLog(focused)}
                      accessibilityRole="button"
                    >
                      <Text style={mono}>
                        LOG · {latest.summary || latest.kind}
                      </Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    testID="member-open-chat"
                    accessibilityRole="button"
                    disabled={focused.tap.action === "unavailable"}
                    onPress={() => onChat(focused)}
                    style={{
                      backgroundColor: p.green,
                      padding: 14,
                      borderRadius: 9,
                      opacity: focused.tap.action === "unavailable" ? 0.4 : 1,
                    }}
                  >
                    <Text
                      style={{
                        ...body,
                        textAlign: "center",
                        color: p.ink,
                        fontFamily: Fonts.rajdhani.bold,
                      }}
                    >
                      {focused.tap.action === "unavailable"
                        ? "Chat unavailable"
                        : `Open ${focused.leadHost ?? focused.lane.visible_chat.stream_id.split(":")[0]} chat`}
                    </Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <View testID="lane-acceptance" style={{ gap: 9 }}>
                    <View
                      style={{ flexDirection: "row", alignItems: "baseline" }}
                    >
                      <Text style={{ ...label, flex: 1 }}>Acceptance</Text>
                      <Text style={mono}>
                        {focused.lane.ac_checked ?? "—"}/
                        {focused.lane.ac_total ?? "—"}
                        {focused.lane.ac_total &&
                        focused.lane.ac_checked != null
                          ? ` · ${Math.round((focused.lane.ac_checked / focused.lane.ac_total) * 100)}%`
                          : ""}
                      </Text>
                    </View>
                    <AcceptanceBar
                      checked={focused.lane.ac_checked}
                      total={focused.lane.ac_total}
                    />
                    <Text style={mono}>
                      {focused.lane.items_completed ?? "—"}/
                      {focused.lane.items_total ??
                        focused.lane.members_total ??
                        "—"}{" "}
                      DONE · {groups.inProgress.length} IN PROGRESS · EST{" "}
                      {formatWorkLaneEstimate(
                        focused.lane.open_estimate_h,
                        focused.lane.estimate_complete !== false,
                      )}
                    </Text>
                  </View>
                  {(["inProgress", "ready", "backlog", "other"] as const).map(
                    (key) =>
                      groups[key].length ? (
                        <View key={key}>
                          <Text style={label}>
                            {key === "inProgress"
                              ? "In progress"
                              : key === "other"
                                ? "Unknown"
                                : key}{" "}
                            · {groups[key].length}{show.complete ? '' : ' loaded'}
                          </Text>
                          {groups[key].map((member) => (
                            <SpecRow
                              key={member.spec_id}
                              member={member}
                              model={focused}
                              onPress={() => selectSpec(member)}
                            />
                          ))}
                        </View>
                      ) : null,
                  )}
                  {groups.done.length ? (
                    <View>
                      <Text style={label}>Done · {groups.done.length}{show.complete ? '' : ' loaded'}</Text>
                      <Pressable
                        testID="spec-done-fold"
                        accessibilityRole="button"
                        accessibilityState={{ expanded: doneOpen }}
                        onPress={() => setDoneOpen((v) => !v)}
                        style={{ paddingVertical: 12 }}
                      >
                        <Text style={body}>✓{groups.done.length}{show.complete ? '' : ' loaded'}</Text>
                      </Pressable>
                      {doneOpen
                        ? groups.done.map((member) => (
                            <SpecRow
                              key={member.spec_id}
                              member={member}
                              model={focused}
                              onPress={() => selectSpec(member)}
                            />
                          ))
                        : null}
                    </View>
                  ) : null}
                  {focused.lane.no_spec_reason ? (
                    <Text style={body}>{focused.lane.no_spec_reason}</Text>
                  ) : null}
                  <Pressable
                    testID="lane-zoom-open-chat"
                    accessibilityRole="button"
                    disabled={focused.tap.action === "unavailable"}
                    onPress={() => onChat(focused)}
                    style={{
                      paddingVertical: 14,
                      opacity: focused.tap.action === "unavailable" ? 0.4 : 1,
                    }}
                  >
                    <Text
                      style={{ ...body, color: p.green, textAlign: "center" }}
                    >
                      {focused.tap.action === "unavailable"
                        ? "Chat unavailable"
                        : `Open ${focused.leadHost ?? focused.lane.visible_chat.stream_id.split(":")[0]} chat`}
                    </Text>
                  </Pressable>
                </>
              )}
            </>
          ) : (
            <>
              <LatestUpdate
                updates={updates}
                onPress={() => onAllUpdates?.()}
              />
              {(["needsYou", "working", "paused"] as const).map((group) => {
                const rows = ordered.filter(
                  (m) =>
                    laneFlowGroup(m.lane) === group &&
                    !orbits.dormant.includes(m.lane),
                );
                return rows.length ||
                  (group === "paused" && orbits.dormant.length) ? (
                  <View key={group} testID={`lanes-group-${group}`}>
                    <Text style={label}>
                      {group === "needsYou"
                        ? "Needs you"
                        : group === "working"
                          ? "Working"
                          : "Paused"}{" "}
                      · {rows.length}
                    </Text>
                    {rows.map((model) => (
                      <LaneRow
                        key={model.lane.lane_id}
                        model={model}
                        onPress={() => openLane(model)}
                      />
                    ))}
                    {group === "paused" && orbits.dormant.length ? (
                      <>
                        <Pressable
                          testID="lanes-dormant-fold"
                          accessibilityRole="button"
                          accessibilityState={{ expanded: dormantOpen }}
                          onPress={() => setDormantOpen((v) => !v)}
                          style={{
                            flexDirection: "row",
                            justifyContent: "space-between",
                            paddingVertical: 14,
                          }}
                        >
                          <Text style={body}>+{orbits.dormant.length}</Text>
                          <Text style={mono}>
                            {formatLaneFreshness(
                              new Date(
                                now -
                                  Math.max(
                                    ...orbits.dormant.map((l) =>
                                      lanePausedAge(l, now),
                                    ),
                                  ),
                              ).toISOString(),
                              now,
                            )}
                          </Text>
                        </Pressable>
                        {dormantOpen
                          ? orbits.dormant.map((l) => {
                              const m = lanes.find(
                                (m) => m.lane.lane_id === l.lane_id,
                              )!;
                              return (
                                <LaneRow
                                  key={l.lane_id}
                                  model={m}
                                  onPress={() => openLane(m)}
                                />
                              );
                            })
                          : null}
                      </>
                    ) : null}
                  </View>
                ) : null;
              })}
              {!lanes.length ? <Text style={body}>No open lanes</Text> : null}
            </>
          )}
        </ScrollView>
      </LanesSheet>
    </View>
  );
}
