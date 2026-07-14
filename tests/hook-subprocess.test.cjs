'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const {
  MAX_EVENT_BYTES,
  readEvent,
  runHook,
} = require('../lib/hook-io.cjs');
const {
  createStateStore,
  stateKey,
} = require('../lib/state-store.cjs');

const PROJECT_ROOT = resolve(__dirname, '..');
const SESSION_START_HOOK = join(PROJECT_ROOT, 'hooks', 'session-start.cjs');
const USER_PROMPT_SUBMIT_HOOK = join(
  PROJECT_ROOT,
  'hooks',
  'user-prompt-submit.cjs',
);
const STATE_UNAVAILABLE_MESSAGE =
  'Caveman session state is unavailable. Caveman mode is off for this turn; this hook did not overwrite stored state.';
const MODE_NOT_PERSISTED_MESSAGE =
  'Caveman could not persist the selected mode. The selected mode applies to this turn only.';
const FIXTURE_SKILL = `---
name: caveman
description: Caveman subprocess fixture
---
# Caveman

| Mode | Rule |
| --- | --- |
| **lite** | Lite subprocess rule |
| **ultra** | Ultra subprocess rule |
| **wenyan-full** | Wenyan full rule |

- lite: Lite subprocess example
- ultra: Ultra subprocess example
- wenyan-full: Wenyan full example
`;

