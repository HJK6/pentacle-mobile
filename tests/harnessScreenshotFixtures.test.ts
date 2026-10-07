/**
 * Render-smoke / contract tests for the screenshot harness (spec stage 5).
 *
 * The Playwright driver (`npm run mockups:screens`) proves the real screens
 * paint; these tests guard the layer underneath it — that every registry
 * `(screen, variant)` fixture seeds a valid `PentacleStreamState` through the
 * PRODUCTION reducers (`harnessSeedSnapshot` → `applySnapshotWithOptimistic-
 * Reconciliation` / `applyNotificationList`) and that the screen-facing
 * selectors then see the data each screen needs. This is the regression rig:
 * if a fixture drifts from the chat-core wire shape, or the offline-seed path
 * breaks, or a selector contract changes, one of these fails before the
 * (slow, browser-dependent) screenshot run does.
 *
 * Deliberately NOT a full expo-router component mount: those screens pull in
 * navigation context, safe-area, vector-icons and native modules whose web/
 * jsdom shimming is exactly what the browser harness already covers. Testing
 * the data contract here is the durable, fast, low-flake layer.
 */
import { FIXTURES, getFixture, SESSION_STREAM_ID } from '../src/harness/screenshotFixtures';
import {
  harnessSeedSnapshot,
  getPentacleStreamState,
  selectStreamSlice,
} from '../src/services/pentacleStream';
import { selectChatList, selectMachineStatsTabs, selectOpenLaneCount, selectWorkLanes } from 'pentacle-chat-core';
import { selectLaneUpdates } from '../src/services/workLanes';

function seed(key: string) {
  const fixture = FIXTURES[key];
  if (!fixture) throw new Error(`no fixture for ${key}`);
  harnessSeedSnapshot(fixture.snapshot, fixture.opts);
  return getPentacleStreamState();
}

