import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { WorkLaneMember } from "pentacle-chat-core";
import { logTelemetry } from "pentacle-chat-core";
import * as harnessRuntime from "../../utils/harnessRuntime";
import { MOBILE_TELEMETRY_EVENTS } from "../../services/mobileTelemetryEvents";

/** Match the stream trace transport without adding any release telemetry. */
export function emitHarnessUiTrace(
  kind: string,
  data: Record<string, unknown>,
) {
  if (process.env.EXPO_PUBLIC_HARNESS !== "1" || !harnessRuntime.isArmed())
    return;
  logTelemetry(
    MOBILE_TELEMETRY_EVENTS.HARNESS_UI_TRACE as Parameters<
      typeof logTelemetry
    >[0],
    {
      kind,
      timestamp_emitter_wall: Date.now(),
      ...data,
    },
  );
}

export function traceMemberList(laneId: string, members: WorkLaneMember[]) {
  emitHarnessUiTrace("work_lanes_members_list", {
    lane_id: laneId,
    total: members.length,
    spec_ids_sha256: bytesToHex(
      sha256(utf8ToBytes(JSON.stringify(members.map((m) => m.spec_id)))),
    ),
  });
}
