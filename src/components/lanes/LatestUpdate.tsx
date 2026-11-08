import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Fonts } from '@/constants/Colors';
import Bevel from '../Bevel';
import type { LaneUpdateEntry } from '../../services/workLanes';
import { body, Icon, label, laneTime, mono, p } from './LaneAtoms';
export function LatestUpdate({
  updates,
  onPress,
  map = false,
}: {
  updates: LaneUpdateEntry[];
  onPress(): void;
  map?: boolean;
}) {
  const latest = updates[0];
  return (
    <View style={{ gap: 8 }}>
      {!map ? (
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Text style={[label, { flex: 1 }]}>Latest update</Text>
          <Pressable
            testID="lanes-all-updates"
            accessibilityRole="button"
            accessibilityLabel="All updates"
            onPress={onPress}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 3,
              padding: 2,
            }}
          >
            <Text
              style={{
                ...body,
                fontSize: 13.5,
                fontFamily: Fonts.rajdhani.bold,
              }}
            >
              All updates · {updates.length}
            </Text>
            <Icon kind="chevron" size={13} />
          </Pressable>
        </View>
      ) : null}
      <Pressable
        testID="lanes-latest-update"
        accessibilityRole="button"
        accessibilityLabel="Open update log"
        onPress={onPress}
      >
        <Bevel
          cut={10}
          fill={`${p.green}0c`}
          stroke={`${p.green}33`}
          contentStyle={{ paddingHorizontal: 13, paddingVertical: 11, gap: 4 }}
        >
          <View style={{ flexDirection: "row", gap: 7, alignItems: "center" }}>
            <Text
              style={{
                ...mono,
                fontSize: 10,
                letterSpacing: 1,
                color: p.green,
                fontFamily: Fonts.jetBrainsMono.bold,
              }}
            >
              {map ? "LATEST · " : ""}
              {laneTime(latest?.update.ts)}
            </Text>
            <View
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: p.green,
              }}
            />
          </View>
          <Text
            style={{ ...body, color: p.text, fontSize: 14.5, lineHeight: 22 }}
          >
            {latest?.update.summary || "No updates yet"}
          </Text>
        </Bevel>
      </Pressable>
    </View>
  );
}
