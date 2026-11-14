import React from "react";
import {
  ActivityIndicator,
  Text,
  View,
  type TextStyle,
} from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { Fonts, Tokens } from "@/constants/Colors";
import ArcaneRingFrame from "../ArcaneRingFrame";
import LaneIcon from './LaneIcon';
import type { WorkLane } from "pentacle-chat-core";
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
  lane,
  quiet = false,
  size = 32,
}: {
  lane: WorkLane;
  quiet?: boolean;
  size?: number;
}) {
  return (
    <ArcaneRingFrame size={size} color={quiet ? p.muted : p.green} identity>
      <LaneIcon lane={lane} size={size * .56} color={quiet ? p.muted : p.text} />
    </ArcaneRingFrame>
  );
}
export function Icon({
  kind,
  size = 16,
  color = p.dim,
}: {
  kind: "list" | "map" | "close" | "chevron" | "back" | "parked" | "spec";
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
                : kind === "parked"
                  ? "M8 20V4h5.5a4.5 4.5 0 0 1 0 9H8"
                  : kind === "spec"
                    ? "M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h6"
                    : "M9 6l6 6-6 6"
          }
        />
      )}
    </Svg>
  );
}
export function Bang({
  question = false,
  color = p.yellow,
  size = 12,
  filled = false,
}: {
  question?: boolean;
  color?: string;
  size?: number;
  filled?: boolean;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: filled ? 0 : 1.6,
        borderColor: color,
        backgroundColor: filled ? color : undefined,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        accessible={false}
        allowFontScaling={false}
        style={{
          ...mono,
          fontFamily: filled ? Fonts.rajdhani.bold : Fonts.jetBrainsMono.bold,
          color: filled ? "#1a1600" : color,
          fontSize: size * (filled ? 0.75 : 0.7),
          lineHeight: size * (filled ? 1 : 0.85),
        }}
      >
        {question ? "?" : "!"}
      </Text>
    </View>
  );
}
