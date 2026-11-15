import React, { useMemo, useRef } from "react";
import { Animated, Pressable, Text, View, type GestureResponderEvent } from "react-native";
import Svg, { Circle, Ellipse } from "react-native-svg";
import type { WorkLane } from "pentacle-chat-core";
import { Fonts, type MachineSigilKind } from "@/constants/Colors";
import MachineSigil from "../MachineSigil";
import LaneIcon from "./LaneIcon";
import { Bang, label, mono, p } from "./LaneAtoms";
import { GoalRings } from './GoalProgress';
import { INNER, OUTER, mapLayout, ringedMapLayout, type MapPoint } from "./lanesRingLayout";

export type ConstellationNode = {
  id: string;
  title: string;
  state: string;
  lane: WorkLane;
  /** working: moving dashes on the link; moving: solid link at half strength. */
  kind: 'working' | 'moving' | 'quiet';
  question?: boolean;
  /** The ring is handed back so the tapped icon can fly into the lane header. */
  onPress(event: GestureResponderEvent, ring: React.RefObject<View | null>): void;
};
type Motion = { phase: Animated.Value; moving: boolean };
/** A link from the hub's edge to the lane ring's edge; the end markers let the render check measure both ends. */
function Link({ id, from, to, kind, motion }: { id: string; from: MapPoint; to: MapPoint; kind: ConstellationNode['kind']; motion: Motion }) {
  const length = Math.hypot(to.x - from.x, to.y - from.y), angle = Math.atan2(to.y - from.y, to.x - from.x);
  const working = kind === 'working';
  return (
    <View testID={`lanes-map-link-${id}`} pointerEvents="none"
      style={{ position: "absolute", left: from.x, top: from.y, width: 0, height: 0, transform: [{ rotate: `${angle}rad` }] }}>
      <View style={{ position: "absolute", top: working ? -0.8 : -0.5, left: 0, width: length, height: working ? 1.6 : 1, overflow: "hidden" }}>
        {working ? (
          <Animated.View testID={motion.moving ? `working-spoke-${id}` : undefined}
            style={{ flexDirection: "row", gap: 6, width: length + 22, height: 1.6,
              transform: [{ translateX: motion.moving ? motion.phase.interpolate({ inputRange: [0, 1], outputRange: [-11, 0] }) : 0 }] }}>
            {Array.from({ length: Math.ceil(length / 11) + 2 }, (_, i) => <View key={i} style={{ width: 5, height: 1.6, backgroundColor: p.green }} />)}
          </Animated.View>
        ) : <View style={{ height: 1, backgroundColor: p.green, opacity: 0.5 }} />}
      </View>
      <View testID={`lanes-map-link-end-${id}`} style={{ position: "absolute", left: length, top: 0, width: 0, height: 0 }} />
    </View>
  );
}
/** A lane on the single-ring map: 52 point ring, name and age under it. */
function Node({ node, point, size }: { node: ConstellationNode; point: MapPoint; size: number }) {
  const width = 124, ring = useRef<View>(null);
  return (
    <View style={{ position: "absolute", left: point.x - width / 2, top: point.y - size / 2, width, alignItems: "center" }}>
      <Pressable testID={`lanes-map-lane-${node.id}`} accessibilityRole="button" accessibilityLabel={`${node.title}, ${node.state}`}
        ref={ring} onPress={e => node.onPress(e, ring)} hitSlop={2}
        style={{ width: size, height: size, borderRadius: size / 2, alignItems: "center", justifyContent: "center", backgroundColor: p.ink }}>
        <GoalRings lane={node.lane} size={size} color={p.green} />
        <LaneIcon lane={node.lane} size={size * 0.42} color={p.text} />
        {node.question ? <View testID={`lane-needs-you-${node.id}`} style={{ position: 'absolute', right: -5, top: -4 }}>
          <Bang question color={p.yellow} size={15} filled /></View> : null}
      </Pressable>
      <View style={{ marginTop: 5 }}>
        <View testID={`lanes-map-label-${node.id}`} collapsable={false} accessible accessibilityRole="text" accessibilityLabel={`${node.title}, ${node.state}`}
          style={{ width, height: 32, alignItems: "center" }}>
          <Text accessible={false} numberOfLines={1} style={{ maxWidth: width, color: p.text, backgroundColor: p.ink, paddingHorizontal: 5, borderRadius: 4,
            fontFamily: Fonts.rajdhani.bold, fontSize: 14, lineHeight: 16 }}>{node.title}</Text>
          {node.state ? <Text accessible={false} numberOfLines={1} style={{ ...mono, maxWidth: width, color: node.kind === 'working' ? p.green : p.muted, backgroundColor: p.ink,
            paddingHorizontal: 5, borderRadius: 4, fontSize: 9, lineHeight: 13 }}>{node.state}</Text> : null}
        </View>
      </View>
    </View>
  );
}
/** A lane on the two-circle map: inner lanes carry the name and age, outer lanes the name only (at most two lines). */
function RingedNode({ node, point, outer }: { node: ConstellationNode; point: MapPoint; outer: boolean }) {
  const quiet = node.kind === 'quiet', size = outer ? OUTER.size : INNER.size, width = outer ? OUTER.max : INNER.max, ring = useRef<View>(null);
  return (
    <View style={{ position: "absolute", left: point.x - width / 2, top: point.y - size / 2, width, alignItems: "center" }}>
      <Pressable testID={`lanes-map-lane-${node.id}`} accessibilityRole="button" accessibilityLabel={outer ? node.title : `${node.title}, ${node.state}`}
        ref={ring} onPress={e => node.onPress(e, ring)} hitSlop={4}
        style={{ width: size, height: size, borderRadius: size / 2, alignItems: "center", justifyContent: "center", backgroundColor: p.ink }}>
        {quiet ? <View pointerEvents="none" style={{ position: 'absolute', width: size, height: size, borderRadius: size / 2, borderWidth: 1, borderColor: `${p.muted}55` }} />
          : <GoalRings lane={node.lane} size={size} color={p.green} rings={outer ? 1 : 2} />}
        <LaneIcon lane={node.lane} size={size * (quiet ? 0.5 : 0.42)} color={quiet ? p.muted : p.text} />
        {node.question && !quiet ? <View testID={`lane-needs-you-${node.id}`} style={{ position: 'absolute', right: -5, top: -4 }}>
          <Bang question color={p.yellow} size={15} filled /></View> : null}
      </Pressable>
      <View testID={`lanes-map-label-${node.id}`} collapsable={false} pointerEvents="none" style={{ width, alignItems: "center", marginTop: outer ? OUTER.gap : INNER.gap }}>
        <Text accessible={false} numberOfLines={outer ? OUTER.lines : undefined} style={{ maxWidth: width, textAlign: "center", color: quiet ? p.muted : p.text,
          backgroundColor: p.ink, paddingHorizontal: outer ? 4 : 5, borderRadius: 4, fontFamily: Fonts.rajdhani.bold, fontSize: outer ? 12 : 13, lineHeight: outer ? OUTER.lh : INNER.lh }}>{node.title}</Text>
        {!outer && node.state ? <Text accessible={false} numberOfLines={1} style={{ ...mono, maxWidth: width, color: node.kind === 'working' ? p.green : p.muted, backgroundColor: p.ink,
          paddingHorizontal: 5, borderRadius: 4, fontSize: 9, lineHeight: INNER.mono }}>{node.state}</Text> : null}
      </View>
    </View>
  );
}
/** +N on the outer circle: busy lanes that did not fit in the active green, quiet lanes muted. */
function More({ point, count, busy, onPress }: { point: MapPoint; count: number; busy: boolean; onPress(): void }) {
  const size = OUTER.size, tone = busy ? p.green : p.muted;
  return (
    <Pressable testID={busy ? 'lanes-map-more-busy' : 'lanes-map-more'} accessibilityRole="button" accessibilityLabel={`${count} more lanes`} onPress={onPress} hitSlop={4}
      style={{ position: "absolute", left: point.x - size / 2, top: point.y - size / 2, width: size, height: size, borderRadius: size / 2,
        borderWidth: 1, borderStyle: "dashed", borderColor: tone, backgroundColor: p.ink, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ ...label, letterSpacing: 0, textTransform: "none", fontSize: 11, color: busy ? p.green : p.text }}>+{count}</Text>
    </Pressable>
  );
}
function Hub({ point, size, assistantName, assistantSigil }: { point: MapPoint; size: number; assistantName: string; assistantSigil: MachineSigilKind }) {
  return (
    <View accessible accessibilityRole="image" testID="lanes-map-assistant" accessibilityLabel={assistantName}
      style={{ position: "absolute", left: point.x - size / 2, top: point.y - size / 2, width: size, height: size, borderRadius: size / 2, borderWidth: 1.5,
        borderColor: `${p.green}bf`, backgroundColor: '#0a120e', alignItems: "center", justifyContent: "center",
        shadowColor: p.green, shadowOpacity: 0.12, shadowRadius: 7, shadowOffset: { width: 0, height: 0 } }}>
      <MachineSigil kind={assistantSigil} size={size * 0.6} color={p.green} />
    </View>
  );
}
/**
 * The map. Up to six busy lanes and nothing else: the approved single ring. Otherwise two circles round the hub: up to six busy
 * lanes inside, every other lane named on the outer circle as far as it fits, the rest counted in +N.
 */
