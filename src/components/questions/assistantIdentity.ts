import type { MachineSigilKind } from '../../../constants/Colors';

// How the overlay names and marks the assistant (operator requirement R-ident: never a literal
// name). The single local stand-in until shared edit S7 lands `selectAssistantIdentity(state)`
// (docs/bart_home_contracts.md v1.6); swap this constant for that selector then.
export type AssistantIdentity = { name: string; hostId: string | null; sigilKind: MachineSigilKind };

export const ASSISTANT_IDENTITY: AssistantIdentity = { name: 'Assistant', hostId: null, sigilKind: 'djinni' };
