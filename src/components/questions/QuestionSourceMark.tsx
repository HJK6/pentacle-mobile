import React from 'react';
import { View } from 'react-native';
import SourceMark from './SourceMark';
import LaneIcon from '../lanes/LaneIcon';
import { questionSourceLane } from './questionSourceLane';
import { usePentacleStreamSelector } from '../../services/pentacleStream';

export default function QuestionSourceMark({ streamId, ...fallback }: React.ComponentProps<typeof SourceMark> & { streamId: string }) {
  const lane = usePentacleStreamSelector((state) => questionSourceLane(state, streamId));
  if (typeof lane === 'string') return <SourceMark {...fallback} />;
  const size = fallback.size ?? 32;
  return <View testID="questions-lane-source-mark" style={{ width: size, height: size, borderRadius: size / 2,
    borderWidth: 1.5, borderColor: fallback.accent, alignItems: 'center', justifyContent: 'center' }}>
    <LaneIcon lane={lane} size={Math.round(size * 0.58)} color={fallback.accent} />
  </View>;
}
