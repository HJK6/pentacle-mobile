// A spawn objective is the child's single goal for its whole life, shown to the operator on
// the parent's sub-agent roster. Objectives are a child-agent concept: a top-level mobile spawn
// (the summon sheet) sends none and the daemon derives it. This validator is for the programmatic
// paths that DO pass one — an explicit harness/child objective — enforcing a single line of
// 1–120 code points. Client validation only explains the problem locally; daemon admission stays
// authoritative.
// public_behavior_spec.

export const OBJECTIVE_MAX_CODE_POINTS = 120;

export type SpawnObjectiveValidation =
  | { ok: true; value: string; error: null }
  | { ok: false; value: string; error: string };

// Count Unicode code points, not UTF-16 units, so an objective of astral characters (emoji)
// is measured the way the daemon measures it.
function countCodePoints(text: string): number {
  return [...text].length;
}

export function validateSpawnObjective(raw: unknown): SpawnObjectiveValidation {
  const text = typeof raw === 'string' ? raw : '';
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, value: '', error: 'An objective is required.' };
  }
  if (/[\r\n]/.test(text)) {
    return { ok: false, value: trimmed, error: 'The objective must be a single line.' };
  }
  if (countCodePoints(trimmed) > OBJECTIVE_MAX_CODE_POINTS) {
    return {
      ok: false,
      value: trimmed,
      error: `The objective must be ${OBJECTIVE_MAX_CODE_POINTS} characters or fewer.`,
    };
  }
  return { ok: true, value: trimmed, error: null };
}

