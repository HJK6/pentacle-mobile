import { useCallback, useEffect, useRef } from "react";
import type { WorkLaneShow } from "pentacle-chat-core";
import type { LaneCardViewModel } from "../../services/workLanes";
import { requestWorkLaneShow } from "../../services/pentacleStream";
import { useWorkLaneShow, type ReadWorkLaneShow } from "./useWorkLaneShow";
// Share in-flight reads and completed results across mounted cards and sheets.
// The update identity invalidates the cache; this does not introduce polling.
type CachedRead = {
  promise: Promise<WorkLaneShow>;
  consumers: Set<() => boolean>;
  started: boolean;
};
const readers = new WeakMap<ReadWorkLaneShow, Map<string, CachedRead>>();
let active = 0;
const pending: (() => void)[] = [];
function boundedRead(read: () => Promise<WorkLaneShow>): Promise<WorkLaneShow> {
  return new Promise((resolve, reject) => {
    const run = () => {
      active++;
      Promise.resolve()
        .then(read)
        .then(resolve, reject)
        .finally(() => {
          active--;
          pending.shift()?.();
        });
    };
    if (active < 4) run();
    else pending.push(run);
  });
}
export function useLastLaneUpdate(
  model: LaneCardViewModel,
  connected: boolean,
  readShow: ReadWorkLaneShow = requestWorkLaneShow,
) {
  const id = model.lane.last_update?.update_id;
  const current = useRef<string | null>(null);
  const mounted = useRef(true);
  current.current = connected && id ? `${model.lane.lane_id}:${id}` : null;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const eligible = useCallback(
    () => mounted.current && current.current === `${model.lane.lane_id}:${id}`,
    [model.lane.lane_id, id],
  );
  useEffect(
    () => () => {
      readers
        .get(readShow)
        ?.get(`${model.lane.lane_id}:${id}`)
        ?.consumers.delete(eligible);
    },
    [readShow, model.lane.lane_id, id, eligible],
  );
  const read = useCallback(
    (laneId: string) => {
      let cache = readers.get(readShow);
      if (!cache) {
        cache = new Map();
        readers.set(readShow, cache);
      }
      const key = `${laneId}:${id}`;
      let entry = cache.get(key);
      if (!entry) {
        for (const old of cache.keys())
          if (old.startsWith(`${laneId}:`) && old !== key) cache.delete(old);
        const fresh: CachedRead = {
          promise: null!,
          consumers: new Set([eligible]),
          started: false,
        };
        fresh.promise = boundedRead(() => {
          if (![...fresh.consumers].some((canRead) => canRead())) {
            // A cancelled queued read made no request; a later mounted consumer may read it.
            if (cache?.get(key) === fresh) cache.delete(key);
            throw new Error("Read superseded");
          }
          fresh.started = true;
          return readShow(laneId);
        });
        cache.set(key, fresh);
        entry = fresh;
      } else if (!entry.started) entry.consumers.add(eligible);
      // Cache failures as well: only a new update identity authorizes another request.
      return entry.promise;
    },
    [id, readShow, eligible],
  );
  const { data } = useWorkLaneShow(model.lane.lane_id, connected, !!id, read);
  return {
    text:
      data?.updates.find((update) => update.update_id === id)?.summary ||
      model.lastUpdateText,
    count: data?.updates.length,
  };
}
