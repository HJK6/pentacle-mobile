import { NativeModules } from 'react-native';

// Process resident set size (RSS) in bytes, or null when the runtime exposes no
// resident-memory bridge. The unsigned iOS-simulator harness build ships no
// such native module, so this returns null there — which the bucket_cost_sample
// contract explicitly allows ("process RSS in bytes, or null where
// unsupported"). Never returns 0: an unavailable reading is null so downstream
// peak-RSS extraction ignores it rather than flooring the peak at zero. The
// `PentacleMemory` probe is the seam for a future native resident-memory bridge.
export function readProcessRssBytes(): number | null {
  const native = (NativeModules as Record<string, unknown> | undefined)?.PentacleMemory as
    | { residentSizeBytes?: number | (() => number) }
    | undefined;
  const raw = native?.residentSizeBytes;
  const value = typeof raw === 'function' ? raw() : raw;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}
