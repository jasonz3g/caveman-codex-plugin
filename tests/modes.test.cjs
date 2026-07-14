'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  VALID_MODES,
  canonicalizeMode,
  isMode,
} = require('../lib/modes.cjs');

test('canonicalizes wenyan alias and case', () => {
  assert.equal(canonicalizeMode('wenyan'), 'wenyan-full');
  assert.equal(canonicalizeMode(' WENYAN-FULL '), 'wenyan-full');
});

test('accepts every supported canonical mode', () => {
  const expected = [
    'off', 'lite', 'full', 'ultra',
    'wenyan-lite', 'wenyan-full', 'wenyan-ultra',
  ];
  assert.deepEqual([...VALID_MODES], expected);
  for (const mode of expected) assert.equal(canonicalizeMode(mode), mode);
});

test('rejects unknown or non-string modes', () => {
  for (const value of ['commit', 'review', 'compress', 'fast', '', null, 1]) {
    assert.equal(canonicalizeMode(value), null);
    assert.equal(isMode(value), false);
  }
});
