import React from "react";
import { Text, View } from "react-native";
import Svg, { Path, Rect, Circle } from "react-native-svg";
import type { WorkLane, LaneIconKey } from "pentacle-chat-core";
import { resolveLaneIcon } from "../../services/workLanes";
import { Fonts, Tokens } from "@/constants/Colors";
const p = Tokens.palette;
// 24-unit approved design glyphs; the five additional contract keys use the same stroke grid.
const GLYPHS: Record<LaneIconKey, React.ReactNode> = {
  pentacle: (
    <>
      <Path d="M12 2.5l2.6 7.3h7.6l-6.1 4.5 2.3 7.4L12 17.2l-6.4 4.5 2.3-7.4-6.1-4.5h7.6z" />
    </>
  ),
  flask: (
    <>
      <Path d="M9 3h6M10 3v6l-5.5 9.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.5L14 9V3M7.5 15h9" />
    </>
  ),
  cube: (
    <>
      <Path d="M12 2.5l8.5 4.75v9.5L12 21.5l-8.5-4.75v-9.5zM12 12l8.5-4.75M12 12v9.5M12 12L3.5 7.25" />
    </>
  ),
  phone: (
    <>
      <Rect x="7" y="2.5" width="10" height="19" rx="2.2" />
      <Path d="M10.5 18.5h3" />
    </>
  ),
  bot: (
    <>
      <Rect x="4" y="8" width="16" height="12" rx="3" />
      <Path d="M12 8V4M9 4h6M8.5 14h.01M15.5 14h.01M9.5 17.5h5M1.5 13v3M22.5 13v3" />
    </>
  ),
  bug: (
    <>
      <Path d="M8.5 10.5a3.5 3.5 0 0 1 7 0v5a3.5 3.5 0 0 1-7 0zM3 13.5h5.5M15.5 13.5H21M5 8.5l3.5 2M19 8.5l-3.5 2M5 19.5l3.5-2.5M19 19.5l-3.5-2.5M10 7l-1.5-2.5M14 7l1.5-2.5" />
    </>
  ),
  truck: (
    <>
      <Path d="M1.5 6.5h12v10h-12zM13.5 10h4.5l3.5 3.5v3h-8z" />
      <Circle cx="5.5" cy="18" r="1.8" />
      <Circle cx="17.5" cy="18" r="1.8" />
    </>
  ),
  wrench: (
    <>
      <Path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </>
  ),
  columns: (
    <>
      <Path d="M3 21.5h18M4 10h16M12 3l9 7H3zM6.5 10v11.5M12 10v11.5M17.5 10v11.5" />
    </>
  ),
  rocket: (
    <>
      <Path d="M12 2.5c3 2.5 4.5 6 4.5 10.5l-2 2.5h-5l-2-2.5C7.5 8.5 9 5 12 2.5zM9.5 13l-3 1.5-1 4 3.5-1.5M14.5 13l3 1.5 1 4-3.5-1.5M10.5 17.5l1.5 4 1.5-4" />
      <Circle cx="12" cy="9.5" r="1.6" />
    </>
  ),
  hammer: (
    <>
      <Path d="M14 4l6 6-2.5 2.5-6-6zM11.5 6.5L3.5 14.5a1.6 1.6 0 0 0 0 2.2l1.8 1.8a1.6 1.6 0 0 0 2.2 0l8-8" />
    </>
  ),
  eye: (
    <>
      <Path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" />
      <Circle cx="12" cy="12" r="3" />
    </>
  ),
  camera: (
    <>
      <Path d="M3.5 8.5h3l1.5-2.5h8l1.5 2.5h3v11h-17z" />
      <Circle cx="12" cy="14" r="3.2" />
    </>
  ),
  cursor: (
    <>
      <Path d="M5 3.5l14 8-6 1.5-3.5 5.5z" />
    </>
  ),
  home: (
    <>
      <Path d="M3.5 11.5L12 4l8.5 7.5M6 10v10.5h12V10M10 20.5v-5h4v5" />
    </>
  ),
  book: (
    <>
      <Path d="M3 4h6a4 4 0 0 1 3 1.5A4 4 0 0 1 15 4h6v16h-6a4 4 0 0 0-3 1.5A4 4 0 0 0 9 20H3zM12 5.5v16" />
    </>
  ),
  chart: (
    <>
      <Path d="M3 3v18h18M6 16l5-5 4 2 6-8" />
    </>
  ),
  shield: (
    <>
      <Path d="M12 2.5l9 4v6c0 5-9 9-9 9s-9-4-9-9v-6zM8 12l3 3 5-6" />
    </>
  ),
  key: (
    <>
      <Circle cx="8" cy="8" r="5" />
      <Path d="M11.5 11.5L21 21M16 16l3-3M18 18l3-3" />
    </>
  ),
  leaf: (
    <>
      <Path d="M21 3S4 1 3 12c-1 10 12 12 16 3 2-5 2-12 2-12zM5 19L17 7" />
    </>
  ),
};
export default function LaneIcon({
  lane,
  size = 24,
  color = p.text,
}: {
  lane: Pick<WorkLane, "title" | "icon">;
  size?: number;
  color?: string;
}) {
  const icon = resolveLaneIcon(lane);
  return (
    <View
      testID={`lane-icon-${icon.key ?? "monogram"}`}
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {icon.key ? (
        <Svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={color}
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {GLYPHS[icon.key]}
        </Svg>
      ) : (
        <Text
          style={{
            fontFamily: Fonts.rajdhani.bold,
            fontSize: size * 0.56,
            color,
          }}
        >
          {icon.monogram}
        </Text>
      )}
    </View>
  );
}
