import type { PentacleStreamState } from 'pentacle-chat-core';
import { usePentacleStreamSelectorWhen } from './pentacleStream';

// The protected assistant's thread. The id is protocol, not a display name: what the
// operator sees comes from selectAssistantIdentity.
export const ASSISTANT_STREAM_ID = 'bart:assistant';
export const DEFAULT_ASSISTANT_NAME = 'Assistant';

export type AssistantIdentity = {
  streamId: string;
  // The operator's name for their assistant (Pentacle web: the protected assistant
  // session's displayName, default 'Assistant'). Never a hard-coded product name.
  name: string;
  // The assistant session's host; its machine sigil is drawn with sigilKind.
  hostId: string | null;
  sigilKind: 'djinni';
};

let lastIdentity: AssistantIdentity | undefined;

// Returns the previous object while the identity is unchanged, so memoized consumers that
// receive it as a prop (the home header) do not re-render on unrelated store changes.
export function selectAssistantIdentity(state: Pick<PentacleStreamState, 'sessions'>): AssistantIdentity {
  const session = state.sessions.find((item) => item.stream_id === ASSISTANT_STREAM_ID);
  const name = [session?.display_name, session?.title].map((value) => String(value || '').trim()).find(Boolean)
    || DEFAULT_ASSISTANT_NAME;
  const next: AssistantIdentity = { streamId: ASSISTANT_STREAM_ID, name, hostId: session?.host || null, sigilKind: 'djinni' };
  if (lastIdentity && sameAssistantIdentity(lastIdentity, next)) return lastIdentity;
  lastIdentity = next;
  return next;
}

export function sameAssistantIdentity(a: AssistantIdentity, b: AssistantIdentity) {
  return a.streamId === b.streamId && a.name === b.name && a.hostId === b.hostId && a.sigilKind === b.sigilKind;
}

export function useAssistantIdentity(): AssistantIdentity {
  return usePentacleStreamSelectorWhen(true, selectAssistantIdentity, sameAssistantIdentity);
}
