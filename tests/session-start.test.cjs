'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} = fs;
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const {
  createStateStore,
  stateKey,
} = require('../lib/state-store.cjs');
const { handleSessionStart } = require('../hooks/session-start.cjs');

const STATE_UNAVAILABLE_MESSAGE =
  'Caveman session state is unavailable. Caveman mode is off for this turn; this hook did not overwrite stored state.';
const MODE_NOT_PERSISTED_MESSAGE =
  'Caveman could not persist the selected mode. The selected mode applies to this turn only.';
const FIXTURE_SKILL = `---
name: caveman
description: Caveman test fixture
---
# Caveman

| Mode | Rule |
| --- | --- |
| **lite** | Lite rule |
| **full** | Full rule |
| **ultra** | Ultra rule |
| **wenyan-lite** | Wenyan lite rule |
| **wenyan-full** | Wenyan full rule |
| **wenyan-ultra** | Wenyan ultra rule |

- lite: Lite example
- full: Full example
- ultra: Ultra example
- wenyan-lite: Wenyan lite example
- wenyan-full: Wenyan full example
- wenyan-ultra: Wenyan ultra example
`;

function found(mode) {
  return { kind: 'found', mode };
}

function outputContext(output) {
  return output.hookSpecificOutput.additionalContext;
}

function assertMode(output, mode) {
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  if (mode === 'off') {
    assert.match(outputContext(output), /CAVEMAN CURRENT MODE: off/);
    assert.doesNotMatch(outputContext(output), /MODE ACTIVE/);
  } else {
    assert.match(outputContext(output), new RegExp(`level: ${mode}`));
    assert.doesNotMatch(outputContext(output), /CURRENT MODE: off/);
  }
}

