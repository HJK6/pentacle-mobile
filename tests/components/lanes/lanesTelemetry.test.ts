jest.mock('pentacle-chat-core', () => ({ ...jest.requireActual('pentacle-chat-core'), logTelemetry: jest.fn() }));
jest.mock('../../../src/utils/harnessRuntime', () => ({ isArmed: jest.fn() }));

import { logTelemetry } from 'pentacle-chat-core';
import { isArmed } from '../../../src/utils/harnessRuntime';
import { emitHarnessUiTrace } from '../../../src/components/lanes/lanesTelemetry';

const priorHarness = process.env.EXPO_PUBLIC_HARNESS;
afterEach(() => {
  if (priorHarness === undefined) delete process.env.EXPO_PUBLIC_HARNESS;
  else process.env.EXPO_PUBLIC_HARNESS = priorHarness;
});

test.each([
  [undefined, false], [undefined, true], ['0', true], ['1', false],
])('does not emit in unarmed or release builds (%s, %s)', (flag, armed) => {
  if (flag === undefined) delete process.env.EXPO_PUBLIC_HARNESS; else process.env.EXPO_PUBLIC_HARNESS = flag;
  (isArmed as jest.Mock).mockReturnValue(armed);
  emitHarnessUiTrace('work_lanes_view', { view: 'map' });
  expect(logTelemetry).not.toHaveBeenCalled();
});

test('armed harness uses the existing UI trace event and preserves only supplied IDs/counts', () => {
  process.env.EXPO_PUBLIC_HARNESS = '1';
  (isArmed as jest.Mock).mockReturnValue(true);
  emitHarnessUiTrace('work_lanes_map_render', { page: 1, page_count: 2, lane_nodes: 8, focused_lane_id: null, member_nodes: 0, more_count: 0 });
  expect(logTelemetry).toHaveBeenCalledWith('harness:ui_trace', {
    kind: 'work_lanes_map_render', timestamp_emitter_wall: expect.any(Number),
    page: 1, page_count: 2, lane_nodes: 8, focused_lane_id: null, member_nodes: 0, more_count: 0,
  });
});
