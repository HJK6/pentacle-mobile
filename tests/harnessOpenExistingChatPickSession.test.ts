/**
 * Unit tests for `pickSession` (and its automated-session exclusion) plus the
 * `EXPO_PUBLIC_HARNESS_SESSION_EXCLUDE_REGEX` override path.
 *
 * Spec: public-test-spec Stage 1.1.
 */

import type { PentacleSessionSummary, PentacleStreamState } from 'pentacle-chat-core';

function session(overrides: Partial<PentacleSessionSummary> = {}): PentacleSessionSummary {
  return {
    stream_id: 'hostc:user-session',
    host: 'hostc',
    provider: 'codex',
    session_name: 'user-session',
    last_event_at: '2026-05-10T10:00:00.000Z',
    last_text: 'hello',
    last_kind: 'ASSIST',
    draft: '',
    pending: false,
    working: false,
    online: true,
    ...overrides,
  };
}

function state(sessions: PentacleSessionSummary[]): PentacleStreamState {
  return {
    connected: true,
    connecting: false,
    hasHydrated: true,
    events: [],
    drafts: {},
    hosts: {},
    machineStats: {},
    sessions,
    updates: [],
    notifications: [],
  };
}

describe('pickSession with automated-session exclusion', () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.EXPO_PUBLIC_HARNESS_SESSION_EXCLUDE_REGEX;
  });

  // Automated fixture sessions use the timestamped
  // `<provider>-<YYYYMMDDhhmmss>-<nonce>` pattern. The older
  // `<provider>-<host>-<digits>` shape can also describe a legitimate
  // spawned chat, so the default exclusion stays narrow. Broader exclusions
  // can be enabled via
  // EXPO_PUBLIC_HARNESS_SESSION_EXCLUDE_REGEX when needed.
  test('skips timestamped automated sessions even when newer than the user session', () => {
    const { pickSession } = require('../src/services/harnessOpenExistingChat');
    const picked = pickSession(
      state([
        session({
          stream_id: 'hostc:user-codex',
          host: 'hostc',
          provider: 'codex',
          session_name: 'sample-session',
          display_name: 'Sample session',
          last_event_at: '2026-05-10T10:00:00.000Z',
        }),
        session({
          stream_id: 'hostc:agent-1',
          host: 'hostc',
          provider: 'codex',
          session_name: 'codex-20260510120000-abc1',
          display_name: 'codex-20260510120000-abc1',
          last_event_at: '2026-05-10T12:00:00.000Z',
        }),
        session({
          stream_id: 'hostc:agent-2',
          host: 'hostc',
          provider: 'codex',
          session_name: 'codex-20260510130000-xyz9',
          display_name: 'codex-20260510130000-xyz9',
          last_event_at: '2026-05-10T13:00:00.000Z',
        }),
        session({
          stream_id: 'hostc:offline-newest',
          host: 'hostc',
          provider: 'codex',
          last_event_at: '2026-05-10T14:00:00.000Z',
          online: false,
        }),
      ]),
      'hostc',
    );
    expect(picked).not.toBeNull();
    expect(picked!.stream_id).toBe('hostc:user-codex');
  });

  test('timestamped Claude automated sessions are also excluded', () => {
    const { pickSession } = require('../src/services/harnessOpenExistingChat');
    const picked = pickSession(
      state([
        session({
          stream_id: 'hosta:user-claude',
          host: 'hosta',
          provider: 'claude',
          display_name: 'Real user session',
          last_event_at: '2026-05-10T10:00:00.000Z',
        }),
        session({
          stream_id: 'hosta:agent-claude',
          host: 'hosta',
          provider: 'claude',
          display_name: 'claude-20260510110000-abc1',
          last_event_at: '2026-05-10T11:00:00.000Z',
        }),
      ]),
      'hosta',
    );
    expect(picked!.stream_id).toBe('hosta:user-claude');
  });

  test('falls back to session_name when display_name is falsy', () => {
    const { pickSession } = require('../src/services/harnessOpenExistingChat');
    const picked = pickSession(
      state([
        session({
          stream_id: 'hostc:user',
          host: 'hostc',
          session_name: 'manual-session',
          display_name: '',
          last_event_at: '2026-05-10T10:00:00.000Z',
        }),
        session({
          stream_id: 'hostc:agent-no-display',
          host: 'hostc',
          session_name: 'codex-20260510110000-xy77',
          display_name: '',
          last_event_at: '2026-05-10T11:00:00.000Z',
        }),
      ]),
      'hostc',
    );
    expect(picked!.stream_id).toBe('hostc:user');
  });

  test('filters by provider when provider arg is set', () => {
    const { pickSession } = require('../src/services/harnessOpenExistingChat');
    const sessions = state([
      session({
        stream_id: 'hostc:user-claude',
        host: 'hostc',
        provider: 'claude',
        display_name: 'Claude work',
        last_event_at: '2026-05-10T10:00:00.000Z',
      }),
      session({
        stream_id: 'hostc:user-codex',
        host: 'hostc',
        provider: 'codex',
        display_name: 'Codex work',
        last_event_at: '2026-05-10T11:00:00.000Z',
      }),
    ]);
    expect(pickSession(sessions, 'hostc', 'claude')!.stream_id).toBe('hostc:user-claude');
    expect(pickSession(sessions, 'hostc', 'codex')!.stream_id).toBe('hostc:user-codex');
  });

  test('backward compatible — no provider arg returns newest regardless of provider', () => {
    const { pickSession } = require('../src/services/harnessOpenExistingChat');
    const picked = pickSession(
      state([
        session({
          stream_id: 'hostc:claude-old',
          host: 'hostc',
          provider: 'claude',
          display_name: 'Old claude',
          last_event_at: '2026-05-10T10:00:00.000Z',
        }),
        session({
          stream_id: 'hostc:codex-new',
          host: 'hostc',
          provider: 'codex',
          display_name: 'New codex',
          last_event_at: '2026-05-10T11:00:00.000Z',
        }),
      ]),
      'hostc',
    );
    expect(picked!.stream_id).toBe('hostc:codex-new');
  });

  test('EXPO_PUBLIC_HARNESS_SESSION_EXCLUDE_REGEX appends an extra pattern to the exclusion list', () => {
    process.env.EXPO_PUBLIC_HARNESS_SESSION_EXCLUDE_REGEX = '^scratch-.*$';
    const { pickSession } = require('../src/services/harnessOpenExistingChat');
    const picked = pickSession(
      state([
        session({
          stream_id: 'hostc:real',
          host: 'hostc',
          display_name: 'Real user',
          last_event_at: '2026-05-10T10:00:00.000Z',
        }),
        session({
          stream_id: 'hostc:scratch',
          host: 'hostc',
          display_name: 'scratch-pad',
          last_event_at: '2026-05-10T13:00:00.000Z',
        }),
      ]),
      'hostc',
    );
    expect(picked!.stream_id).toBe('hostc:real');
  });

  test('EXPO_PUBLIC_HARNESS_SESSION_EXCLUDE_REGEX supports `;`-delimited multi-pattern override', () => {
    process.env.EXPO_PUBLIC_HARNESS_SESSION_EXCLUDE_REGEX = '^scratch-.*$;^throwaway-.*$';
    const { pickSession } = require('../src/services/harnessOpenExistingChat');
    const picked = pickSession(
      state([
        session({
          stream_id: 'hostc:real',
          host: 'hostc',
          display_name: 'Real user',
          last_event_at: '2026-05-10T10:00:00.000Z',
        }),
        session({
          stream_id: 'hostc:throwaway',
          host: 'hostc',
          display_name: 'throwaway-1',
          last_event_at: '2026-05-10T12:00:00.000Z',
        }),
        session({
          stream_id: 'hostc:scratch',
          host: 'hostc',
          display_name: 'scratch-pad',
          last_event_at: '2026-05-10T13:00:00.000Z',
        }),
      ]),
      'hostc',
    );
    expect(picked!.stream_id).toBe('hostc:real');
  });

  test('invalid regex literal in override is skipped with console.warn (no crash)', () => {
    process.env.EXPO_PUBLIC_HARNESS_SESSION_EXCLUDE_REGEX = '[invalid;^scratch-.*$';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { pickSession } = require('../src/services/harnessOpenExistingChat');
    const picked = pickSession(
      state([
        session({
          stream_id: 'hostc:real',
          host: 'hostc',
          display_name: 'Real user',
          last_event_at: '2026-05-10T10:00:00.000Z',
        }),
        session({
          stream_id: 'hostc:scratch',
          host: 'hostc',
          display_name: 'scratch-pad',
          last_event_at: '2026-05-10T12:00:00.000Z',
        }),
      ]),
      'hostc',
    );
    expect(picked!.stream_id).toBe('hostc:real');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('returns null when only automated sessions exist for the host', () => {
    const { pickSession } = require('../src/services/harnessOpenExistingChat');
    const picked = pickSession(
      state([
        session({
          stream_id: 'hostc:only-agent',
          host: 'hostc',
          display_name: 'codex-20260510120000-abc1',
          session_name: 'codex-20260510120000-abc1',
        }),
      ]),
      'hostc',
    );
    expect(picked).toBeNull();
  });

  test('explicit harness override routes before scripted inventory hydrates', () => {
    const { pickSession } = require('../src/services/harnessOpenExistingChat');
    const picked = pickSession(
      state([]),
      'hostc',
      'claude',
      'hostc:fixture-before-inventory',
    );

    expect(picked).toMatchObject({
      stream_id: 'hostc:fixture-before-inventory',
      host: 'hostc',
      provider: 'claude',
      online: true,
      display_name: '[harness-explicit-override]',
    });
  });
});
