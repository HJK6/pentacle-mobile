'use strict';

const {
  createSnapshot,
  discardSnapshot,
  requireSnapshot,
  snapshotRoot,
} = require('./storage-cli-bootstrap.cjs');

module.exports = { createSnapshot, discardSnapshot, requireSnapshot, snapshotRoot };
