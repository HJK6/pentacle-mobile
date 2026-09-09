import { usePentacleStreamSelectorWhen } from '../services/pentacleStream';
import {
  INITIAL_PENTACLE_LIMITS,
  type PentacleLimit,
  type PentacleLimitsHealth,
} from 'pentacle-chat-core';

export default function useLimits(enabled = true): PentacleLimit[] {
  return usePentacleStreamSelectorWhen(
    enabled,
    (state) => state.limits ?? INITIAL_PENTACLE_LIMITS,
    Object.is,
  );
}

export function useLimitsHealth(enabled = true): PentacleLimitsHealth | null {
  return usePentacleStreamSelectorWhen(
    enabled,
    (state) => state.limitsHealth ?? null,
    Object.is,
  );
}
