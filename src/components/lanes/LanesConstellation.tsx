import React, { useRef } from "react";
import { Animated, Pressable, Text, View, type GestureResponderEvent } from "react-native";
import Svg, { Circle, Ellipse } from "react-native-svg";
import type { WorkLane } from "pentacle-chat-core";
import { Fonts, type MachineSigilKind } from "@/constants/Colors";
import MachineSigil from "../MachineSigil";
import LaneIcon from "./LaneIcon";
import { Bang, mono, p } from "./LaneAtoms";
import { GoalRings } from './GoalProgress';
import { mapLayout, type MapPoint } from "./lanesRingLayout";

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
function Label({ id, title, state, width, quiet, many, green }: { id: string; title: string; state: string; width: number; quiet: boolean; many: boolean; green: boolean }) {
  return (
    <View testID={`lanes-map-label-${id}`} collapsable={false} accessible accessibilityRole="text" accessibilityLabel={`${title}, ${state}`}
      style={{ width, height: quiet ? 28 : 32, alignItems: "center" }}>
      <Text accessible={false} numberOfLines={1} style={{ maxWidth: width, color: quiet ? p.muted : p.text, backgroundColor: p.ink, paddingHorizontal: 5, borderRadius: 4,
        fontFamily: quiet ? Fonts.rajdhani.medium : Fonts.rajdhani.bold, fontSize: quiet ? 12 : many ? 13 : 14, lineHeight: quiet ? 13 : many ? 15 : 16 }}>{title}</Text>
      {state ? <Text accessible={false} numberOfLines={1} style={{ ...mono, maxWidth: width, color: green ? p.green : quiet ? p.faint : p.muted, backgroundColor: p.ink,
        paddingHorizontal: 5, borderRadius: 4, fontSize: quiet ? 8 : 9, lineHeight: 13 }}>{state}</Text> : null}
    </View>
  );
}
function Node({ node, point, size, quiet, many }: { node: ConstellationNode; point: MapPoint; size: number; quiet: boolean; many: boolean }) {
  const width = quiet ? (many ? 84 : 92) : many ? 98 : 124, ring = useRef<View>(null);
  return (
    <View style={{ position: "absolute", left: point.x - width / 2, top: point.y - size / 2, width, alignItems: "center" }}>
      <Pressable testID={`lanes-map-lane-${node.id}`} accessibilityRole="button" accessibilityLabel={`${node.title}, ${node.state}`}
        ref={ring} onPress={e => node.onPress(e, ring)} hitSlop={quiet ? 7 : 2}
        style={{ width: size, height: size, borderRadius: size / 2, alignItems: "center", justifyContent: "center", backgroundColor: p.ink }}>
        {quiet ? <View pointerEvents="none" style={{ position: 'absolute', width: size, height: size, borderRadius: size / 2, borderWidth: 1, borderColor: `${p.muted}55` }} />
          : <GoalRings lane={node.lane} size={size} color={p.green} />}
        <LaneIcon lane={node.lane} size={size * (quiet ? 0.5 : 0.42)} color={quiet ? p.muted : p.text} />
        {node.question ? <View testID={`lane-needs-you-${node.id}`} style={{ position: 'absolute', right: -5, top: -4 }}>
          <Bang question color={p.yellow} size={15} filled /></View> : null}
      </Pressable>
      <View style={{ marginTop: quiet ? 3 : 5 }}>
        <Label id={node.id} title={node.title} state={node.state} width={width} quiet={quiet} many={many} green={node.kind === 'working'} />
      </View>
    </View>
  );
}
/** The map: working and in-progress lanes on the inner ring, quiet lanes at the corners, the hub in the centre. */
export default function LanesConstellation({ width, inner, outer, more, assistantName, assistantSigil = "djinni", motion }: {
  width: number; inner: ConstellationNode[]; outer: ConstellationNode[]; more: number; assistantName: string; assistantSigil?: MachineSigilKind; motion: Motion;
}) {
  const layout = mapLayout(inner.length, outer.length, width);
  const { cx, cy, radius, size, hub, height, many } = layout;
  return (
    <View testID="lanes-constellation" style={{ width, height }}>
      <Svg pointerEvents="none" width={width} height={height} style={{ position: "absolute" }}>
        <Circle cx={cx} cy={cy} r={radius} stroke={p.green} strokeOpacity={0.16} strokeWidth={1} strokeDasharray="2 4" fill="none" />
        <Ellipse cx={cx} cy={cy} rx={158} ry={164} stroke={p.green} strokeOpacity={0.09} strokeWidth={1} strokeDasharray="2 4" fill="none" />
      </Svg>
      {inner.map((node, i) => <Link key={node.id} id={node.id} from={layout.links[i].from} to={layout.links[i].to} kind={node.kind} motion={motion} />)}
      <View accessible accessibilityRole="image" testID="lanes-map-assistant" accessibilityLabel={assistantName}
        style={{ position: "absolute", left: cx - hub / 2, top: cy - hub / 2, width: hub, height: hub, borderRadius: hub / 2, borderWidth: 1.5,
          borderColor: `${p.green}bf`, backgroundColor: '#0a120e', alignItems: "center", justifyContent: "center",
          shadowColor: p.green, shadowOpacity: 0.12, shadowRadius: 7, shadowOffset: { width: 0, height: 0 } }}>
        <MachineSigil kind={assistantSigil} size={hub * 0.6} color={p.green} />
      </View>
      {inner.map((node, i) => <Node key={node.id} node={node} point={layout.inner[i]} size={size} quiet={false} many={many} />)}
      {outer.map((node, i) => <Node key={node.id} node={node} point={layout.outer[i]} size={30} quiet many={many} />)}
      {more > 0 ? <Text testID="lanes-map-more" style={{ ...mono, position: "absolute", right: 14, bottom: 8 }}>+{more}</Text> : null}
    </View>
  );
}
