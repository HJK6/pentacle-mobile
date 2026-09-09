#!/usr/bin/env node
'use strict';

const { readRecord } = require('./storage-state.cjs');

function main(argv) {
  if (argv.length !== 3 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(argv[2])) throw new Error('BUILDER_WORKER_ID_ONLY');
  const run = readRecord('runs', argv[2]);
  require('./build-native-root.cjs').buildForRun(run.id, run.candidate_ref);
}

if (require.main === module) {
  try { main(process.argv); }
  catch (error) { process.stderr.write(`${String(error.message || error)}\n`); process.exitCode = 17; }
}

module.exports = { main };
