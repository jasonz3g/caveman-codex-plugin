'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} = fs;
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
  MAX_STATE_BYTES,
  createStateStore,
  stateKey,
} = require('../lib/state-store.cjs');
const { MAX_PROMPT_BYTES } = require('../lib/prompt-parser.cjs');
const {
  handleUserPromptSubmit,
} = require('../hooks/user-prompt-submit.cjs');

const STATE_UNAVAILABLE_MESSAGE =
  'Caveman session state is unavailable. Caveman mode is off for this turn; this hook did not overwrite stored state.';
const MODE_NOT_PERSISTED_MESSAGE =
  'Caveman could not persist the selected mode. The selected mode applies to this turn only.';
const FIXTURE_SKILL = `---
name: caveman
description: Caveman prompt fixture
---
# Caveman

| Mode | Rule |
| --- | --- |
| **lite** | Lite prompt rule |
| **full** | Full prompt rule |
| **ultra** | Ultra prompt rule |
| **wenyan-lite** | Wenyan lite prompt rule |
| **wenyan-full** | Wenyan full prompt rule |
| **wenyan-ultra** | Wenyan ultra prompt rule |

- lite: Lite prompt example
- full: Full prompt example
- ultra: Ultra prompt example
- wenyan-lite: Wenyan lite prompt example
- wenyan-full: Wenyan full prompt example
- wenyan-ultra: Wenyan ultra prompt example
`;

function found(mode) {
  return { kind: 'found', mode };
}

function context(output) {
  return output.hookSpecificOutput.additionalContext;
}

function assertReminder(output, mode) {
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(context(output), new RegExp(`CAVEMAN CURRENT MODE: ${mode}`));
  assert.doesNotMatch(context(output), /MODE ACTIVE/);
  if (mode === 'off') assert.match(context(output), /Use normal prose/);
}

function assertFullMode(output, mode) {
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  if (mode === 'off') {
    assertReminder(output, 'off');
    assert.doesNotMatch(context(output), /prompt rule|prompt example/i);
  } else {
    assert.match(context(output), new RegExp(`CAVEMAN MODE ACTIVE — level: ${mode}`));
    assert.doesNotMatch(context(output), /CURRENT MODE: off/);
  }
}

function sameIdentity(actual, expected) {
  assert.equal(actual.dev, expected.dev);
  assert.equal(actual.ino, expected.ino);
}

function assertPrivateValuesAbsent(value, secrets, label) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (let index = 0; index < secrets.length; index += 1) {
    if (serialized.includes(secrets[index])) {
      assert.fail(`${label} exposed private value at index ${index}`);
    }
  }
}