describe('screenshot harness fixtures', () => {
  it.each(Object.keys(FIXTURES))(
    'seeds %s through the real reducers without throwing and reflects its opts',
    (key) => {
      const fixture = FIXTURES[key];
      expect(() => harnessSeedSnapshot(fixture.snapshot, fixture.opts)).not.toThrow();

      const state = getPentacleStreamState();
      const opts = fixture.opts;
      if (opts) {
        // harnessSeedSnapshot defaults connected→true / connecting→false /
        // hasHydrated→true when unset; every registry fixture sets them
        // explicitly via the SEEDED / LOADING / ERRORED presets.
        if (opts.connected !== undefined) expect(state.connected).toBe(opts.connected);
        if (opts.connecting !== undefined) expect(state.connecting).toBe(opts.connecting);
        if (opts.hasHydrated !== undefined) expect(state.hasHydrated).toBe(opts.hasHydrated);
        if (opts.lastError !== undefined) expect(state.lastError).toBe(opts.lastError);
      }
    },
  );

  it('the fixture registry and getFixture() agree for every screen:variant key', () => {
    for (const key of Object.keys(FIXTURES)) {
      const idx = key.indexOf(':');
      const screen = key.slice(0, idx);
      const variant = key.slice(idx + 1);
      expect(getFixture(screen, variant)).toBe(FIXTURES[key]);
    }
    expect(getFixture('chats', 'does-not-exist')).toBeUndefined();
  });

  it('chats:populated yields a non-empty chat list; chats:empty yields none', () => {
    expect(selectChatList(seed('chats:populated')).length).toBeGreaterThan(0);
    expect(selectChatList(seed('chats:empty')).length).toBe(0);
  });

  it('lanes:populated seeds blocked/active/paused lanes, a stale ETA and an unavailable chat through the snapshot path', () => {
    const state = seed('lanes:populated');
    expect(selectOpenLaneCount(state)).toBe(4);
    expect(selectWorkLanes(state).map((lane) => lane.state)).toEqual(['blocked', 'active', 'paused', 'paused']);
    expect(selectWorkLanes(state).some((lane) => lane.lead?.eta_stale)).toBe(true);
    expect(selectWorkLanes(state).some((lane) => lane.visible_chat.available === 'unavailable')).toBe(true);
    expect(selectWorkLanes(state).some((lane) => lane.visible_chat.available === 'history')).toBe(true);
  });

  it('lanes:empty seeds no lanes', () => {
    expect(selectOpenLaneCount(seed('lanes:empty'))).toBe(0);
  });

  it('bart:lane_updates seeds one typed card per update kind in the assistant timeline', () => {
    const state = seed('bart:lane_updates');
    expect(selectOpenLaneCount(state)).toBe(4);
    expect(selectLaneUpdates(state).map((entry) => entry.update.kind).sort()).toEqual([
      'lane_blocked', 'lane_completed', 'lane_started', 'lane_unblocked', 'major_decision', 'milestone',
    ]);
  });

  it('chats:error surfaces the tailnet lastError banner copy', () => {
    const state = seed('chats:error');
    expect(state.lastError).toMatch(/example network/i);
  });

  it('chats:tool_call_latest previews the last displayed message, not the tool call', () => {
    const state = seed('chats:tool_call_latest');
    expect(selectChatList(state).find((chat) => chat.streamId === 'hostc:claude-tool-call-latest')?.previewText).toBe('Please inspect the sample data sync.');
  });

  it('chats:offline seeds the optional L3 offline status fields', () => {
    const state = seed('chats:offline');
    const hostc = selectChatList(state).find((chat) => chat.host === 'hostc');
    expect(hostc?.hostStatus).toBe('offline');
    expect(hostc?.hostStatusReason).toBe('unreachable');
    const sampleCMachine = selectMachineStatsTabs(state).find((machine) => machine.host === 'hostc');
    expect(sampleCMachine?.hostStatusReason).toBe('unreachable');
    expect(sampleCMachine?.hostStatusSince).toBe('2026-05-30T15:20:00.000Z');
  });

  it('chats:native_question carries a legacy session.question action item', () => {
    const state = seed('chats:native_question');
    expect(state.sessions.find((session) => session.stream_id === SESSION_STREAM_ID)?.question).toBeTruthy();
    expect(state.notifications.some((notification) => notification.producer === 'agent_question.v1')).toBe(false);
  });

  it('updates:populated seeds both notifications and the updates feed', () => {
    const state = seed('updates:populated');
    expect(state.notifications.length).toBeGreaterThan(0);
    expect(state.updates.length).toBeGreaterThan(0);
  });

  it('settings fixtures seed ordered limits through the production snapshot reducer', () => {
    const state = seed('settings:populated');
    expect(state.limits!.map((entry) => entry.id)).toEqual(['claude', 'fable', 'codex']);
    expect(state.limits!.map((entry) => entry.pct)).toEqual([44, 31, 67]);
    expect(selectMachineStatsTabs(state).length).toBeGreaterThan(0);

    const empty = seed('settings:empty');
    expect(empty.limits!.map((entry) => entry.pct)).toEqual([null, null, null]);
  });

  it('session:populated seeds the SESSION_STREAM_ID transcript the screen reads', () => {
    const state = seed('session:populated');
    const events = state.events.filter((e) => e.stream_id === SESSION_STREAM_ID);
    expect(events.length).toBeGreaterThanOrEqual(2);

    const slice = selectStreamSlice(state, SESSION_STREAM_ID);
    expect(slice.session).not.toBeNull();
  });

  it('session:question carries the question_flow payload on the captured session', () => {
    const state = seed('session:question');
    const slice = selectStreamSlice(state, SESSION_STREAM_ID);
    expect(slice.session).not.toBeNull();
    const question = slice.session?.question;
    expect(question).toBeTruthy();
    expect(question?.multi).toBe(true);
    expect(question?.questions?.length).toBeGreaterThanOrEqual(2);
    // At least one question exposes the free-text "notes"/Other affordance.
    expect(question?.questions?.some((q) => q.free_text)).toBe(true);
  });

  it('session:rich_markdown seeds one long markdown assistant turn', () => {
    const state = seed('session:rich_markdown');
    const events = state.events.filter((e) => e.stream_id === SESSION_STREAM_ID);
    const markdown = events.find((e) => e.text.includes('## Strategy recap'));
    expect(markdown).toBeTruthy();
    // Exercises headings, both list kinds, a fenced code block, and a table.
    expect(markdown?.text).toMatch(/```python/);
    expect(markdown?.text).toMatch(/\| Venue/);
    expect(markdown?.text).toMatch(/^### Entry logic/m);
  });

  it('session:loading exposes the loading state with no transcript', () => {
    const state = seed('session:loading');
    expect(state.connecting).toBe(true);
    expect(state.hasHydrated).toBe(false);
    expect(state.events.length).toBe(0);
  });
});