function createHarness() {
  const root = mkdtempSync(join(tmpdir(), 'caveman-session-start-'));
  const pluginRoot = join(root, 'plugin');
  const dataDir = join(root, 'data');
  const homeDir = join(root, 'home');
  const cwd = join(root, 'repo');
  mkdirSync(join(pluginRoot, 'skills', 'caveman'), { recursive: true });
  mkdirSync(homeDir);
  mkdirSync(cwd);
  writeFileSync(join(pluginRoot, 'skills', 'caveman', 'SKILL.md'), FIXTURE_SKILL);

  const env = {
    HOME: homeDir,
    PLUGIN_DATA: dataDir,
    PLUGIN_ROOT: pluginRoot,
  };
  const store = createStateStore(dataDir);
  const event = (source, sessionId = 'session-a') => ({
    hook_event_name: 'SessionStart',
    session_id: sessionId,
    cwd,
    source,
  });

  return {
    root,
    pluginRoot,
    dataDir,
    homeDir,
    cwd,
    env,
    store,
    event,
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

test('startup resets the session to the configured default', () => {
  withHarness(({ env, event, store }) => {
    assert.equal(store.write('session-a', 'lite'), true);

    const output = handleSessionStart(event('startup'), env);

    assert.deepEqual(store.read('session-a'), found('wenyan-full'));
    assertMode(output, 'wenyan-full');
    assert.equal(output.systemMessage, undefined);
  });
});

test('clear resets the session to the configured default without pruning', () => {
  withHarness(({ env, event, store }) => {
    assert.equal(store.write('session-a', 'ultra'), true);
    const staleId = 'stale-on-clear';
    assert.equal(
      store.write(staleId, 'lite', new Date(0)),
      true,
    );

    const output = handleSessionStart(event('clear'), env);

    assert.deepEqual(store.read('session-a'), found('wenyan-full'));
    assert.deepEqual(store.read(staleId), found('lite'));
    assertMode(output, 'wenyan-full');
    assert.equal(output.systemMessage, undefined);
  });
});

test('resume and compact preserve an existing active mode', () => {
  for (const source of ['resume', 'compact']) {
    withHarness(({ env, event, store }) => {
      assert.equal(store.write('session-a', 'lite'), true);

      const output = handleSessionStart(event(source), env);

      assert.deepEqual(store.read('session-a'), found('lite'));
      assertMode(output, 'lite');
      assert.equal(output.systemMessage, undefined);
    });
  }
});

test('resume and compact preserve active state when the configured default is off', () => {
  for (const source of ['resume', 'compact']) {
    withHarness(({ env, event, store }) => {
      assert.equal(store.write('session-a', 'ultra'), true);

      const output = handleSessionStart(
        event(source),
        { ...env, CAVEMAN_DEFAULT_MODE: 'off' },
      );

      assert.deepEqual(store.read('session-a'), found('ultra'));
      assertMode(output, 'ultra');
      assert.equal(output.systemMessage, undefined);
    });
  }
});

test('resume and compact preserve an existing off mode', () => {
  for (const source of ['resume', 'compact']) {
    withHarness(({ env, event, store }) => {
      assert.equal(store.write('session-a', 'off'), true);

      const output = handleSessionStart(event(source), env);

      assert.deepEqual(store.read('session-a'), found('off'));
      assertMode(output, 'off');
      assert.equal(output.systemMessage, undefined);
    });
  }
});

test('resume and compact initialize a confirmed missing session', () => {
  for (const source of ['resume', 'compact']) {
    withHarness(({ env, event, store }) => {
      assert.deepEqual(store.read('session-a'), { kind: 'missing' });

      const output = handleSessionStart(event(source), env);

      assert.deepEqual(store.read('session-a'), found('wenyan-full'));
      assertMode(output, 'wenyan-full');
      assert.equal(output.systemMessage, undefined);
    });
  }
});

test('resume and compact fail closed when missing-state publication fails', () => {
  for (const source of ['resume', 'compact']) {
    withHarness(({ dataDir, env, event, store }) => {
      const sessionsDir = join(realpathSync(dataDir), 'sessions');
      const statePath = join(sessionsDir, `${stateKey('session-a')}.json`);
      const originalLink = fs.linkSync;
      let injected = false;
      fs.linkSync = function failPublication(sourcePath, destinationPath) {
        if (destinationPath === statePath) {
          injected = true;
          throw Object.assign(new Error('simulated publication failure'), {
            code: 'EIO',
          });
        }
        return originalLink(sourcePath, destinationPath);
      };
      let output;
      try {
        output = handleSessionStart(event(source), env);
      } finally {
        fs.linkSync = originalLink;
      }

      assert.equal(injected, true);
      assertMode(output, 'off');
      assert.equal(output.systemMessage, STATE_UNAVAILABLE_MESSAGE);
      assert.deepEqual(store.read('session-a'), { kind: 'missing' });
      assert.equal(existsSync(statePath), false);
      assert.deepEqual(readdirSync(sessionsDir), []);
    });
  }
});

test('resume and compact honor a concurrent off initialization winner', () => {
  for (const source of ['resume', 'compact']) {
    withHarness(({ dataDir, env, event, store }) => {
      const statePath = join(
        realpathSync(dataDir),
        'sessions',
        `${stateKey('session-a')}.json`,
      );
      const originalLink = fs.linkSync;
      let interleaved = false;
      fs.linkSync = function installOffWinner(sourcePath, destinationPath) {
        if (destinationPath === statePath && !interleaved) {
          interleaved = true;
          assert.equal(store.write('session-a', 'off'), true);
        }
        return originalLink(sourcePath, destinationPath);
      };
      let output;
      try {
        output = handleSessionStart(event(source), env);
      } finally {
        fs.linkSync = originalLink;
      }

      assert.equal(interleaved, true);
      assert.deepEqual(store.read('session-a'), found('off'));
      assertMode(output, 'off');
      assert.equal(output.systemMessage, undefined);
    });
  }
});

test('resume and compact fail closed for unavailable state without overwriting it', () => {
  for (const source of ['resume', 'compact']) {
    withHarness(({ dataDir, env, event, store }) => {
      const statePath = join(
        dataDir,
        'sessions',
        `${stateKey('session-a')}.json`,
      );
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, '{');

      const output = handleSessionStart(event(source), env);

      assert.deepEqual(store.read('session-a'), { kind: 'unavailable' });
      assert.equal(readFileSync(statePath, 'utf8'), '{');
      assertMode(output, 'off');
      assert.equal(output.systemMessage, STATE_UNAVAILABLE_MESSAGE);
    });
  }
});

test('a transient read error over stored off fails closed and preserves the record', () => {
  withHarness(({ dataDir, env, event, store }) => {
    assert.equal(store.write('session-a', 'off'), true);
    const statePath = join(
      realpathSync(dataDir),
      'sessions',
      `${stateKey('session-a')}.json`,
    );
    const beforeBody = readFileSync(statePath);
    const beforeStat = statSync(statePath);
    const originalOpen = fs.openSync;
    let injected = false;
    fs.openSync = function failStateReadOnce(candidate, ...args) {
      if (candidate === statePath && !injected) {
        injected = true;
        throw Object.assign(new Error('simulated EIO'), { code: 'EIO' });
      }
      return originalOpen(candidate, ...args);
    };
    let output;
    try {
      output = handleSessionStart(event('resume'), env);
    } finally {
      fs.openSync = originalOpen;
    }

    assert.equal(injected, true);
    assertMode(output, 'off');
    assert.equal(output.systemMessage, STATE_UNAVAILABLE_MESSAGE);
    assert.deepEqual(store.read('session-a'), found('off'));
    assert.deepEqual(readFileSync(statePath), beforeBody);
    const afterStat = statSync(statePath);
    assert.equal(afterStat.dev, beforeStat.dev);
    assert.equal(afterStat.ino, beforeStat.ino);
  });
});

test('configured off is authoritative for every source with persistent state', () => {
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    withHarness(({ env, event, store }) => {
      const offEnv = { ...env, CAVEMAN_DEFAULT_MODE: 'off' };

      const output = handleSessionStart(event(source), offEnv);

      assert.deepEqual(store.read('session-a'), found('off'));
      assertMode(output, 'off');
      assert.equal(output.systemMessage, undefined);
    });
  }
});

