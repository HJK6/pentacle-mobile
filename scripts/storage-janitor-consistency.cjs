'use strict';

const fs = require('node:fs');
const path = require('node:path');

const IMAGE_SUFFIX = '.sparsebundle';
const RECORD_SUFFIX = '.json';
const SCRATCH_DISCARDED = new Set(['scratch_discarded', 'evidence_discarding', 'evidence_discarded']);
// A backing_absent run's scratch AND evidence images are gone by definition - lost out of band and
// dispositioned to a terminal record that states so - so it is expected to have NEITHER image. Counting it
// as expecting an evidence image would make the accounting read a leak where the record already accounts
// for the absence; excluding it keeps missing/unexpected detection honest for every other run.
const BACKING_ABSENT = new Set(['backing_absent']);

function names(directory, suffix) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.endsWith(suffix)).sort();
}

function readConsistencyInventory(layout) {
  return {
    journal: names(path.join(layout.state, 'runs'), RECORD_SUFFIX).map((name) => name.slice(0, -RECORD_SUFFIX.length)),
    scratch: names(layout.scratchImages, IMAGE_SUFFIX),
    evidence: names(layout.evidenceImages, IMAGE_SUFFIX),
  };
}

function imageIds(entries) {
  return new Set(entries.map((name) => name.endsWith(IMAGE_SUFFIX) ? name.slice(0, -IMAGE_SUFFIX.length) : name));
}

function reconcileRunImages(runs, images, journalIds = runs.map((run) => run.id)) {
  const states = new Map(runs.map((run) => [run.id, run.state]));
  const journal = [...new Set(journalIds)].sort();
  const expectedEvidence = new Set(journal.filter((id) => !BACKING_ABSENT.has(states.get(id))));
  const expectedScratch = new Set(journal.filter((id) => !SCRATCH_DISCARDED.has(states.get(id)) && !BACKING_ABSENT.has(states.get(id))));
  const actualEvidence = imageIds(images.evidence);
  const actualScratch = imageIds(images.scratch);
  const difference = (left, right) => [...left].filter((id) => !right.has(id)).sort();
  const missingEvidence = difference(expectedEvidence, actualEvidence);
  const missingScratch = difference(expectedScratch, actualScratch);
  const unexpectedEvidence = difference(actualEvidence, expectedEvidence);
  const unexpectedScratch = difference(actualScratch, expectedScratch);
  const mismatch = [missingEvidence, missingScratch, unexpectedEvidence, unexpectedScratch].some((entries) => entries.length);
  return {
    kind: 'consistency',
    id: 'journal-images',
    action: mismatch ? 'mismatch' : 'reconciled',
    reason: `runs=${journal.length};evidence_images=${actualEvidence.size};expected_evidence=${expectedEvidence.size};scratch_images=${actualScratch.size};expected_scratch=${expectedScratch.size}`,
    missing_evidence: missingEvidence,
    missing_scratch: missingScratch,
    unexpected_evidence: unexpectedEvidence,
    unexpected_scratch: unexpectedScratch,
  };
}

module.exports = { readConsistencyInventory, reconcileRunImages };
