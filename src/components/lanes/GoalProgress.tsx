import React from 'react';
import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import type { WorkLane } from 'pentacle-chat-core';
import { laneGoalParts, laneTopGoals } from '../../services/workLanes';
import { p } from './LaneAtoms';

export function GoalRings({ lane, size, color }: { lane: WorkLane; size: number; color: string }) {
  return (
    <Svg pointerEvents="none" width={size} height={size} viewBox="0 0 100 100"
      style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
      {laneTopGoals(lane).map((goal, i) => {
        const radius = i ? 35 : 44, circumference = 2 * Math.PI * radius;
        return <React.Fragment key={goal.goalId ?? 'default'}>
          <Circle cx={50} cy={50} r={radius} fill="none" stroke={color}
            strokeWidth={i ? 3.5 : 5} opacity={i ? 0.14 : 0.22} />
          <Circle testID={`lane-goal-arc-${lane.lane_id}-${i + 1}`} cx={50} cy={50} r={radius}
            fill="none" stroke={color} strokeWidth={i ? 3.5 : 5} opacity={i ? 0.6 : 1}
            strokeLinecap="round" strokeDasharray={`${Math.max(0, Math.min(1, goal.fraction)) * circumference} ${circumference}`} />
        </React.Fragment>;
      })}
    </Svg>
  );
}

export function GoalBar({ lane }: { lane: WorkLane }) {
  return <View testID={`lane-goal-bar-${lane.lane_id}`} style={{ flexDirection: 'row', gap: 3, height: 4 }}>
    {laneGoalParts(lane).map((goal, i) => <View key={goal.goalId ?? 'default'}
      testID={`lane-goal-part-${lane.lane_id}-${i + 1}`}
      style={{ flex: 1, height: 4, backgroundColor: p.line, borderRadius: 2, overflow: 'hidden' }}>
      <View style={{ height: 4, width: `${Math.max(0, Math.min(1, goal.fraction)) * 100}%`, backgroundColor: p[goal.tone], borderRadius: 2 }} />
    </View>)}
  </View>;
}
