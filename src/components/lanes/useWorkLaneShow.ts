import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkLaneShow } from 'pentacle-chat-core';
import { requestWorkLaneShow } from '../../services/pentacleStream';

export type ReadWorkLaneShow = (laneId: string) => Promise<WorkLaneShow>;

/** Each view owns its request epoch; replies after back/target/reconnect are ignored. */
export function useWorkLaneShow(laneId: string, connected: boolean, enabled = true, readShow: ReadWorkLaneShow = requestWorkLaneShow) {
  const epoch = useRef(0);
  const [data, setData] = useState<WorkLaneShow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const mine = ++epoch.current;
    setData(null);
    setError(null);
    if (!connected || !enabled) { setLoading(false); return; }
    setLoading(true);
    try {
      const result = await readShow(laneId);
      if (mine === epoch.current) setData(result);
    } catch (failure) {
      if (mine === epoch.current) {
        const message = failure instanceof Error ? failure.message : '';
        const code = (failure as { errorCode?: string } | null)?.errorCode;
        setError(code === 'timeout' || code === 'request_timeout' || /timed?\s*out|timeout/i.test(message) ? 'Request timed out' : 'Lane details unavailable');
      }
    } finally { if (mine === epoch.current) setLoading(false); }
  }, [laneId, connected, enabled, readShow]);
  useEffect(() => {
    void load();
    return () => { epoch.current += 1; };
  }, [load]);
  return { data, loading, error, retry: load };
}
