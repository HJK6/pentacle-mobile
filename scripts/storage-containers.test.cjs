'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { freeBytes, requireCapacity } = require('./storage-containers.cjs');

const validCases = [
  ['returns an ordinary valid bigint reading', { bavail: 23n, bsize: 4096n }, 94208n],
  ['admits a full-disk zero reading', { bavail: 0n, bsize: 4096n }, 0n],
  ['admits the largest representable byte product', { bavail: (1n << 64n) - 1n, bsize: 1n }, (1n << 64n) - 1n],
];

for (const [name, stat, expected] of validCases) {
  test(name, () => assert.equal(freeBytes('/ignored', () => stat), expected));
}

const errorCases = [
  ['wraps a throwing statfs source', () => { throw new Error('read failed'); }, 'DiskStatSourceError'],
  ['rejects a null statfs result', () => null, 'DiskStatResultTypeError'],
  ['rejects a missing bavail field', () => ({ bsize: 4096n }), 'DiskStatFieldMissingError'],
  ['rejects a missing bsize field', () => ({ bavail: 23n }), 'DiskStatFieldMissingError'],
  ['rejects a wrong-typed bavail field', () => ({ bavail: '23', bsize: 4096n }), 'DiskStatFieldTypeError'],
  ['rejects a wrong-typed bsize field', () => ({ bavail: 23n, bsize: 4096 }), 'DiskStatFieldTypeError'],
  ['rejects a NaN bavail field', () => ({ bavail: Number.NaN, bsize: 4096n }), 'DiskStatFieldNonFiniteError'],
  ['rejects an infinite bsize field', () => ({ bavail: 23n, bsize: Number.POSITIVE_INFINITY }), 'DiskStatFieldNonFiniteError'],
  ['rejects a negative available-byte product', () => ({ bavail: -1n, bsize: 4096n }), 'DiskStatProductNegativeError'],
  ['rejects a negative block-size product', () => ({ bavail: 1n, bsize: -4096n }), 'DiskStatProductNegativeError'],
  ['rejects a zero block size', () => ({ bavail: 23n, bsize: 0n }), 'DiskStatFieldRangeError'],
  ['rejects two negative fields even when their product is positive', () => ({ bavail: -1n, bsize: -4096n }), 'DiskStatFieldRangeError'],
  ['rejects a product wider than an unsigned 64-bit byte count', () => ({ bavail: 1n << 64n, bsize: 1n }), 'DiskStatProductRangeError'],
];

for (const [name, statfs, expectedName] of errorCases) {
  test(name, () => {
    assert.throws(() => freeBytes('/ignored', statfs), { name: expectedName });
    assert.throws(() => requireCapacity('start', statfs), { name: expectedName });
  });
}