export default function LanesConstellation({ width, inner, extra = [], quiet = [], assistantName, assistantSigil = "djinni", motion, onMore }: {
  width: number; inner: ConstellationNode[]; extra?: ConstellationNode[]; quiet?: ConstellationNode[]; assistantName: string; assistantSigil?: MachineSigilKind; motion: Motion;
  onMore?(laneIds: string[]): void;
}) {
  const single = !extra.length && !quiet.length && inner.length <= 6;
  const names = (nodes: ConstellationNode[]) => nodes.map(n => `${n.id}\u0000${n.title}`).join('\u0001');
  // The outer circle search is pure but not free, so it runs only when the lanes, their order or the width change.
  const ringed = useMemo(() => single ? null : ringedMapLayout(inner, extra, quiet, width),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [single, width, names(inner), names(extra), names(quiet)]);
  if (!ringed) {
    const { cx, cy, radius, size, hub, height, links, inner: points } = mapLayout(inner.length, width);
    return (
      <View testID="lanes-constellation" style={{ width, height }}>
        <Svg pointerEvents="none" width={width} height={height} style={{ position: "absolute" }}>
          <Circle cx={cx} cy={cy} r={radius} stroke={p.green} strokeOpacity={0.16} strokeWidth={1} strokeDasharray="2 4" fill="none" />
          <Ellipse cx={cx} cy={cy} rx={158} ry={164} stroke={p.green} strokeOpacity={0.09} strokeWidth={1} strokeDasharray="2 4" fill="none" />
        </Svg>
        {inner.map((node, i) => <Link key={node.id} id={node.id} from={links[i].from} to={links[i].to} kind={node.kind} motion={motion} />)}
        <Hub point={{ x: cx, y: cy }} size={hub} assistantName={assistantName} assistantSigil={assistantSigil} />
        {inner.map((node, i) => <Node key={node.id} node={node} point={points[i]} size={size} />)}
      </View>
    );
  }
  const { cx, cy, radius, hub, height, links, outerRadius } = ringed, byId = new Map([...extra, ...quiet].map(n => [n.id, n]));
  // A lane being worked on right now out on the circle keeps the moving dashes, as a short stub towards the hub.
  const stub = (x: number, y: number) => {
    const d = Math.hypot(cx - x, cy - y), ux = (cx - x) / d, uy = (cy - y) / d, e = OUTER.size / 2 + 2;
    return { from: { x: x + ux * (e + 14), y: y + uy * (e + 14) }, to: { x: x + ux * e, y: y + uy * e } };
  };
  return (
    <View testID="lanes-constellation" style={{ width, height }}>
      <Svg pointerEvents="none" width={width} height={height} style={{ position: "absolute" }}>
        <Circle cx={cx} cy={cy} r={radius} stroke={p.green} strokeOpacity={0.16} strokeWidth={1} strokeDasharray="2 4" fill="none" />
        {outerRadius ? <Circle testID="lanes-map-outer-circle" cx={cx} cy={cy} r={outerRadius} stroke={p.green} strokeOpacity={0.13} strokeWidth={1} strokeDasharray="2 4" fill="none" /> : null}
      </Svg>
      {inner.map((node, i) => <Link key={node.id} id={node.id} from={links[i].from} to={links[i].to} kind={node.kind} motion={motion} />)}
      {ringed.outer.map(o => {
        const node = o.kind === 'lane' ? byId.get(o.id) : undefined;
        return node?.kind === 'working' ? <Link key={`stub-${node.id}`} id={`stub-${node.id}`} {...stub(o.x, o.y)} kind="working" motion={motion} /> : null;
      })}
      <Hub point={{ x: cx, y: cy }} size={hub} assistantName={assistantName} assistantSigil={assistantSigil} />
      {inner.map((node, i) => <RingedNode key={node.id} node={node} point={ringed.inner[i]} outer={false} />)}
      {ringed.outer.map(o => {
        if (o.kind === 'more') return <More key={`more-${o.tone}`} point={o} count={o.ids.length} busy={o.tone === 'busy'} onPress={() => onMore?.(o.ids)} />;
        const node = byId.get(o.id);
        return node ? <RingedNode key={node.id} node={node} point={o} outer /> : null;
      })}
    </View>
  );
}