function createHarness() {
  const root = mkdtempSync(join(tmpdir(), 'caveman-user-prompt-'));
  const pluginRoot = join(root, 'plugin');
  const dataDir = join(root, 'data');
  const homeDir = join(root, 'home');
  const cwd = join(root, 'repo');
  mkdirSync(join(pluginRoot, 'skills', 'caveman'), { recursive: true });
  mkdirSync(homeDir);
  mkdirSync(cwd);
  writeFileSync(join(pluginRoot, 'skills', 'caveman', 'SKILL.md'), FIXTURE_SKILL);

  const env = {
    CAVEMAN_DEFAULT_MODE: 'wenyan-full',
    HOME: homeDir,
    PLUGIN_DATA: dataDir,
    PLUGIN_ROOT: pluginRoot,
  };
  const store = createStateStore(dataDir);
  const event = (prompt, overrides = {}) => ({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'prompt-session',
    cwd,
    prompt,
    ...overrides,
  });
  const statePath = join(
    realpathSync(dataDir),
    'sessions',
    `${stateKey('prompt-session')}.json`,
  );

  return {
    root,
    pluginRoot,
    dataDir,
    homeDir,
    cwd,
    env,
    store,
    event,
    statePath,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function withHarness(run) {
  const harness = createHarness();
  try {
    return run(harness);
  } finally {
    harness.cleanup();
  }
}

test('recognized command persists canonical mode and injects full rules', () => {
  withHarness(({ env, event, store }) => {
    assert.equal(store.write('prompt-session', 'wenyan-full'), true);

    const output = handleUserPromptSubmit(event('/caveman lite'), env);

    assert.deepEqual(store.read('prompt-session'), found('lite'));
    assertFullMode(output, 'lite');
    assert.match(context(output), /Lite prompt rule/);
    assert.match(context(output), /Acknowledge this mode change in one short line/);
    assert.equal(output.systemMessage, undefined);
  });
});

test('supported English commands persist their canonical mode', () => {
  withHarness(({ env, event, store }) => {
    const output = handleUserPromptSubmit(
      event('Please enable caveman ultra mode'),
      env,
    );

    assert.deepEqual(store.read('prompt-session'), found('ultra'));
    assertFullMode(output, 'ultra');
    assert.match(context(output), /Ultra prompt rule/);
  });
});

test('Chinese activation and switching persist canonical modes', () => {
  withHarness(({ env, event, store }) => {
    const activated = handleUserPromptSubmit(event('启用 caveman'), env);
    assert.deepEqual(store.read('prompt-session'), found('wenyan-full'));
    assertFullMode(activated, 'wenyan-full');

    const switched = handleUserPromptSubmit(
      event('切换到 caveman 极简文言'),
      env,
    );
    assert.deepEqual(store.read('prompt-session'), found('wenyan-ultra'));
    assertFullMode(switched, 'wenyan-ultra');
  });
});

test('ordinary prompt reinforces active state without rewriting it', () => {
  withHarness(({ env, event, store, statePath }) => {
    assert.equal(store.write('prompt-session', 'ultra'), true);
    const beforeBody = readFileSync(statePath);
    const beforeStat = statSync(statePath);

    const output = handleUserPromptSubmit(event('Explain ownership'), env);

    assert.deepEqual(store.read('prompt-session'), found('ultra'));
    assert.deepEqual(readFileSync(statePath), beforeBody);
    sameIdentity(statSync(statePath), beforeStat);
    assertReminder(output, 'ultra');
    assert.doesNotMatch(context(output), /Ultra prompt rule/);
    assert.equal(output.systemMessage, undefined);
  });
});

test('ordinary prompt preserves authoritative off state without rewriting it', () => {
  withHarness(({ env, event, store, statePath }) => {
    assert.equal(store.write('prompt-session', 'off'), true);
    const beforeBody = readFileSync(statePath);
    const beforeStat = statSync(statePath);

    const output = handleUserPromptSubmit(event('Explain ownership'), env);

    assert.deepEqual(store.read('prompt-session'), found('off'));
    assert.deepEqual(readFileSync(statePath), beforeBody);
    sameIdentity(statSync(statePath), beforeStat);
    assertReminder(output, 'off');
    assert.equal(output.systemMessage, undefined);
  });
});

test('ordinary prompt initializes confirmed missing state to the effective default', () => {
  withHarness(({ env, event, store }) => {
    assert.deepEqual(store.read('prompt-session'), { kind: 'missing' });

    const output = handleUserPromptSubmit(event('Explain ownership'), env);

    assert.deepEqual(store.read('prompt-session'), found('wenyan-full'));
    assertReminder(output, 'wenyan-full');
    assert.equal(output.systemMessage, undefined);
  });
});

test('ordinary prompt fails closed when missing-state publication fails', () => {
  withHarness(({ env, event, store, statePath, dataDir }) => {
    const originalLink = fs.linkSync;
    let injected = false;
    fs.linkSync = function failPublication(sourcePath, destinationPath) {
      if (destinationPath === statePath) {
        injected = true;
        throw Object.assign(new Error('private publication detail'), {
          code: 'EIO',
        });
      }
      return originalLink(sourcePath, destinationPath);
    };
    let output;
    try {
      output = handleUserPromptSubmit(event('ordinary publication check'), env);
    } finally {
      fs.linkSync = originalLink;
    }

    assertPrivateValuesAbsent(
      output,
      ['ordinary publication check', 'private publication detail'],
      'handler output',
    );
    assert.equal(injected, true);
    assertReminder(output, 'off');
    assert.equal(output.systemMessage, STATE_UNAVAILABLE_MESSAGE);
    assert.deepEqual(store.read('prompt-session'), { kind: 'missing' });
    assert.equal(existsSync(statePath), false);
    assert.deepEqual(readdirSync(join(realpathSync(dataDir), 'sessions')), []);
  });
});

test('ordinary prompt honors a concurrent off initialization winner', () => {
  withHarness(({ env, event, store, statePath }) => {
    const originalLink = fs.linkSync;
    let interleaved = false;
    fs.linkSync = function installOffWinner(sourcePath, destinationPath) {
      if (destinationPath === statePath && !interleaved) {
        interleaved = true;
        assert.equal(store.write('prompt-session', 'off'), true);
      }
      return originalLink(sourcePath, destinationPath);
    };
    let output;
    try {
      output = handleUserPromptSubmit(event('Explain ownership'), env);
    } finally {
      fs.linkSync = originalLink;
    }

    assert.equal(interleaved, true);
    assert.deepEqual(store.read('prompt-session'), found('off'));
    assertReminder(output, 'off');
    assert.equal(output.systemMessage, undefined);
  });
});

test('ordinary prompt fails closed for malformed and unsafe state records', () => {
  const cases = [
    {
      name: 'malformed',
      install({ statePath }) { writeFileSync(statePath, '{'); },
      verify({ statePath }) { assert.equal(readFileSync(statePath, 'utf8'), '{'); },
    },
    {
      name: 'oversized',
      install({ statePath }) { writeFileSync(statePath, Buffer.alloc(MAX_STATE_BYTES + 1, 0x78)); },
      verify({ statePath }) { assert.equal(statSync(statePath).size, MAX_STATE_BYTES + 1); },
    },
    {
      name: 'symlink',
      install(harness) {
        const target = join(harness.root, 'state-target');
        writeFileSync(target, 'do not replace');
        harness.unsafeTarget = target;
        symlinkSync(target, harness.statePath);
      },
      verify({ statePath, unsafeTarget }) {
        assert.equal(lstatSync(statePath).isSymbolicLink(), true);
        assert.equal(readFileSync(unsafeTarget, 'utf8'), 'do not replace');
      },
    },
    {
      name: 'nonregular',
      install({ statePath }) { mkdirSync(statePath); },
      verify({ statePath }) { assert.equal(lstatSync(statePath).isDirectory(), true); },
    },
  ];

  for (const fixture of cases) {
    withHarness((harness) => {
      fixture.install(harness);

      const output = handleUserPromptSubmit(
        harness.event(`ordinary-${fixture.name}`),
        harness.env,
      );

      assert.deepEqual(harness.store.read('prompt-session'), { kind: 'unavailable' });
      assertReminder(output, 'off');
      assert.equal(output.systemMessage, STATE_UNAVAILABLE_MESSAGE);
      fixture.verify(harness);
    });
  }
});

test('transient read failure over stored off fails closed without rewriting it', () => {
  withHarness(({ env, event, store, statePath }) => {
    assert.equal(store.write('prompt-session', 'off'), true);
    const beforeBody = readFileSync(statePath);
    const beforeStat = statSync(statePath);
    const originalOpen = fs.openSync;
    let injected = false;
    fs.openSync = function failStateReadOnce(candidate, ...args) {
      if (candidate === statePath && !injected) {
        injected = true;
        throw Object.assign(new Error('private injected detail'), { code: 'EIO' });
      }
      return originalOpen(candidate, ...args);
    };
    let output;
    try {
      output = handleUserPromptSubmit(event('ordinary transient check'), env);
    } finally {
      fs.openSync = originalOpen;
    }

    assertPrivateValuesAbsent(
      output,
      ['ordinary transient check', 'private injected detail'],
      'handler output',
    );
    assert.equal(injected, true);
    assertReminder(output, 'off');
    assert.equal(output.systemMessage, STATE_UNAVAILABLE_MESSAGE);
    assert.deepEqual(store.read('prompt-session'), found('off'));
    assert.deepEqual(readFileSync(statePath), beforeBody);
    sameIdentity(statSync(statePath), beforeStat);
  });
});

test('configured off initializes and preserves off state', () => {
  withHarness(({ env, event, store, statePath }) => {
    const offEnv = { ...env, CAVEMAN_DEFAULT_MODE: 'off' };

    const initialized = handleUserPromptSubmit(event('ordinary first'), offEnv);
    const beforeBody = readFileSync(statePath);
    const beforeStat = statSync(statePath);
    const preserved = handleUserPromptSubmit(event('ordinary second'), offEnv);

    assert.deepEqual(store.read('prompt-session'), found('off'));
    assertReminder(initialized, 'off');
    assertReminder(preserved, 'off');
    assert.deepEqual(readFileSync(statePath), beforeBody);
    sameIdentity(statSync(statePath), beforeStat);
  });
});

test('stateless ordinary prompt uses configured off without attempting persistence', () => {
  withHarness(({ env, event, store }) => {
    const statelessEnv = { ...env, CAVEMAN_DEFAULT_MODE: 'off' };
    delete statelessEnv.PLUGIN_DATA;

    const output = handleUserPromptSubmit(event('ordinary stateless'), statelessEnv);

    assertReminder(output, 'off');
    assert.equal(output.systemMessage, undefined);
    assert.deepEqual(store.read('prompt-session'), { kind: 'missing' });
  });
});

test('unknown, oversized, and inexact intents preserve existing state', () => {
  withHarness(({ env, event, store, statePath }) => {
    assert.equal(store.write('prompt-session', 'lite'), true);
    const beforeBody = readFileSync(statePath);
    const beforeStat = statSync(statePath);
    const prompts = [
      '/caveman commit',
      'x'.repeat(MAX_PROMPT_BYTES + 1),
      '/caveman lite now',
    ];

    for (const prompt of prompts) {
      const output = handleUserPromptSubmit(event(prompt), env);
      assertReminder(output, 'lite');
      assert.equal(output.systemMessage, undefined);
    }
    assert.deepEqual(store.read('prompt-session'), found('lite'));
    assert.deepEqual(readFileSync(statePath), beforeBody);
    sameIdentity(statSync(statePath), beforeStat);
  });
});

test('stateful active to off to active sequence persists every transition', () => {
  withHarness(({ env, event, store }) => {
    const active = handleUserPromptSubmit(event('/caveman lite'), env);
    assertFullMode(active, 'lite');
    assert.deepEqual(store.read('prompt-session'), found('lite'));
    assertReminder(handleUserPromptSubmit(event('ordinary one'), env), 'lite');

    const off = handleUserPromptSubmit(event('stop caveman'), env);
    assertFullMode(off, 'off');
    assert.match(context(off), /Acknowledge this mode change in one short line/);
    assert.deepEqual(store.read('prompt-session'), found('off'));
    assertReminder(handleUserPromptSubmit(event('ordinary two'), env), 'off');

    const activeAgain = handleUserPromptSubmit(
      event('/caveman wenyan-ultra'),
      env,
    );
    assertFullMode(activeAgain, 'wenyan-ultra');
    assert.deepEqual(store.read('prompt-session'), found('wenyan-ultra'));
    assertReminder(
      handleUserPromptSubmit(event('ordinary three'), env),
      'wenyan-ultra',
    );
  });
});

test('explicit transition replaces malformed regular state without reading it first', () => {
  withHarness(({ env, event, store, statePath }) => {
    writeFileSync(statePath, '{');
    const malformedStat = statSync(statePath);
    const originalOpen = fs.openSync;
    let malformedReads = 0;
    fs.openSync = function rejectTargetRead(candidate, flags, ...args) {
      if (candidate === statePath && (flags & fs.constants.O_ACCMODE) === fs.constants.O_RDONLY) {
        const current = fs.lstatSync(candidate);
        if (
          current.dev === malformedStat.dev &&
          current.ino === malformedStat.ino
        ) {
          malformedReads += 1;
          throw new Error('transition must not read old state');
        }
      }
      return originalOpen(candidate, flags, ...args);
    };
    let output;
    try {
      output = handleUserPromptSubmit(event('/caveman full'), env);
    } finally {
      fs.openSync = originalOpen;
    }

    assert.equal(malformedReads, 0);
    assert.deepEqual(store.read('prompt-session'), found('full'));
    assertFullMode(output, 'full');
    assert.equal(output.systemMessage, undefined);
  });
});

test('explicit transition applies for this turn when an unsafe root prevents persistence', () => {
  withHarness(({ root, env, event }) => {
    const realData = join(root, 'real-data');
    const linkedData = join(root, 'linked-data');
    mkdirSync(realData);
    symlinkSync(realData, linkedData, 'dir');
    const unsafeEnv = { ...env, PLUGIN_DATA: linkedData };
    const secretPrompt = '/caveman lite';

    const output = handleUserPromptSubmit(event(secretPrompt), unsafeEnv);

    assertPrivateValuesAbsent(output, [secretPrompt, root], 'handler output');
    assertFullMode(output, 'lite');
    assert.match(
      context(output),
      /Acknowledge in one short line that this mode applies to this turn only/,
    );
    assert.equal(output.systemMessage, MODE_NOT_PERSISTED_MESSAGE);
    assert.deepEqual(readdirSync(realData), []);
  });
});

test('explicit transition applies for this turn when an atomic write fails', () => {
  withHarness(({ env, event, store, statePath }) => {
    const originalRename = fs.renameSync;
    let injected = false;
    fs.renameSync = function failPublication(sourcePath, destinationPath) {
      if (destinationPath === statePath) {
        injected = true;
        throw new Error('private write failure detail');
      }
      return originalRename(sourcePath, destinationPath);
    };
    let output;
    try {
      output = handleUserPromptSubmit(event('/caveman ultra'), env);
    } finally {
      fs.renameSync = originalRename;
    }

    assertPrivateValuesAbsent(
      output,
      ['/caveman ultra', 'private write failure detail'],
      'handler output',
    );
    assert.equal(injected, true);
    assertFullMode(output, 'ultra');
    assert.match(
      context(output),
      /Acknowledge in one short line that this mode applies to this turn only/,
    );
    assert.equal(output.systemMessage, MODE_NOT_PERSISTED_MESSAGE);
    assert.deepEqual(store.read('prompt-session'), { kind: 'missing' });
    assert.equal(existsSync(statePath), false);
  });
});

test('stateless transition applies only this turn then returns to configured off', () => {
  withHarness(({ env, event, store }) => {
    const statelessEnv = { ...env, CAVEMAN_DEFAULT_MODE: 'off' };
    delete statelessEnv.PLUGIN_DATA;

    const transition = handleUserPromptSubmit(
      event('Please activate caveman lite mode'),
      statelessEnv,
    );
    const ordinary = handleUserPromptSubmit(
      event('ordinary after transition'),
      statelessEnv,
    );

    assertFullMode(transition, 'lite');
    assert.equal(transition.systemMessage, MODE_NOT_PERSISTED_MESSAGE);
    assert.match(context(transition), /applies to this turn only/);
    assertReminder(ordinary, 'off');
    assert.equal(ordinary.systemMessage, undefined);
    assert.deepEqual(store.read('prompt-session'), { kind: 'missing' });
  });
});

test('explicit off renders only authoritative off context', () => {
  withHarness(({ env, event, store }) => {
    assert.equal(store.write('prompt-session', 'lite'), true);

    const output = handleUserPromptSubmit(event('/caveman off'), env);

    assert.deepEqual(store.read('prompt-session'), found('off'));
    assertFullMode(output, 'off');
    assert.match(context(output), /Acknowledge this mode change in one short line/);
    assert.doesNotMatch(context(output), /Lite prompt rule|MODE ACTIVE/);
  });
});

test('malformed and unsupported events are no-ops without state mutation', () => {
  withHarness(({ cwd, env, event, store, statePath }) => {
    assert.equal(store.write('prompt-session', 'lite'), true);
    const beforeBody = readFileSync(statePath);
    const beforeStat = statSync(statePath);
    const arrayEvent = Object.assign([], event('/caveman off'));
    const invalidEvents = [
      null,
      arrayEvent,
      'event',
      1,
      {},
      { ...event('/caveman off'), hook_event_name: undefined },
      { ...event('/caveman off'), hook_event_name: 'SessionStart' },
      { ...event('/caveman off'), session_id: '' },
      { ...event('/caveman off'), session_id: 7 },
      { ...event('/caveman off'), session_id: 'x'.repeat(4097) },
      { ...event('/caveman off'), cwd: '' },
      { ...event('/caveman off'), cwd: 7 },
      { ...event('/caveman off'), prompt: undefined },
      { ...event('/caveman off'), prompt: 7 },
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'prompt-session',
        cwd,
      },
    ];

    for (const invalidEvent of invalidEvents) {
      assert.equal(handleUserPromptSubmit(invalidEvent, env), null);
    }
    assert.deepEqual(store.read('prompt-session'), found('lite'));
    assert.deepEqual(readFileSync(statePath), beforeBody);
    sameIdentity(statSync(statePath), beforeStat);
  });
});

test('handler never returns or persists prompt, session id, paths, or exception details', () => {
  withHarness(({ env, event, store, statePath, root }) => {
    const prompt = '/caveman wenyan-lite';
    const sessionId = 'prompt-session';

    const output = handleUserPromptSubmit(event(prompt), env);
    const serialized = JSON.stringify(output);
    const persisted = readFileSync(statePath, 'utf8');

    assertPrivateValuesAbsent(
      serialized,
      [prompt, sessionId, root],
      'handler output',
    );
    assertPrivateValuesAbsent(
      persisted,
      [prompt, sessionId, root],
      'persisted state',
    );
    assert.deepEqual(store.read(sessionId), found('wenyan-lite'));
  });
});
