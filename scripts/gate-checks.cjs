'use strict';

// Checks may observe or run isolated test fixtures; acceptance mutations belong outside this batch.
function collectChecks(definitions, prior = []) {
  const rows = [...prior];
  for (const check of definitions) {
    const dependencies = (check.dependsOn || []).filter((name) => rows.find((row) => row.name === name)?.status !== 'passed');
    const row = { name: check.name, dependencies, status: 'unreachable' };
    if (!dependencies.length) {
      try { row.value = check.run(); row.status = 'passed'; }
      catch (error) { row.status = 'failed'; row.error = error instanceof Error ? error.message : String(error); }
    }
    rows.push(row);
  }
  return rows;
}

function requireChecks(rows) {
  const failures = rows.filter((row) => row.status === 'failed' || (row.status === 'unreachable' && row.blocking !== false));
  if (failures.length) {
    const error = new Error(`GATE_CHECKS_FAILED:${JSON.stringify(failures)}`);
    error.checks = rows;
    throw error;
  }
  return rows;
}

module.exports = { collectChecks, requireChecks };
