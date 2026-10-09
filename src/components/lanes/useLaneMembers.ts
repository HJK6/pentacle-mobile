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
  return inline;
}
export function useLaneMembers(
  inline: WorkLaneMember[],
  data: WorkLaneShow | null,
) {
  const baseline = useRef<{
    data: WorkLaneShow | null;
    inline: WorkLaneMember[];
  }>({ data: null, inline });
  if (data !== baseline.current.data) baseline.current = { data, inline };
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
