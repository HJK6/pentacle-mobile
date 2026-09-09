'use strict';

// Nine named points at which a run can lose power, and NOTHING ELSE. The evidence classes each one
// bounds - a half-created image, an attach that took but was never recorded, a journal entry that
// reached the page cache but not the disk, a seal written over an unfinished payload, a publication
// without a discard, a discard without a detach, a retention sweep that expired what it had not yet
// released, a tombstone without the record it replaces - were previously demonstrable only by
// argument, because the crossings sit inside hdiutil and private atomic helpers with no seam
// between "did it" and "recorded it".
//
// ARMING IS IN-PROCESS AND CAPABILITY-BOUND, never an environment variable. An env-driven exit
// would mean any ambient value in a real gate's environment could terminate it mid-transition -
// the seam would BE the failure it exists to study. A crash therefore requires a process that
// deliberately required this module and armed it, which is exactly the real-child worker pattern
// the storage slices already use.
const CRASH_POINTS = Object.freeze([
  'container-create', 'container-attach', 'journal-durability', 'seal',
  'publication', 'detach', 'discard', 'retention', 'tombstone',
]);

// The same status the q6 atomic-report worker already uses for a deliberate crash, so a harness
// reading an exit code cannot confuse "crashed where we asked" with a real failure (17) or a clean
// exit (0).
const CRASH_EXIT_STATUS = 23;

let armed = null;

function requireKnownPoint(name) {
  if (!CRASH_POINTS.includes(name)) throw new Error(`CRASH_POINT_UNKNOWN:${name}`);
  return name;
}

// Deliberately process.exit and not a throw: a throw is caught by the very recovery handlers under
// test, which would convert the power-loss being modelled into an orderly failure and prove nothing.
function crashPoint(name) {
  requireKnownPoint(name);
  if (armed !== name) return false;
  process.exit(CRASH_EXIT_STATUS);
  return true;
}

function armCrashPoint(name) {
  armed = name === null ? null : requireKnownPoint(name);
  return armed;
}

function armedCrashPoint() { return armed; }

module.exports = {
  CRASH_EXIT_STATUS,
  CRASH_POINTS,
  armedCrashPoint,
  bind: (token) => require('./storage-capability.cjs').bind(token, { armCrashPoint }),
  crashPoint,
};
