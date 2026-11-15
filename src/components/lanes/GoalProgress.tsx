import React from 'react';
import Svg, { Circle } from 'react-native-svg';
import { readableLeadGoals, type WorkLane } from 'pentacle-chat-core';

/** The lead goals' progress arcs, outer ring first; `rings={1}` draws only the first (lanes on the outer map circle). */
export function GoalRings({ lane, size, color, rings = 2 }: { lane: WorkLane; size: number; color: string; rings?: 1 | 2 }) {
  return (
    <Svg pointerEvents="none" width={size} height={size} viewBox="0 0 100 100"
      style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
      {[44, 35].slice(0, rings).map((radius, i) => <Circle key={`track-${radius}`} cx={50} cy={50} r={radius} fill="none" stroke={color} strokeWidth={i ? 3.5 : 5} opacity={0.14} />)}
      {readableLeadGoals(lane).slice(0, rings).map(({ goal }, i) => {
        const radius = i ? 35 : 44, circumference = 2 * Math.PI * radius;
        return <React.Fragment key={goal.goal_id || 'default'}>
          <Circle cx={50} cy={50} r={radius} fill="none" stroke={color}
            strokeWidth={i ? 3.5 : 5} opacity={i ? 0.14 : 0.22} />
          <Circle testID={`lane-goal-arc-${lane.lane_id}-${i + 1}`} cx={50} cy={50} r={radius}
            fill="none" stroke={color} strokeWidth={i ? 3.5 : 5} opacity={i ? 0.6 : 1}
            strokeLinecap="round" strokeDasharray={`${Math.max(0, Math.min(1, (goal.total ? goal.done / goal.total : 0))) * circumference} ${circumference}`} />
        </React.Fragment>;
      })}
    </Svg>
  );
}
