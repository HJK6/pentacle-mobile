import React from 'react';
import { MACHINES } from '@/constants/Colors';
import { getHostMachineName } from '../../config/local';
import type { AssistantIdentity } from '../../services/assistantIdentity';
import MachineSigil from '../MachineSigil';

// Presentation of the shared assistant identity (src/services/assistantIdentity.ts): the sigil
// is the djinni drawn in the accent of the assistant's host.
export function assistantAccent(identity: AssistantIdentity) {
  return MACHINES[getHostMachineName(identity.hostId || identity.streamId.split(':')[0])].accent;
}

export function AssistantIcon({ identity, size, color }: { identity: AssistantIdentity; size: number; color?: string }) {
  return <MachineSigil kind={identity.sigilKind} size={size} color={color ?? assistantAccent(identity)} />;
}
