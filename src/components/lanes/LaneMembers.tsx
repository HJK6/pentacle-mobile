import React, { useEffect } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { WorkLaneMember } from 'pentacle-chat-core';
import { Tokens } from '@/constants/Colors';
import type { LaneCardViewModel } from '../../services/workLanes';
import { LaneMemberSummary, memberTitle } from './LaneMemberDetail';
import { laneStyles as s } from './laneStyles';
import { emitHarnessUiTrace } from './lanesTelemetry';
import { useWorkLaneShow, type ReadWorkLaneShow } from './useWorkLaneShow';

export default function LaneMembers({ model, connected, onBack, onOpenMember, readShow, bottom = 18 }: {
  model: LaneCardViewModel; connected: boolean; onBack(): void; onOpenMember(member: WorkLaneMember): void;
  readShow?: ReadWorkLaneShow; bottom?: number;
}) {
  const needsShow = model.membersTotal > model.members.length;
  const { data, loading, error, retry } = useWorkLaneShow(model.lane.lane_id, connected, needsShow, readShow);
  const total = data?.projection?.members_total ?? model.membersTotal;
  const incomplete = needsShow && data !== null && data.members.length < total;
  const members = needsShow ? data?.members ?? [] : model.members;
  const ready = !needsShow || (data !== null && !incomplete);
  const failure = error || (incomplete ? 'Incomplete member list. Please retry.' : null);
  useEffect(() => {
    if (!ready) return;
    emitHarnessUiTrace('work_lanes_members_list', {
      lane_id: model.lane.lane_id, total: members.length,
      spec_ids_sha256: bytesToHex(sha256(utf8ToBytes(JSON.stringify(members.map((member) => member.spec_id))))),
    });
  }, [ready, members, model.lane.lane_id]);
  return <View testID={`lane-members-${model.lane.lane_id}`} style={s.root}>
    <ScrollView contentContainerStyle={{ paddingBottom: bottom }}>
    <View style={s.header}>
      <Pressable testID="lane-members-back" accessibilityRole="button" accessibilityLabel={`Back to ${model.lane.title}`} onPress={onBack} style={s.button}>
        <Text numberOfLines={2} style={s.buttonText}>‹ {model.lane.title}</Text>
      </Pressable>
      <Text style={s.title}>All {total} specs</Text>
    </View>
    <View style={s.body}>
      {loading ? <ActivityIndicator testID="lane-members-loading" color={Tokens.palette.green} /> : null}
      {failure ? <View testID="lane-members-error" style={s.panel}>
        <Text style={s.error}>{failure}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Retry members" onPress={() => void retry()} style={s.button}><Text style={s.buttonText}>Retry</Text></Pressable>
      </View> : null}
      {!connected && needsShow ? <Text style={s.muted}>Waiting for connection…</Text> : null}
      {ready && members.length === 0 ? <Text style={s.muted}>{model.lane.no_spec_reason || 'No specs'}</Text> : null}
      {ready ? members.map((member) => <Pressable key={member.spec_id} testID={`lane-members-row-${member.spec_id}`}
        accessibilityRole="button" accessibilityLabel={`${memberTitle(member)}, ${member.status || 'unknown'}`}
        style={s.panel} onPress={() => onOpenMember(member)}><LaneMemberSummary member={member} /></Pressable>) : null}
    </View>
    </ScrollView>
  </View>;
}