test('startup and clear explicitly replace stored off with an active default', () => {
  for (const source of ['startup', 'clear']) {
    withHarness(({ env, event, store }) => {
      assert.equal(store.write('session-a', 'off'), true);

      const output = handleSessionStart(
        event(source),
        { ...env, CAVEMAN_DEFAULT_MODE: 'lite' },
      );

      assert.deepEqual(store.read('session-a'), found('lite'));
      assertMode(output, 'lite');
      assert.equal(output.systemMessage, undefined);
    });
  }
});

test('configured off is authoritative for every source without persistent state', () => {
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    withHarness(({ env, event }) => {
      const offEnv = {
        ...env,
        CAVEMAN_DEFAULT_MODE: 'off',
      };
      delete offEnv.PLUGIN_DATA;

      const output = handleSessionStart(event(source), offEnv);

      assertMode(output, 'off');
      assert.equal(output.systemMessage, MODE_NOT_PERSISTED_MESSAGE);
    });
  }
});

test('stateless sources apply the active default for this turn with a warning', () => {
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    withHarness(({ env, event }) => {
      const statelessEnv = { ...env, CAVEMAN_DEFAULT_MODE: 'ultra' };
      delete statelessEnv.PLUGIN_DATA;

      const output = handleSessionStart(event(source), statelessEnv);

      assertMode(output, 'ultra');
      assert.equal(output.systemMessage, MODE_NOT_PERSISTED_MESSAGE);
    });
  }
});

test('startup and clear keep the selected default for this turn on write failure', () => {
  for (const source of ['startup', 'clear']) {
    withHarness(({ root, env, event }) => {
      const unsafeData = join(root, `unsafe-${source}`);
      writeFileSync(unsafeData, 'not a directory');
      const failingEnv = {
        ...env,
        CAVEMAN_DEFAULT_MODE: 'lite',
        PLUGIN_DATA: unsafeData,
      };

      const output = handleSessionStart(event(source), failingEnv);

      assertMode(output, 'lite');
      assert.equal(output.systemMessage, MODE_NOT_PERSISTED_MESSAGE);
      assert.equal(readFileSync(unsafeData, 'utf8'), 'not a directory');
    });
  }
});

