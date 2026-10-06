#!/usr/bin/env node
'use strict';
// Disposable stage instrumentation used by the public full-gate unit caller.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const [mode, runId, stage, separator, ...command] = process.argv.slice(2);
if (mode !== 'stage' || !runId || !stage || separator !== '--' || !command.length || !process.env.TESTTIME_OUT) {
  console.error('TESTTIME_FIXTURE_ARGUMENTS');
  process.exitCode = 2;
} else {
  const startedAt = Date.now();
  const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit', env: process.env });
  const status = result.status ?? 1;
  fs.appendFileSync(process.env.TESTTIME_OUT, JSON.stringify({ run_id: runId, stage, status,
    started_at: startedAt, finished_at: Date.now(), repo: process.env.TESTTIME_REPO, sha: process.env.TESTTIME_SHA }) + '\n');
  if (result.error) console.error(result.error.message);
  process.exitCode = status;
}
