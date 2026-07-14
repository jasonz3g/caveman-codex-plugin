'use strict';

const VALID_MODES = Object.freeze([
  'off',
  'lite',
  'full',
  'ultra',
  'wenyan-lite',
  'wenyan-full',
  'wenyan-ultra',
]);

const MODE_SET = new Set(VALID_MODES);

function canonicalizeMode(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'wenyan') return 'wenyan-full';
  return MODE_SET.has(normalized) ? normalized : null;
}

function isMode(value) {
  return canonicalizeMode(value) !== null;
}

module.exports = { VALID_MODES, canonicalizeMode, isMode };
