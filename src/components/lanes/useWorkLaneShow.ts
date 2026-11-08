import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkLaneShow, WorkLaneShowOptions, WorkLaneMember } from 'pentacle-chat-core';
import { requestWorkLaneShow } from '../../services/pentacleStream';

export type ReadWorkLaneShow = (laneId: string, options?: WorkLaneShowOptions) => Promise<WorkLaneShow>;
const protocolError = () => new Error('Incomplete member list. Please retry.');

/** One epoch owns the entire sequential load, including its single source-churn restart. */
export function useWorkLaneShow(laneId: string, connected: boolean, enabled = true,
  readShow: ReadWorkLaneShow = requestWorkLaneShow, revision?: string, goalId?: string, loadMembers = true) {
  const epoch = useRef(0);
  const [data, setData] = useState<WorkLaneShow | null>(null);
  const [loading, setLoading] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const mine = ++epoch.current;
    setData(null);
    setError(null);
    setComplete(false);
    if (!connected || !enabled) { setLoading(false); return; }
    setLoading(true);
    try {
      let accumulation: WorkLaneShow | null = null;
      let after: string | undefined;
      let restarted = false;
      const cursors = new Set<string>();
      while (mine === epoch.current) {
        const page = await readShow(laneId, { members_limit: 32,
          ...(after ? { members_after: after } : {}), ...(goalId ? { goal_id: goalId } : {}) });
        if (mine !== epoch.current) return;
        if (page.lane_id !== laneId) throw protocolError();
        // Overview publication summaries need only one response, never every historical member page.
        if (!loadMembers) { setData(page); setComplete(true); break; }
        const paged = page.members_next !== undefined || page.members_total !== undefined;
        if (paged && (page.members_next === undefined || !Number.isSafeInteger(page.members_total)
          || page.members_total! < 0 || !/^[a-f0-9]{64}$/.test(page.detail_revision ?? '')
          || !(page.members_next === null || (typeof page.members_next === 'string' && !!page.members_next)))) throw protocolError();
        if (accumulation && page.detail_revision !== accumulation.detail_revision) {
          if (restarted) throw protocolError();
          restarted = true;
          accumulation = null;
          after = undefined;
          cursors.clear();
          setData(null);
          continue;
        }
        if (accumulation && (!paged || page.members_total !== accumulation.members_total)) throw protocolError();
        const members: Map<string, WorkLaneMember> = new Map((accumulation?.members ?? []).map(member => [member.spec_id, member]));
        for (const member of page.members) if (!members.has(member.spec_id)) members.set(member.spec_id, member);
        accumulation = { ...page, members: [...members.values()] };
        setData(accumulation);
        const next = page.members_next;
        if (!paged || next === null) {
          const total = page.members_total ?? page.projection?.members_total;
          if (total !== undefined && accumulation.members.length !== total) throw protocolError();
          setComplete(true);
          break;
        }
        if (!page.members.length || !next || cursors.has(next) || (after && next <= after)
          || next !== page.members[page.members.length - 1].spec_id) throw protocolError();
        cursors.add(next);
        after = next;
      }
    } catch (failure) {
      if (mine === epoch.current) {
        const message = failure instanceof Error ? failure.message : '';
        const code = (failure as { errorCode?: string } | null)?.errorCode;
        setError(message === 'Incomplete member list. Please retry.' ? message
          : code === 'timeout' || code === 'request_timeout' || /timed?\s*out|timeout/i.test(message)
            ? 'Request timed out' : 'Lane details unavailable');
      }
    } finally { if (mine === epoch.current) setLoading(false); }
  }, [laneId, connected, enabled, readShow, revision, goalId, loadMembers]);
  useEffect(() => {
    void load();
    return () => { epoch.current += 1; };
  }, [load]);
  return { data, loading, error, complete, requestEpoch: epoch.current, retry: load };
}
