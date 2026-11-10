import React from 'react';
import type { WorkLanesInventory } from 'pentacle-chat-core';
import type { LaneCardViewModel, LaneUpdateEntry } from '../../services/workLanes';
import type { ReadWorkLaneShow } from './useWorkLaneShow';
import ReadableLanes from './ReadableLanes';

export default function LanesOverlay(props: {
  lanes: LaneCardViewModel[];
  inventory: WorkLanesInventory | null | undefined;
  assistantName: string;
  connected: boolean;
  updates: LaneUpdateEntry[];
  top: number;
  bottom: number;
  onChat(model: LaneCardViewModel): void;
  onClose(): void;
  readShow?: ReadWorkLaneShow;
  listVariant?: 'current' | 'bars' | 'compact';
  active?: boolean;
}) {
  return <ReadableLanes {...props} />;
}
