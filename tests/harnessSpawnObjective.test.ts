import { resolveHarnessSpawnObjective } from '../src/services/harnessActions';
import { OBJECTIVE_MAX_CODE_POINTS } from '../src/services/spawnObjective';

// A top-level harness spawn omits the objective (daemon derives it); a fixture may still pass an
// explicit spawn_objective to exercise the objective path. Absent → ok/no objective, valid → ok
// with the trimmed objective, non-empty-but-invalid → not ok (aborts before any frame is sent).

test('absent objective is ok and carries no objective (daemon derives)', () => {
  expect(resolveHarnessSpawnObjective(undefined)).toEqual({ ok: true });
  expect(resolveHarnessSpawnObjective(null)).toEqual({ ok: true });
  expect(resolveHarnessSpawnObjective('')).toEqual({ ok: true });
});

test('a valid explicit objective is ok and trimmed', () => {
  expect(resolveHarnessSpawnObjective('  Diagnose the freeze  ')).toEqual({ ok: true, objective: 'Diagnose the freeze' });
});

test('a non-empty invalid explicit objective is rejected (would abort before any frame)', () => {
  expect(resolveHarnessSpawnObjective('line one\nline two')).toEqual({ ok: false });
  expect(resolveHarnessSpawnObjective('x'.repeat(OBJECTIVE_MAX_CODE_POINTS + 1))).toEqual({ ok: false });
  // Whitespace-only is treated as absent (length > 0 but validator trims to empty → invalid path).
  expect(resolveHarnessSpawnObjective('   ')).toEqual({ ok: false });
});
