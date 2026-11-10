import { useRef } from "react";
import type { WorkLaneMember, WorkLaneShow } from "pentacle-chat-core";
export function currentMember(
  selected: WorkLaneMember,
  inline: WorkLaneMember | undefined,
  inlineAtOpen: WorkLaneMember | undefined,
) {
  if (!inline || JSON.stringify(inline) === JSON.stringify(inlineAtOpen))
    return selected;
  if (
    inline.obs_rev != null &&
    selected.obs_rev != null &&
    inline.obs_rev !== selected.obs_rev
  )
    return inline.obs_rev > selected.obs_rev ? inline : selected;
  const a = Date.parse(selected.observation?.observed_at || ""),
    b = Date.parse(inline.observation?.observed_at || "");
  if (Number.isFinite(a) && Number.isFinite(b) && b < a) return selected;
  // A newer observation owns its own fields. Projection-only updates at the
  // same observation retain details that inventory intentionally does not send.
  if (
    (Number.isFinite(a) && Number.isFinite(b) && b > a) ||
    inline.source_changed_at !== selected.source_changed_at
  ) return inline;
  return {
    ...inline,
    criteria: inline.criteria ?? selected.criteria,
    transitions: inline.transitions ?? selected.transitions,
    summary_line: Object.hasOwn(inline, 'summary_line') ? inline.summary_line : selected.summary_line,
    blocked_line: Object.hasOwn(inline, 'blocked_line') ? inline.blocked_line : selected.blocked_line,
    progress_at: Object.hasOwn(inline, 'progress_at') ? inline.progress_at : selected.progress_at,
    estimate_first: Object.hasOwn(inline, 'estimate_first') ? inline.estimate_first : selected.estimate_first,
    unblocks: Object.hasOwn(inline, 'unblocks') ? inline.unblocks : selected.unblocks,
    recent: Object.hasOwn(inline, 'recent') ? inline.recent : selected.recent,
  };
}
export function useLaneMembers(
  inline: WorkLaneMember[],
  data: WorkLaneShow | null,
  loadEpoch?: number,
) {
  const baseline = useRef<{
    data: WorkLaneShow | null;
    inline: WorkLaneMember[];
    loadEpoch?: number;
  }>({ data: null, inline });
  // Pagination changes data on each page; retain the opening observation baseline for the whole load.
  if ((loadEpoch === undefined ? data !== baseline.current.data : loadEpoch !== baseline.current.loadEpoch)
    || !data || !baseline.current.data || data.lane_id !== baseline.current.data.lane_id
    || data.detail_revision !== baseline.current.data.detail_revision) baseline.current = { data, inline, loadEpoch };
  return data
    ? data.members.map((member) =>
        currentMember(
          member,
          inline.find((m) => m.spec_id === member.spec_id),
          baseline.current.inline.find((m) => m.spec_id === member.spec_id),
        ),
      )
    : inline;
}
