import React from 'react';
import type { PentacleStreamState } from 'pentacle-chat-core';
import { MACHINES } from '@/constants/Colors';
import { getHostMachineName } from '../../config/local';
import { usePentacleStreamSelectorWhen } from '../../services/pentacleStream';
import { BART_STREAM_ID } from '../status/statusSelectors';
import MachineSigil from '../MachineSigil';

export type AssistantIdentity = {
  assistantName: string;
  icon: { host: string; kind: 'djinni'; color: string };
};
let cached: AssistantIdentity | undefined;

// Single adapter point for the future shared identity selector. Follow the
// existing assistant display-name precedence; the glyph keeps its identity
// override while its accent comes from the session's configured host skin.
export function selectLocalAssistantIdentity(state: PentacleStreamState): AssistantIdentity {
  const session = state.sessions.find((item) => item.stream_id === BART_STREAM_ID);
  const assistantName = session?.display_name?.trim() || session?.title?.trim() || 'Assistant';
  const host = session?.host || BART_STREAM_ID.split(':')[0];
  const color = MACHINES[getHostMachineName(host)].accent;
  if (cached?.assistantName === assistantName && cached.icon.host === host && cached.icon.color === color) return cached;
  cached = { assistantName, icon: { host, kind: 'djinni', color } };
  return cached;
}

export function useAssistantIdentity() {
  return usePentacleStreamSelectorWhen(true, selectLocalAssistantIdentity);
}

export function AssistantIcon({ identity, size, color }: { identity: AssistantIdentity; size: number; color?: string }) {
  return <MachineSigil kind={identity.icon.kind} size={size} color={color ?? identity.icon.color} />;
}
