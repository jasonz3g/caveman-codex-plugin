'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = fs;
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
  MAX_SKILL_BYTES,
  buildFullContext,
  buildContextForMode,
  buildOffReminder,
  buildReminder,
  loadSkillBody,
} = require('../lib/rules.cjs');

const pluginRoot = join(__dirname, '..');
const skillPath = join(pluginRoot, 'skills', 'caveman', 'SKILL.md');
const readmePath = join(pluginRoot, 'skills', 'caveman', 'README.md');
const modes = [
  'lite',
  'full',
  'ultra',
  'wenyan-lite',
  'wenyan-full',
  'wenyan-ultra',
];

function skillDocument(body, metadata = [
  'name: caveman',
  'description: Test caveman rules.',
]) {
  return `---\n${metadata.join('\n')}\n---\n\n${body}\n`;
}

function createSkillFixture(contents) {
  const root = mkdtempSync(join(tmpdir(), 'caveman-rules-'));
  const file = join(root, 'skills', 'caveman', 'SKILL.md');
  mkdirSync(join(root, 'skills', 'caveman'), { recursive: true });
  writeFileSync(file, contents);
  return { root, file };
}

function assertRejectedSkillDocument(document) {
  const fixture = createSkillFixture(document);
  try {
    assert.equal(loadSkillBody(fixture.root), null);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

test('bundles the complete caveman skill contract', () => {
  const skill = readFileSync(skillPath, 'utf8');
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);

  assert.ok(frontmatter, 'expected YAML frontmatter');
  assert.match(frontmatter[1], /^name: caveman$/m);
  assert.match(frontmatter[1], /^description:/m);
  for (const mode of modes) {
    assert.match(skill, new RegExp(`^\\| \\*\\*${mode}\\*\\* \\|`, 'm'));
  }

  assert.match(skill, /^## Persistence$/m);
  assert.match(skill, /Preserve user's dominant language/);
  assert.match(skill, /Compress the style, not the language/);
  assert.match(skill, /^## Auto-Clarity$/m);
  assert.match(skill, /Security warnings/);
  assert.match(skill, /Irreversible action confirmations/);
  assert.match(skill, /Compression itself creates technical ambiguity/);
  assert.match(skill, /^## Boundaries$/m);
  assert.match(skill, /Code\/commits\/PRs: write normal/);
  assert.match(skill, /`\/caveman <mode>`/);
  assert.match(skill, /`\$caveman <mode>`/);
});

test('keeps skill metadata and examples consistent with Codex defaults', () => {
  const skill = readFileSync(skillPath, 'utf8');
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);

  assert.ok(frontmatter, 'expected YAML frontmatter');
  assert.match(frontmatter[1], /Codex plugin defaults to wenyan-full/i);
  assert.doesNotMatch(frontmatter[1], /full \(default\)/i);
  assert.doesNotMatch(skill, /\b(?:obj|ref)\b/);
  assert.equal(existsSync(readmePath), false);
});

test('loadSkillBody removes frontmatter and preserves shared rules', () => {
  const body = loadSkillBody(pluginRoot);

  assert.ok(body);
  assert.doesNotMatch(body, /^---$/m);
  assert.doesNotMatch(body, /^name: caveman$/m);
  assert.match(body, /Preserve user's dominant language/);
  assert.match(body, /^## Auto-Clarity$/m);
  assert.match(body, /^## Boundaries$/m);
});

test('keeps only the active intensity row and examples for every mode', () => {
  for (const mode of modes) {
    const output = buildFullContext({ pluginRoot, mode });
    const rows = [...output.matchAll(/^\|\s*\*\*(\S+?)\*\*\s*\|/gm)]
      .map((match) => match[1]);
    const examples = [...output.matchAll(/^- (\S+?):\s/gm)]
      .map((match) => match[1]);

    assert.match(output, new RegExp(`CAVEMAN MODE ACTIVE — level: ${mode}`));
    assert.deepEqual(rows, [mode]);
    assert.ok(examples.length > 0, `expected an example for ${mode}`);
    assert.deepEqual([...new Set(examples)], [mode]);
    assert.doesNotMatch(output, /^---$/m);
    assert.match(output, /This current mode overrides every earlier caveman mode reminder/);
  }
});

test('preserves unrelated bold table rows and colon bullets', () => {
  const fixture = createSkillFixture(skillDocument([
    '## Intensity',
    '| Level | Meaning |',
    '| --- | --- |',
    '| **lite** | active |',
    '| **ultra** | inactive |',
    '| **Guarantee** | shared table content |',
    '- lite: active example',
    '- ultra: inactive example',
    '- Token: preserve exact token metadata',
  ].join('\n')));

  try {
    const output = buildFullContext({ pluginRoot: fixture.root, mode: 'lite' });
    assert.match(output, /^\| \*\*lite\*\* \| active \|$/m);
    assert.doesNotMatch(output, /^\| \*\*ultra\*\* \|/m);
    assert.match(output, /^\| \*\*Guarantee\*\* \| shared table content \|$/m);
    assert.match(output, /^- Token: preserve exact token metadata$/m);
    assert.match(output, /^- lite: active example$/m);
    assert.doesNotMatch(output, /^- ultra: inactive example$/m);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rejects malformed or unbounded frontmatter', () => {
  const fixture = createSkillFixture('placeholder');
  const malformed = [
    'No frontmatter\nUNTRUSTED_BODY',
    '---\nname: caveman\ndescription: missing close\nUNTRUSTED_BODY',
    skillDocument('UNTRUSTED_BODY', ['name: other', 'description: wrong skill']),
    skillDocument('UNTRUSTED_BODY', [
      'name: caveman',
      'name: other',
      'description: duplicate name',
    ]),
    skillDocument('UNTRUSTED_BODY', ['name: caveman']),
    skillDocument('UNTRUSTED_BODY', ['name: caveman', 'description: >']),
    skillDocument('UNTRUSTED_BODY', [
      'name: caveman',
      'description: # comment is not a description',
    ]),
    skillDocument('UNTRUSTED_BODY', [
      'name: caveman',
      'description: bounded metadata',
      `padding: ${'x'.repeat(20 * 1024)}`,
    ]),
  ];

  try {
    for (const [index, document] of malformed.entries()) {
      writeFileSync(fixture.file, document);
      assert.equal(
        loadSkillBody(fixture.root),
        null,
        `malformed frontmatter fixture ${index} must be rejected`,
      );
      const output = buildFullContext({ pluginRoot: fixture.root, mode: 'lite' });
      assert.match(output, /CAVEMAN MODE ACTIVE — level: lite/);
      assert.doesNotMatch(output, /UNTRUSTED_BODY/);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

const strictFrontmatterCases = [
  [
    'quoted description scalar',
    skillDocument('UNTRUSTED_BODY', [
      'name: caveman',
      'description: "quoted descriptions are outside the subset"',
    ]),
  ],
  [
    'quoted name key',
    skillDocument('UNTRUSTED_BODY', [
      '"name": caveman',
      'description: quoted key',
    ]),
  ],
  [
    'quoted description key',
    skillDocument('UNTRUSTED_BODY', [
      'name: caveman',
      '"description": quoted key',
    ]),
  ],
  [
    'duplicate description key',
    skillDocument('UNTRUSTED_BODY', [
      'name: caveman',
      'description: first',
      'description: second',
    ]),
  ],
  [
    'unknown top-level key',
    skillDocument('UNTRUSTED_BODY', [
      'name: caveman',
      'description: known fields only',
      'extra: forbidden',
    ]),
  ],
  [
    'unterminated sequence-like description',
    skillDocument('UNTRUSTED_BODY', [
      'name: caveman',
      'description: [unterminated',
    ]),
  ],
  [
    'unterminated mapping-like description',
    skillDocument('UNTRUSTED_BODY', [
      'name: caveman',
      'description: {unterminated',
    ]),
  ],
  [
    'comment-only block description',
    skillDocument('UNTRUSTED_BODY', [
      'name: caveman',
      'description: >',
      '  # no descriptive content',
      '  # still only comments',
    ]),
  ],
];

for (const [label, document] of strictFrontmatterCases) {
  test(`rejects ${label}`, () => {
    assertRejectedSkillDocument(document);
  });
}

test('rejects mapping syntax in a plain description', () => {
  assertRejectedSkillDocument(skillDocument('UNTRUSTED_BODY', [
    'name: caveman',
    'description: valid: invalid mapping',
  ]));
});

const implicitNonStringDescriptions = [
  'true',
  'TRUE',
  'false',
  'yes',
  'no',
  'on',
  'off',
  'null',
  'NULL',
  '~',
  '123',
  '+123',
  '-123',
  '1.5',
  '1e3',
  '2026-07-11',
  '.nan',
  '.NaN',
  '.inf',
  '+.inf',
  '-.inf',
];

for (const value of implicitNonStringDescriptions) {
  test(`rejects implicit non-string description ${value}`, () => {
    assertRejectedSkillDocument(skillDocument('UNTRUSTED_BODY', [
      'name: caveman',
      `description: ${value}`,
    ]));
  });
}

test('rejects empty and whitespace-only skill bodies', () => {
  const header = '---\nname: caveman\ndescription: valid description\n---\n';
  for (const body of ['', '\n', '\n  \t\n']) {
    assertRejectedSkillDocument(`${header}${body}`);
  }
});

test('normalizes valid CRLF skill documents to LF', () => {
  const lfDocument = skillDocument('## Rules\nSAFE_BODY', [
    '# leading comment',
    '',
    'name: caveman',
    '',
    'description: >',
    '  # block comment before content',
    '',
    '  Useful mode rules.',
    '# trailing comment',
  ]);
  const crlfDocument = lfDocument.replace(/\n/g, '\r\n');
  const lfFixture = createSkillFixture(lfDocument);
  const crlfFixture = createSkillFixture(crlfDocument);

  try {
    const lfBody = loadSkillBody(lfFixture.root);
    const crlfBody = loadSkillBody(crlfFixture.root);
    assert.match(lfBody, /SAFE_BODY/);
    assert.equal(crlfBody, lfBody);
    assert.doesNotMatch(crlfBody, /\r/);
  } finally {
    rmSync(lfFixture.root, { recursive: true, force: true });
    rmSync(crlfFixture.root, { recursive: true, force: true });
  }
});

test('rejects a lone carriage return after CRLF normalization', () => {
  assertRejectedSkillDocument(skillDocument('SAFE\rUNTRUSTED_BODY'));
});

test('rejects invalid UTF-8 instead of decoding replacement characters', () => {
  const prefix = Buffer.from(skillDocument('VALID_BODY').replace('VALID_BODY\n', ''));
  const fixture = createSkillFixture(Buffer.concat([prefix, Buffer.from([0xff]), Buffer.from('\n')]));

  try {
    assert.equal(loadSkillBody(fixture.root), null);
    const output = buildFullContext({ pluginRoot: fixture.root, mode: 'full' });
    assert.match(output, /CAVEMAN MODE ACTIVE — level: full/);
    assert.doesNotMatch(output, /�/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('reads the opened descriptor when the final path is swapped to a symlink', () => {
  const safe = skillDocument('SAFE_MARKER');
  const unsafe = skillDocument('UNSAFE_SYMLINK_TARGET');
  const fixture = createSkillFixture(safe);
  const originalPath = `${fixture.file}.original`;
  const unsafePath = join(fixture.root, 'unsafe-skill.md');
  writeFileSync(unsafePath, unsafe);

  const originalOpen = fs.openSync;
  const originalReadFile = fs.readFileSync;
  let swapped = false;
  let openFlags = null;
  function swapFinalComponent() {
    if (swapped) return;
    renameSync(fixture.file, originalPath);
    symlinkSync(unsafePath, fixture.file);
    swapped = true;
  }
  fs.openSync = function swappingOpen(candidate, flags, ...args) {
    const fd = originalOpen(candidate, flags, ...args);
    if (candidate === fixture.file) {
      openFlags = flags;
      swapFinalComponent();
    }
    return fd;
  };
  fs.readFileSync = function swappingRead(candidate, ...args) {
    if (candidate === fixture.file) swapFinalComponent();
    return originalReadFile(candidate, ...args);
  };

  try {
    const body = loadSkillBody(fixture.root);
    assert.equal(swapped, true);
    assert.match(body, /SAFE_MARKER/);
    assert.doesNotMatch(body, /UNSAFE_SYMLINK_TARGET/);
    if (fs.constants.O_NOFOLLOW) {
      assert.notEqual(openFlags & fs.constants.O_NOFOLLOW, 0);
    }
  } finally {
    fs.openSync = originalOpen;
    fs.readFileSync = originalReadFile;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('canonicalizes aliases in every public renderer', () => {
  const outputs = [
    buildFullContext({ pluginRoot, mode: ' WENYAN ' }),
    buildReminder(' WENYAN '),
    buildContextForMode({ pluginRoot, mode: ' WENYAN ' }),
  ];

  for (const output of outputs) {
    assert.match(output, /(?:level:|CURRENT MODE:) wenyan-full/);
    assert.doesNotMatch(output, /(?:level:|CURRENT MODE:)\s+wenyan(?:\s|\.|$)/);
  }
});

test('routes off, unknown, and non-string renderer inputs safely to off', () => {
  const invalidModes = ['off', 'unknown', '', null, undefined, 1, {}, []];

  for (const mode of invalidModes) {
    const outputs = [
      buildFullContext({ pluginRoot, mode }),
      buildReminder(mode),
      buildContextForMode({ pluginRoot, mode }),
    ];
    for (const output of outputs) {
      assert.match(output, /CURRENT MODE: off/);
      assert.match(output, /Use normal prose/);
      assert.doesNotMatch(output, /MODE ACTIVE/);
    }
  }
});

test('returns fallback rules when SKILL.md is unavailable', () => {
  const missingRoot = join(tmpdir(), `missing-caveman-plugin-${process.pid}`);
  const output = buildFullContext({ pluginRoot: missingRoot, mode: 'lite' });

  assert.match(output, /CAVEMAN MODE ACTIVE — level: lite/);
  assert.match(output, /Technical terms, code, commands, and error text remain exact/);
  assert.match(output, /security warnings, irreversible confirmations/);
  assert.match(output, /overrides every earlier caveman mode reminder/);
});

test('falls back for symbolic-link and oversized skill files', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'caveman-rules-'));
  const skillDirectory = join(temporaryRoot, 'skills', 'caveman');
  const externalSkill = join(temporaryRoot, 'external.md');
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(externalSkill, 'unsafe');
  symlinkSync(externalSkill, join(skillDirectory, 'SKILL.md'));

  try {
    assert.equal(loadSkillBody(temporaryRoot), null);
    rmSync(join(skillDirectory, 'SKILL.md'));
    writeFileSync(join(skillDirectory, 'SKILL.md'), 'x'.repeat(MAX_SKILL_BYTES + 1));
    assert.equal(loadSkillBody(temporaryRoot), null);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('builds authoritative active and off reminders', () => {
  assert.match(buildReminder('lite'), /CURRENT MODE: lite/);
  assert.match(buildReminder('lite'), /Preserve technical facts, code, commands, symbols/);
  assert.match(buildReminder('lite'), /auto-clarity exceptions/);
  assert.match(buildReminder('lite'), /overrides earlier caveman mode context/);
  assert.match(buildOffReminder(), /CURRENT MODE: off/);
  assert.match(buildOffReminder(), /Use normal prose/);
  assert.match(buildOffReminder(), /overrides earlier caveman mode context/);
});

test('routes off through the off reminder instead of active rules', () => {
  const output = buildContextForMode({ pluginRoot, mode: 'off' });

  assert.match(output, /CURRENT MODE: off/);
  assert.match(output, /Use normal prose/);
  assert.doesNotMatch(output, /MODE ACTIVE/);
});
