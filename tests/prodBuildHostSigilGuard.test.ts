import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const prodBuild = require('../scripts/prod-build.cjs') as {
  HOST_SIGIL_KINDS: readonly string[];
  guardProductionHostSigils: (config: unknown, options?: { label?: string }) => { offending: string[]; skipped?: boolean };
};
const fixture = require('./fixtures/hostSigilGuard.fixture.json') as {
  cases: Array<{
    key: string;
    config: unknown;
    expect: { refused: boolean; exitStatus: number; offending: string[] };
    case_sha256: string;
  }>;
};
const { MACHINES } = require('../constants/Colors') as { MACHINES: Record<string, { kind: string }> };

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function guardOutcome(config: unknown): { exitStatus: number; offending: string[] | null } {
  try {
    return { exitStatus: 0, offending: prodBuild.guardProductionHostSigils(config, { label: 'production build' }).offending };
  } catch (error) {
    return { exitStatus: 1, offending: (error as { offending?: string[] }).offending ?? null };
  }
}

describe('production host-sigil guard', () => {
  test('frozen fixture digests and the single-sourced sigil domain are intact', () => {
    for (const testCase of fixture.cases) {
      const digest = crypto.createHash('sha256')
        .update(stableStringify({ key: testCase.key, config: testCase.config, expect: testCase.expect }))
        .digest('hex');
      expect(digest).toBe(testCase.case_sha256);
    }
    expect([...prodBuild.HOST_SIGIL_KINDS].sort()).toEqual(Object.values(MACHINES).map((machine) => machine.kind).sort());
  });

  test.each(fixture.cases.map((testCase) => [testCase.key, testCase] as const))(
    'case %s preserves its exact production exit result and offending list',
    (_key, testCase) => {
      const result = guardOutcome(testCase.config);
      expect(result.exitStatus).toBe(testCase.expect.exitStatus);
      expect(result.offending).toEqual(testCase.expect.offending);
    },
  );

  test('certified full gate keeps host validation inside its existing ios-export stage', () => {
    const fullGate = fs.readFileSync(path.join(__dirname, '..', 'scripts/full-gate.cjs'), 'utf8');
    const exportStage = fullGate.indexOf("runGate('ios-export'");
    expect(exportStage).toBeGreaterThanOrEqual(0);
    expect(fullGate).not.toContain("runGate('ios-host-sigil-guard'");
    expect(fullGate.slice(exportStage)).toContain("scripts/prod-build.cjs', 'run-ios-export'");
  });
});
