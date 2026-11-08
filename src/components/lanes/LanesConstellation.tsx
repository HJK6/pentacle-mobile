import React from "react";
import { Animated, Pressable, Text, View } from "react-native";
import Svg, { Ellipse } from "react-native-svg";
import type { WorkLane, WorkLaneMember } from "pentacle-chat-core";
import { Fonts, type MachineSigilKind } from "@/constants/Colors";
import MachineSigil from "../MachineSigil";
import LaneIcon from "./LaneIcon";
import { mono, p, ProgressRing, SpecGlyph } from "./LaneAtoms";
import {
  innerRingPoints,
  outerRingPoints,
  type RingPoint,
} from "./lanesRingLayout";

export type ConstellationNode = {
  id: string;
  title: string;
  state: string;
  color: string;
  fraction: number;
  lane?: WorkLane;
  member?: WorkLaneMember;
  fold?: string;
  working?: boolean;
  labelled?: boolean;
  onPress(): void;
};
type Motion = { phase: Animated.Value; moving: boolean };
function Spoke({
  point,
  cx,
  cy,
  color,
  working,
  motion,
}: {
  point: RingPoint;
  cx: number;
  cy: number;
  color: string;
  working?: boolean;
  motion: Motion;
}) {
  const length = Math.hypot(cx - point.x, cy - point.y),
    angle = Math.atan2(cy - point.y, cx - point.x);
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: point.x,
        top: point.y,
        width: 0,
        height: 0,
        transform: [{ rotate: `${angle}rad` }],
      }}
    >
      <View
        style={{
          position: "absolute",
          top: -1,
          width: length,
          height: 2,
          overflow: "hidden",
        }}
      >
        {working ? (
          <Animated.View
            style={{
              flexDirection: "row",
              gap: 6,
              width: length + 24,
              height: 1.5,
              transform: [
                {
                  translateX: motion.moving
                    ? motion.phase.interpolate({
                        inputRange: [0, 1],
                        outputRange: [-12, 0],
                      })
                    : 0,
                },
              ],
            }}
          >
            {Array.from({ length: Math.ceil(length / 12) + 2 }, (_, i) => (
              <View
                key={i}
                style={{ width: 6, height: 1.5, backgroundColor: color }}
              />
            ))}
          </Animated.View>
        ) : (
          <View style={{ height: 1, backgroundColor: color, opacity: 0.4 }} />
        )}
      </View>
    </View>
  );
}
function Node({
  node,
  point,
  selected,
  dim,
  motion,
  outer,
}: {
  node: ConstellationNode;
  point: RingPoint;
  selected: boolean;
  dim: boolean;
  motion: Motion;
  outer: boolean;
}) {
  const size = outer ? 27 : 48;
  return (
    <View
      style={{
        position: "absolute",
        left: point.x - size / 2,
        top: point.y - size / 2,
        width: size,
        opacity: dim ? 0.3 : 1,
      }}
    >
      <Pressable
        testID={
          node.member
            ? `spec-node-${node.id}`
            : node.fold
              ? `lanes-map-fold-${node.id}`
              : `lanes-map-lane-${node.id}`
        }
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={`${node.title}, ${node.state}`}
        onPress={node.onPress}
        hitSlop={outer ? 6 : 2}
        style={{
          width: size,
          height: size,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: p.ink,
          borderRadius: size / 2,
        }}
      >
        <ProgressRing size={size} fraction={node.fraction} color={node.color} />
        {node.working && motion.moving ? (
          <Animated.View
            testID={`working-pulse-${node.id}`}
            pointerEvents="none"
            style={{
              position: "absolute",
              width: size,
              height: size,
              borderWidth: 1,
              borderColor: node.color,
              borderRadius: size,
              opacity: motion.phase.interpolate({
                inputRange: [0, 1],
                outputRange: [0.6, 0],
              }),
              transform: [
                {
                  scale: motion.phase.interpolate({
                    inputRange: [0, 1],
                    outputRange: [1, 1.5],
                  }),
                },
              ],
            }}
          />
        ) : null}
        {node.lane ? (
          <LaneIcon
            lane={node.lane}
            size={size * 0.5}
            color={outer ? p.dim : p.text}
          />
        ) : node.member ? (
          <SpecGlyph member={node.member} size={outer ? 11 : 18} />
        ) : (
          <Text
            style={{ ...mono, fontSize: outer ? 9 : 12, color: node.color }}
          >
            {node.fold}
          </Text>
        )}
      </Pressable>
      {node.labelled ? (
        <View
          testID={
            node.member ? `spec-label-${node.id}` : `lanes-map-label-${node.id}`
          }
          collapsable={false}
          accessible
          accessibilityRole="text"
          accessibilityLabel={`${node.title}, ${node.state}`}
          style={{
            position: "absolute",
            left: size / 2 - 53,
            top: size + 5,
            width: 106,
            height: 34,
            alignItems: "center",
          }}
        >
          <Text
            accessible={false}
            numberOfLines={1}
            style={{
              color: p.text,
              fontFamily: Fonts.rajdhani.bold,
              fontSize: 12.5,
              lineHeight: 15,
              maxWidth: 106,
            }}
          >
            {node.title}
          </Text>
          <Text
            accessible={false}
            numberOfLines={1}
            style={{
              ...mono,
              color: node.color,
              fontSize: 8,
              lineHeight: 13,
              letterSpacing: 0.8,
              maxWidth: 106,
            }}
          >
            {node.state}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
export default function LanesConstellation({
  width,
  height,
  inner,
  outer,
  selectedId,
  centreLane,
  assistantName,
  assistantSigil = "djinni",
  centreFraction = 0,
  motion,
  lampWorking,
}: {
  width: number;
  height: number;
  inner: ConstellationNode[];
  outer: ConstellationNode[];
  selectedId?: string | null;
  centreLane?: WorkLane;
  assistantName: string;
  assistantSigil?: MachineSigilKind;
  centreFraction?: number;
  motion: Motion;
  lampWorking: boolean;
}) {
  const selectedIndex = Math.max(
    0,
    inner.findIndex((node) => node.id === selectedId),
  );
  const points = innerRingPoints(inner.length, width, height, selectedIndex),
    outerPoints = outerRingPoints(outer.length, width, height);
  const cx = width / 2,
    cy = height / 2 - 14;
  const radius = points.length
    ? Math.hypot(points[0].x - cx, points[0].y - cy)
    : Math.min(width, height) / 3;
  return (
    <View testID="lanes-constellation" style={{ width, height }}>
      <Svg
        pointerEvents="none"
        width={width}
        height={height}
        style={{ position: "absolute" }}
      >
        <Ellipse
          cx={cx}
          cy={cy}
          rx={radius}
          ry={radius}
          stroke={`${p.green}33`}
          strokeWidth={1}
          strokeDasharray="2 3"
          fill="none"
        />
        <Ellipse
          cx={cx}
          cy={cy}
          rx={Math.max(24, width / 2 - 22)}
          ry={Math.max(24, height / 2 - 24)}
          stroke={`${p.green}22`}
          strokeWidth={1}
          strokeDasharray="2 3"
          fill="none"
        />
      </Svg>
      {inner.map((node, i) => (
        <Spoke
          key={node.id}
          point={points[i]}
          cx={cx}
          cy={cy}
          color={node.color}
          working={node.working}
          motion={motion}
        />
      ))}
      {outer.map((node, i) => (
        <Node
          key={node.id}
          node={node}
          point={outerPoints[i]}
          selected={node.id === selectedId}
          dim={!!selectedId && node.id !== selectedId}
          motion={motion}
          outer
        />
      ))}
      {inner.map((node, i) => (
        <Node
          key={node.id}
          node={node}
          point={points[i]}
          selected={node.id === selectedId}
          dim={!!selectedId && node.id !== selectedId}
          motion={motion}
          outer={false}
        />
      ))}
      <Animated.View
        testID={
          centreLane
            ? `lane-zoom-centre-${centreLane.lane_id}`
            : "lanes-map-assistant"
        }
        accessibilityLabel={centreLane?.title ?? assistantName}
        style={{
          position: "absolute",
          left: cx - 34,
          top: cy - 34,
          width: 68,
          height: 68,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 34,
          borderWidth: 1,
          borderColor: p.green,
          backgroundColor: p.ink,
          transform: [
            {
              scale:
                lampWorking && motion.moving
                  ? motion.phase.interpolate({
                      inputRange: [0, 0.5, 1],
                      outputRange: [1, 1.06, 1],
                    })
                  : 1,
            },
          ],
        }}
      >
        {centreLane ? (
          <>
            <ProgressRing size={68} fraction={centreFraction} color={p.green} />
            <LaneIcon lane={centreLane} size={34} />
          </>
        ) : (
          <MachineSigil kind={assistantSigil} size={39} color={p.green} />
        )}
      </Animated.View>
    </View>
  );
}