function createHarness() {
  const root = mkdtempSync(join(tmpdir(), 'caveman-hook-process-'));
  const pluginRoot = join(root, 'plugin');
  const dataDir = join(root, 'data');
  const homeDir = join(root, 'home');
  const cwd = join(root, 'repo');
  mkdirSync(join(pluginRoot, 'skills', 'caveman'), { recursive: true });
  mkdirSync(homeDir);
  mkdirSync(cwd);
  writeFileSync(join(pluginRoot, 'skills', 'caveman', 'SKILL.md'), FIXTURE_SKILL);

  return {
    root,
    pluginRoot,
    dataDir,
    homeDir,
    cwd,
    env: {
      CAVEMAN_DEFAULT_MODE: 'wenyan-full',
      HOME: homeDir,
      PLUGIN_DATA: dataDir,
      PLUGIN_ROOT: pluginRoot,
    },
    event: {
      hook_event_name: 'SessionStart',
      session_id: 'subprocess-session',
      cwd,
      source: 'startup',
    },
    promptEvent(prompt, overrides = {}) {
      return {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'subprocess-session',
        cwd,
        prompt,
        ...overrides,
      };
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function spawnHook(
  harness,
  input,
  executable = SESSION_START_HOOK,
  envOverrides = {},
) {
  return spawnSync(process.execPath, [executable], {
    cwd: harness.cwd,
    env: { ...harness.env, ...envOverrides },
    input,
    encoding: null,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function spawnUserPromptHook(harness, input, envOverrides) {
  return spawnHook(
    harness,
    input,
    USER_PROMPT_SUBMIT_HOOK,
    envOverrides,
  );
}

function parseSuccessfulHook(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.deepEqual(result.stderr, Buffer.alloc(0));
  return JSON.parse(result.stdout.toString('utf8'));
}

function assertProcessPrivacy(result, secrets) {
  const output = Buffer.concat([result.stdout, result.stderr]).toString('utf8');
  for (let index = 0; index < secrets.length; index += 1) {
    if (output.includes(secrets[index])) {
      assert.fail(`subprocess output exposed private value at index ${index}`);
    }
  }
}

function assertSilentSuccess(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout, Buffer.alloc(0));
  assert.deepEqual(result.stderr, Buffer.alloc(0));
}

test('readEvent reconstructs chunked UTF-8 JSON', async () => {
  const encoded = Buffer.from(JSON.stringify({ prompt: '文言', count: 1 }));
  const multibyteStart = encoded.indexOf(Buffer.from('文'));
  const stream = Readable.from([
    encoded.subarray(0, multibyteStart + 1),
    encoded.subarray(multibyteStart + 1, multibyteStart + 2),
    encoded.subarray(multibyteStart + 2),
  ]);

  assert.deepEqual(await readEvent(stream), { prompt: '文言', count: 1 });
});

test('readEvent rejects non-object, malformed, and invalid UTF-8 input', async () => {
  const invalidUtf8Json = Buffer.concat([
    Buffer.from('{"x":"'),
    Buffer.from([0xff]),
    Buffer.from('"}'),
  ]);
  assert.equal(await readEvent(Readable.from([])), null);
  assert.equal(await readEvent(Readable.from(['null'])), null);
  assert.equal(await readEvent(Readable.from(['"scalar"'])), null);
  assert.equal(await readEvent(Readable.from(['7'])), null);
  assert.equal(await readEvent(Readable.from(['[]'])), null);
  assert.equal(await readEvent(Readable.from(['{'])), null);
  assert.equal(await readEvent(Readable.from([invalidUtf8Json])), null);
});

test('readEvent stops consuming after the byte limit', async () => {
  let yieldedAfterOverflow = false;
  let finalized = false;
  async function* oversizedInput() {
    try {
      yield Buffer.alloc(MAX_EVENT_BYTES);
      yield Buffer.from('x');
      yieldedAfterOverflow = true;
      yield Buffer.from('must-not-be-read');
    } finally {
      finalized = true;
    }
  }

  assert.equal(await readEvent(oversizedInput()), null);
  assert.equal(yieldedAfterOverflow, false);
  assert.equal(finalized, true);
});

test('readEvent fails open when the input iterator throws', async () => {
  async function* failingInput() {
    yield Buffer.from('{"partial":');
    throw new Error('secret input stream failure');
  }

  assert.equal(await readEvent(failingInput()), null);
});

test('runHook writes compact JSON for a successful handler', async () => {
  let stdout = '';
  let stderr = '';

  await runHook(
    async (event, env) => ({ event, marker: env.MARKER }),
    {
      input: Readable.from(['{"ok":true}']),
      output: { write(chunk) { stdout += chunk; } },
      error: { write(chunk) { stderr += chunk; } },
      env: { MARKER: 'isolated' },
    },
  );

  assert.deepEqual(JSON.parse(stdout), {
    event: { ok: true },
    marker: 'isolated',
  });
  assert.equal(stderr, '');
});

test('runHook fails open silently when input iteration fails', async () => {
  let handled = false;
  let wrote = false;
  async function* failingInput() {
    throw new Error('input failed');
  }

  await assert.doesNotReject(() => runHook(
    () => {
      handled = true;
      return { unexpected: true };
    },
    {
      input: failingInput(),
      output: { write() { wrote = true; } },
      error: { write() { wrote = true; } },
      env: { CAVEMAN_DEBUG: '1' },
    },
  ));
  assert.equal(handled, false);
  assert.equal(wrote, false);
});

test('runHook contains handler errors and only emits the fixed debug line', async () => {
  for (const debug of [undefined, '0', '1']) {
    let stdout = '';
    let stderr = '';
    const env = debug === undefined ? {} : { CAVEMAN_DEBUG: debug };

    await assert.doesNotReject(() => runHook(
      () => {
        throw new Error('secret handler detail');
      },
      {
        input: Readable.from(['{"secret":"never echo this"}']),
        output: { write(chunk) { stdout += chunk; } },
        error: { write(chunk) { stderr += chunk; } },
        env,
      },
    ));

    assert.equal(stdout, '');
    assert.equal(
      stderr,
      debug === '1' ? '[caveman] hook failed open\n' : '',
    );
    assert.doesNotMatch(stderr, /secret|never echo/i);
  }
});

test('runHook contains output and debug stream write failures', async () => {
  await assert.doesNotReject(() => runHook(
    () => ({ ok: true }),
    {
      input: Readable.from(['{"ok":true}']),
      output: { write() { throw new Error('output failed'); } },
      error: { write() { throw new Error('debug failed'); } },
      env: { CAVEMAN_DEBUG: '1' },
    },
  ));
});

test('runHook contains asynchronous error events from output and debug streams', () => {
  for (const failingStream of ['output', 'error']) {
    const script = `
      const { EventEmitter } = require('node:events');
      const { Readable } = require('node:stream');
      const { runHook } = require('./lib/hook-io.cjs');
      const failing = new EventEmitter();
      failing.write = () => {
        queueMicrotask(() => failing.emit('error', new Error('simulated EPIPE')));
      };
      const quiet = { write() {} };
      const handler = ${failingStream === 'output'
        ? '() => ({ ok: true })'
        : '() => { throw new Error("handler failed"); }'};
      runHook(handler, {
        input: Readable.from(['{"ok":true}']),
        output: ${failingStream === 'output' ? 'failing' : 'quiet'},
        error: ${failingStream === 'error' ? 'failing' : 'quiet'},
        env: { CAVEMAN_DEBUG: '1' },
      });
      setImmediate(() => process.exit(0));
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    });

    assert.equal(result.error, undefined);
    assert.equal(
      result.status,
      0,
      `${failingStream} stream escaped fail-open boundary: ${result.stderr}`,
    );
  }
});

test('runHook installs one guard without replacing existing stream listeners', async () => {
  const output = new EventEmitter();
  let existingListenerCalls = 0;
  output.on('error', () => { existingListenerCalls += 1; });
  output.write = () => {};
  const options = {
    output,
    error: { write() {} },
    env: {},
  };

  await runHook(
    () => ({ ok: true }),
    { ...options, input: Readable.from(['{"run":1}']) },
  );
  await runHook(
    () => ({ ok: true }),
    { ...options, input: Readable.from(['{"run":2}']) },
  );

  assert.equal(output.listenerCount('error'), 2);
  output.emit('error', new Error('handled by both listeners'));
  assert.equal(existingListenerCalls, 1);
});

test('SessionStart executable returns valid hook JSON with isolated state', () => {
  const harness = createHarness();
  try {
    const result = spawnHook(harness, JSON.stringify(harness.event));

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.deepEqual(result.stderr, Buffer.alloc(0));
    const output = JSON.parse(result.stdout.toString('utf8'));
    assert.equal(
      output.hookSpecificOutput.hookEventName,
      'SessionStart',
    );
    assert.match(
      output.hookSpecificOutput.additionalContext,
      /level: wenyan-full/,
    );
    assert.equal(output.systemMessage, undefined);
    assert.deepEqual(
      createStateStore(harness.dataDir).read('subprocess-session'),
      { kind: 'found', mode: 'wenyan-full' },
    );
  } finally {
    harness.cleanup();
  }
});

test('SessionStart executable rejects malformed JSON with zero exit', () => {
  const harness = createHarness();
  try {
    assertSilentSuccess(spawnHook(harness, '{'));
  } finally {
    harness.cleanup();
  }
});

test('SessionStart executable rejects invalid UTF-8 with zero exit', () => {
  const harness = createHarness();
  try {
    const invalidUtf8Json = Buffer.concat([
      Buffer.from('{"x":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]);
    assertSilentSuccess(spawnHook(harness, invalidUtf8Json));
  } finally {
    harness.cleanup();
  }
});

test('SessionStart executable rejects oversized input with zero exit', () => {
  const harness = createHarness();
  try {
    assertSilentSuccess(spawnHook(harness, Buffer.alloc(MAX_EVENT_BYTES + 1, 0x78)));
  } finally {
    harness.cleanup();
  }
});

test('SessionStart executable produces no output for a rejected event', () => {
  const harness = createHarness();
  try {
    const rejected = {
      ...harness.event,
      hook_event_name: 'UserPromptSubmit',
    };
    assertSilentSuccess(spawnHook(harness, JSON.stringify(rejected)));
  } finally {
    harness.cleanup();
  }
});

test('UserPromptSubmit executable persists and reinforces a stateful mode sequence', () => {
  const harness = createHarness();
  try {
    const steps = [
      {
        prompt: '/caveman lite',
        mode: 'lite',
        pattern: /CAVEMAN MODE ACTIVE — level: lite/,
        skillMarker: /Lite subprocess rule/,
        acknowledgement: /Acknowledge this mode change in one short line/,
      },
      {
        prompt: 'ordinary private next prompt',
        mode: 'lite',
        pattern: /CAVEMAN CURRENT MODE: lite/,
      },
      {
        prompt: 'stop caveman',
        mode: 'off',
        pattern: /CAVEMAN CURRENT MODE: off/,
        acknowledgement: /Acknowledge this mode change in one short line/,
      },
      {
        prompt: 'ordinary private off prompt',
        mode: 'off',
        pattern: /CAVEMAN CURRENT MODE: off/,
      },
    ];

    for (const step of steps) {
      const result = spawnUserPromptHook(
        harness,
        JSON.stringify(harness.promptEvent(step.prompt)),
      );
      assertProcessPrivacy(result, [
        step.prompt,
        'subprocess-session',
        harness.root,
        realpathSync(harness.root),
        harness.pluginRoot,
        harness.dataDir,
        harness.homeDir,
        harness.cwd,
      ]);
      const output = parseSuccessfulHook(result);
      assert.equal(
        output.hookSpecificOutput.hookEventName,
        'UserPromptSubmit',
      );
      assert.match(output.hookSpecificOutput.additionalContext, step.pattern);
      if (step.skillMarker) {
        assert.match(
          output.hookSpecificOutput.additionalContext,
          step.skillMarker,
        );
        assert.doesNotMatch(
          output.hookSpecificOutput.additionalContext,
          /Wenyan full rule/,
        );
      }
      if (step.acknowledgement) {
        assert.match(
          output.hookSpecificOutput.additionalContext,
          step.acknowledgement,
        );
      }
      assert.equal(output.systemMessage, undefined);
      assert.deepEqual(
        createStateStore(harness.dataDir).read('subprocess-session'),
        { kind: 'found', mode: step.mode },
      );
    }

    const statePath = join(
      harness.dataDir,
      'sessions',
      `${stateKey('subprocess-session')}.json`,
    );
    const persisted = readFileSync(statePath, 'utf8');
    for (const step of steps) assert.equal(persisted.includes(step.prompt), false);
  } finally {
    harness.cleanup();
  }
});

test('UserPromptSubmit executable initializes the isolated injected default', () => {
  const harness = createHarness();
  try {
    const prompt = 'ordinary isolated default prompt';
    const result = spawnUserPromptHook(
      harness,
      JSON.stringify(harness.promptEvent(prompt)),
      { CAVEMAN_DEFAULT_MODE: 'ultra' },
    );
    assertProcessPrivacy(result, [
      prompt,
      'subprocess-session',
      harness.root,
      realpathSync(harness.root),
    ]);
    const output = parseSuccessfulHook(result);

    assert.equal(
      output.hookSpecificOutput.additionalContext,
      'CAVEMAN CURRENT MODE: ultra. Preserve technical facts, code, commands, symbols, and exact error text. Apply auto-clarity exceptions. This overrides earlier caveman mode context.',
    );
    assert.equal(output.systemMessage, undefined);
    assert.deepEqual(
      createStateStore(harness.dataDir).read('subprocess-session'),
      { kind: 'found', mode: 'ultra' },
    );
  } finally {
    harness.cleanup();
  }
});

test('UserPromptSubmit executable fails closed for unavailable state', () => {
  const harness = createHarness();
  try {
    const store = createStateStore(harness.dataDir);
    const statePath = join(
      harness.dataDir,
      'sessions',
      `${stateKey('subprocess-session')}.json`,
    );
    writeFileSync(statePath, '{private malformed state');
    const prompt = 'ordinary unavailable private prompt';

    const result = spawnUserPromptHook(
      harness,
      JSON.stringify(harness.promptEvent(prompt)),
    );
    assertProcessPrivacy(result, [
      prompt,
      'subprocess-session',
      'private malformed state',
      harness.root,
      realpathSync(harness.root),
    ]);
    const output = parseSuccessfulHook(result);

    assert.equal(
      output.hookSpecificOutput.additionalContext,
      'CAVEMAN CURRENT MODE: off. Use normal prose until explicitly reactivated. This overrides earlier caveman mode context.',
    );
    assert.equal(output.systemMessage, STATE_UNAVAILABLE_MESSAGE);
    assert.deepEqual(store.read('subprocess-session'), { kind: 'unavailable' });
    assert.equal(readFileSync(statePath, 'utf8'), '{private malformed state');
  } finally {
    harness.cleanup();
  }
});

test('UserPromptSubmit executable reports a fixed warning when persistence fails', () => {
  const harness = createHarness();
  try {
    const privateFailureDetail = 'private injected write failure detail';
    const preloadPath = join(harness.root, 'inject-write-failure.cjs');
    mkdirSync(join(harness.dataDir, 'sessions'), { recursive: true });
    const canonicalSessions = realpathSync(join(harness.dataDir, 'sessions'));
    const statePath = join(
      canonicalSessions,
      `${stateKey('subprocess-session')}.json`,
    );
    writeFileSync(preloadPath, `
      'use strict';
      const fs = require('node:fs');
      const originalRename = fs.renameSync;
      fs.renameSync = function injectedRename(source, destination) {
        if (destination === process.env.CAVEMAN_TEST_STATE_PATH) {
          throw new Error(process.env.CAVEMAN_TEST_PRIVATE_DETAIL);
        }
        return originalRename(source, destination);
      };
    `);
    const prompt = '/caveman lite';

    const result = spawnUserPromptHook(
      harness,
      JSON.stringify(harness.promptEvent(prompt)),
      {
        NODE_OPTIONS: `--require=${preloadPath}`,
        CAVEMAN_TEST_STATE_PATH: statePath,
        CAVEMAN_TEST_PRIVATE_DETAIL: privateFailureDetail,
      },
    );
    assertProcessPrivacy(result, [
      prompt,
      'subprocess-session',
      privateFailureDetail,
      preloadPath,
      harness.root,
      realpathSync(harness.root),
    ]);
    const output = parseSuccessfulHook(result);

    assert.match(
      output.hookSpecificOutput.additionalContext,
      /CAVEMAN MODE ACTIVE — level: lite/,
    );
    assert.match(
      output.hookSpecificOutput.additionalContext,
      /Acknowledge in one short line that this mode applies to this turn only/,
    );
    assert.equal(output.systemMessage, MODE_NOT_PERSISTED_MESSAGE);
    assert.deepEqual(
      createStateStore(harness.dataDir).read('subprocess-session'),
      { kind: 'missing' },
    );
  } finally {
    harness.cleanup();
  }
});

test('UserPromptSubmit executable rejects malformed JSON with zero exit', () => {
  const harness = createHarness();
  try {
    const input = '{"prompt":"private malformed input';
    const result = spawnUserPromptHook(harness, input);

    assertProcessPrivacy(result, ['private malformed input', harness.root]);
    assertSilentSuccess(result);
  } finally {
    harness.cleanup();
  }
});

test('UserPromptSubmit executable rejects strict event-boundary violations', () => {
  const harness = createHarness();
  try {
    const privatePrompt = '/caveman off private rejected';
    const rejectedEvents = [
      harness.promptEvent(privatePrompt, { hook_event_name: 'SessionStart' }),
      Object.assign([], harness.promptEvent(privatePrompt)),
    ];

    for (const rejected of rejectedEvents) {
      const result = spawnUserPromptHook(harness, JSON.stringify(rejected));
      assertProcessPrivacy(result, [
        privatePrompt,
        'subprocess-session',
        harness.root,
      ]);
      assertSilentSuccess(result);
    }
    assert.deepEqual(
      createStateStore(harness.dataDir).read('subprocess-session'),
      { kind: 'missing' },
    );
  } finally {
    harness.cleanup();
  }
});

test('hooks.json preserves SessionStart and registers exact UserPromptSubmit contract', () => {
  const hooks = JSON.parse(
    readFileSync(join(PROJECT_ROOT, 'hooks', 'hooks.json'), 'utf8'),
  );

  assert.deepEqual(hooks.hooks.SessionStart, [
    {
      matcher: 'startup|resume|clear|compact',
      hooks: [
        {
          type: 'command',
          command: 'node "${PLUGIN_ROOT}/hooks/session-start.cjs"',
          timeout: 10,
          statusMessage: 'Loading caveman response mode',
        },
      ],
    },
  ]);
  assert.deepEqual(hooks.hooks.UserPromptSubmit, [
    {
      hooks: [
        {
          type: 'command',
          command: 'node "${PLUGIN_ROOT}/hooks/user-prompt-submit.cjs"',
          timeout: 10,
          statusMessage: 'Applying caveman response mode',
        },
      ],
    },
  ]);
  assert.deepEqual(Object.keys(hooks.hooks), [
    'SessionStart',
    'UserPromptSubmit',
  ]);
});
