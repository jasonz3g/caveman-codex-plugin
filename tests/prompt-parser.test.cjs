'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_PROMPT_BYTES,
  parseModeIntent,
} = require('../lib/prompt-parser.cjs');

const NONE = { kind: 'none', mode: null, recognized: false };

const cases = [
  ['/caveman', 'wenyan-full'],
  ['/caveman wenyan', 'wenyan-full'],
  ['/caveman lite', 'lite'],
  ['$caveman ultra', 'ultra'],
  ['启用 caveman 文言', 'wenyan-full'],
  ['使用 caveman 简洁模式', 'full'],
  ['stop caveman', 'off'],
  ['关闭 caveman', 'off'],
  ['恢复正常模式', 'off'],
];

for (const [prompt, mode] of cases) {
  test(`parses ${prompt}`, () => {
    assert.deepEqual(parseModeIntent(prompt, 'wenyan-full'), {
      kind: mode === 'off' ? 'deactivate' : 'set',
      mode,
      recognized: true,
    });
  });
}

for (const prompt of [
  'How does caveman mode work?',
  '什么是 caveman wenyan？',
  'How do I exit Vim normal mode?',
  'Please be brief in the summary only.',
  '/caveman commit',
]) {
  test(`does not change state for ${prompt}`, () => {
    assert.deepEqual(parseModeIntent(prompt, 'wenyan-full'), NONE);
  });
}

test('rejects questions even when they mention an otherwise valid intent', () => {
  for (const prompt of [
    'How do I stop caveman?',
    'Can I enable caveman lite?',
    '如何关闭 caveman？',
  ]) {
    assert.deepEqual(parseModeIntent(prompt, 'wenyan-full'), NONE);
  }
});

for (const prompt of [
  'Should I stop caveman?',
  'Would you enable caveman lite?',
  'Do I disable caveman?',
  'Did you enable caveman ultra?',
  'Will you switch to caveman full?',
]) {
  test(`rejects interrogative intent ${prompt}`, () => {
    assert.deepEqual(parseModeIntent(prompt, 'wenyan-full'), NONE);
  });
}

for (const prompt of [
  'Do not enable caveman',
  "Don't enable caveman",
  'Please do not stop caveman',
  'Never switch to caveman ultra',
  '不要启用 caveman 文言',
  '别关闭 caveman',
  '請勿 stop caveman',
  '请勿 enable caveman lite',
]) {
  test(`rejects negated intent ${prompt}`, () => {
    assert.deepEqual(parseModeIntent(prompt, 'wenyan-full'), NONE);
  });
}

for (const prompt of [
  'Normal mode in Vim',
  'Please switch back to normal mode after editing',
]) {
  test(`rejects unrelated normal-mode text ${prompt}`, () => {
    assert.deepEqual(parseModeIntent(prompt, 'wenyan-full'), NONE);
  });
}

for (const prompt of [
  'Enable caveman politely',
  'Enable caveman fully',
  'Enable lite caveman',
  'Enable caveman lite for this reply',
  '启用 caveman 非文言',
  '启用 caveman 文言化',
]) {
  test(`rejects inexact mode directive ${prompt}`, () => {
    assert.deepEqual(parseModeIntent(prompt, 'wenyan-full'), NONE);
  });
}

for (const prompt of [
  '关闭 cavemanship',
  '启用 cavemanagement 文言',
]) {
  test(`rejects inexact caveman token ${prompt}`, () => {
    assert.deepEqual(parseModeIntent(prompt, 'wenyan-full'), NONE);
  });
}

const naturalActivationCases = [
  ['Enable caveman lite', 'lite'],
  ['Enable caveman full.', 'full'],
  ['Please use caveman wenyan-ultra', 'wenyan-ultra'],
  ['Switch to caveman', 'wenyan-full'],
  ['Turn on caveman mode!', 'wenyan-full'],
];

for (const [prompt, mode] of naturalActivationCases) {
  test(`parses exact activation directive ${prompt}`, () => {
    assert.deepEqual(parseModeIntent(prompt, 'wenyan-full'), {
      kind: 'set', mode, recognized: true,
    });
  });
}

for (const prompt of [
  'Normal mode.',
  'Please switch back to normal mode!',
  'Go back to normal mode',
]) {
  test(`parses exact normal-mode directive ${prompt}`, () => {
    assert.deepEqual(parseModeIntent(prompt, 'wenyan-full'), {
      kind: 'deactivate', mode: 'off', recognized: true,
    });
  });
}

test('rejects one-shot caveman commands as mode names', () => {
  for (const command of ['commit', 'review', 'compress', 'help', 'stats']) {
    assert.deepEqual(parseModeIntent(`/caveman ${command}`, 'wenyan-full'), NONE);
    assert.deepEqual(parseModeIntent(`$caveman ${command}`, 'wenyan-full'), NONE);
  }
});

test('recognizes every supported Chinese mode label', () => {
  const labels = [
    ['文言', 'wenyan-full'],
    ['轻文言', 'wenyan-lite'],
    ['極簡文言', 'wenyan-ultra'],
    ['极简文言', 'wenyan-ultra'],
    ['简洁模式', 'full'],
    ['簡潔模式', 'full'],
    ['极简模式', 'ultra'],
    ['極簡模式', 'ultra'],
  ];

  for (const [label, mode] of labels) {
    assert.deepEqual(parseModeIntent(`启用 caveman ${label}`, 'lite'), {
      kind: 'set', mode, recognized: true,
    });
  }
});

test('rejects prompts larger than 64 KiB', () => {
  const atLimit = `/caveman${' '.repeat(MAX_PROMPT_BYTES - 8)}`;
  const overLimit = `${atLimit} `;

  assert.equal(Buffer.byteLength(atLimit), MAX_PROMPT_BYTES);
  assert.deepEqual(parseModeIntent(atLimit, 'lite'), {
    kind: 'set', mode: 'lite', recognized: true,
  });
  assert.deepEqual(parseModeIntent(overLimit, 'lite'), NONE);
});
