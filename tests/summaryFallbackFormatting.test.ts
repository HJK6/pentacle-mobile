import {
  applyPentacleSnapshotMessage,
  initialPentacleStreamState,
  selectSessionDetail,
} from '../pentacle-chat-core/src';
import fixture from '../pentacle-chat-core/tests/fixtures/summary-fallback-frames.json';

// Same actual provider-ingested frames as the web core/browser regression.
const stream = fixture.session.stream_id;
const read = (held: boolean, working = false) => selectSessionDetail(
  applyPentacleSnapshotMessage(initialPentacleStreamState, {
    sessions: [{ ...fixture.session, working }],
    events: held ? fixture.events : [], drafts: {},
  }), stream, { visibleCount: 'all', includeDraft: false },
)!.transcriptItems;

describe('session summary Markdown fallback', () => {
  it('keeps original whitespace and code while transcript backfill is pending', () => {
    const rows = read(false);
    expect(rows).toHaveLength(1);
    expect(rows[0].eventKey).toBe('uncorrelated_fallback');
    expect(rows[0].text).toBe(fixture.events[0].text);
  });

  it('keeps the actual held answer singular through later activity and working ticks', () => {
    expect(Date.parse(fixture.session.last_event_at)).toBeGreaterThan(Date.parse(fixture.events[0].timestamp));
    for (const working of [false, true, false, true, false]) {
      const rows = read(true, working);
      expect(rows).toHaveLength(1);
      expect(rows[0].text).toBe(fixture.events[0].text);
      expect(rows[0].eventKey).not.toBe('uncorrelated_fallback');
    }
  });
});