test('startup preserves the inode and bytes of an old unrelated session record', () => {
  withHarness(({ dataDir, env, event, store }) => {
    const unrelatedId = 'old-unrelated-session';
    assert.equal(
      store.write(
        unrelatedId,
        'lite',
        new Date(0),
      ),
      true,
    );
    const unrelatedPath = join(
      realpathSync(dataDir),
      'sessions',
      `${stateKey(unrelatedId)}.json`,
    );
    const beforeBody = readFileSync(unrelatedPath);
    const beforeStat = statSync(unrelatedPath);

    handleSessionStart(event('startup', 'current-session'), env);

    assert.equal(existsSync(unrelatedPath), true);
    const afterStat = statSync(unrelatedPath);
    assert.equal(afterStat.dev, beforeStat.dev);
    assert.equal(afterStat.ino, beforeStat.ino);
    assert.deepEqual(readFileSync(unrelatedPath), beforeBody);
  });
});

test('resume preserves the inode and bytes of an old unrelated session record', () => {
  withHarness(({ dataDir, env, event, store }) => {
    const unrelatedId = 'old-unrelated-session';
    assert.equal(store.write(unrelatedId, 'lite', new Date(0)), true);
    const unrelatedPath = join(
      realpathSync(dataDir),
      'sessions',
      `${stateKey(unrelatedId)}.json`,
    );
    const beforeBody = readFileSync(unrelatedPath);
    const beforeStat = statSync(unrelatedPath);

    handleSessionStart(event('resume', 'current-session'), env);

    assert.equal(existsSync(unrelatedPath), true);
    const afterStat = statSync(unrelatedPath);
    assert.equal(afterStat.dev, beforeStat.dev);
    assert.equal(afterStat.ino, beforeStat.ino);
    assert.deepEqual(readFileSync(unrelatedPath), beforeBody);
  });
});

test('clear preserves the inode and bytes of an old unrelated session record', () => {
  withHarness(({ dataDir, env, event, store }) => {
    const unrelatedId = 'old-unrelated-session';
    assert.equal(store.write(unrelatedId, 'lite', new Date(0)), true);
    const unrelatedPath = join(
      realpathSync(dataDir),
      'sessions',
      `${stateKey(unrelatedId)}.json`,
    );
    const beforeBody = readFileSync(unrelatedPath);
    const beforeStat = statSync(unrelatedPath);

    handleSessionStart(event('clear', 'current-session'), env);

    assert.equal(existsSync(unrelatedPath), true);
    const afterStat = statSync(unrelatedPath);
    assert.equal(afterStat.dev, beforeStat.dev);
    assert.equal(afterStat.ino, beforeStat.ino);
    assert.deepEqual(readFileSync(unrelatedPath), beforeBody);
  });
});

test('compact preserves the inode and bytes of an old unrelated session record', () => {
  withHarness(({ dataDir, env, event, store }) => {
    const unrelatedId = 'old-unrelated-session';
    assert.equal(store.write(unrelatedId, 'lite', new Date(0)), true);
    const unrelatedPath = join(
      realpathSync(dataDir),
      'sessions',
      `${stateKey(unrelatedId)}.json`,
    );
    const beforeBody = readFileSync(unrelatedPath);
    const beforeStat = statSync(unrelatedPath);

    handleSessionStart(event('compact', 'current-session'), env);

    assert.equal(existsSync(unrelatedPath), true);
    const afterStat = statSync(unrelatedPath);
    assert.equal(afterStat.dev, beforeStat.dev);
    assert.equal(afterStat.ino, beforeStat.ino);
    assert.deepEqual(readFileSync(unrelatedPath), beforeBody);
  });
});

test('malformed and unsupported events are no-ops', () => {
  withHarness(({ cwd, env, event, store }) => {
    const arrayEvent = Object.assign([], event('startup'));
    const invalidEvents = [
      null,
      arrayEvent,
      'event',
      1,
      {},
      { ...event('startup'), hook_event_name: undefined },
      { ...event('startup'), hook_event_name: 'UserPromptSubmit' },
      { ...event('startup'), session_id: '' },
      { ...event('startup'), session_id: 7 },
      { ...event('startup'), session_id: 'x'.repeat(4097) },
      { ...event('startup'), cwd: '' },
      { ...event('startup'), cwd: 7 },
      { ...event('startup'), source: 'other' },
      { ...event('startup'), source: undefined },
      {
        hook_event_name: 'SessionStart',
        session_id: 'session-a',
        cwd,
      },
    ];

    for (const invalidEvent of invalidEvents) {
      assert.equal(handleSessionStart(invalidEvent, env), null);
    }
    assert.deepEqual(store.read('session-a'), { kind: 'missing' });
  });
});
