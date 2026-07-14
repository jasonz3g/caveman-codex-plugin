'use strict';

const { TextDecoder } = require('node:util');

const MAX_EVENT_BYTES = 1024 * 1024;
const STATE_UNAVAILABLE_MESSAGE =
  'Caveman session state is unavailable. Caveman mode is off for this turn; this hook did not overwrite stored state.';
const MODE_NOT_PERSISTED_MESSAGE =
  'Caveman could not persist the selected mode. The selected mode applies to this turn only.';
const guardedStreams = new WeakSet();

function guardStreamErrors(stream) {
  try {
    if (
      !stream ||
      (typeof stream !== 'object' && typeof stream !== 'function') ||
      guardedStreams.has(stream) ||
      typeof stream.on !== 'function'
    ) return;
    stream.on('error', () => {});
    guardedStreams.add(stream);
  } catch {
    // A stream without a usable error boundary is handled by synchronous guards.
  }
}

function contextResult(hookEventName, additionalContext, systemMessage) {
  const output = {
    hookSpecificOutput: { hookEventName, additionalContext },
  };
  if (systemMessage) output.systemMessage = systemMessage;
  return output;
}

async function readEvent(stream = process.stdin) {
  try {
    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_EVENT_BYTES) return null;
      chunks.push(buffer);
    }
    if (total === 0) return null;
    const json = new TextDecoder('utf-8', { fatal: true })
      .decode(Buffer.concat(chunks));
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

async function runHook(
  handler,
  {
    input = process.stdin,
    output = process.stdout,
    error = process.stderr,
    env = process.env,
  } = {},
) {
  guardStreamErrors(output);
  guardStreamErrors(error);
  const event = await readEvent(input);
  if (!event) return;
  try {
    const result = await handler(event, env);
    if (result) output.write(JSON.stringify(result));
  } catch {
    if (env.CAVEMAN_DEBUG === '1') {
      try { error.write('[caveman] hook failed open\n'); } catch { /* fail open */ }
    }
  }
}

module.exports = {
  MAX_EVENT_BYTES,
  STATE_UNAVAILABLE_MESSAGE,
  MODE_NOT_PERSISTED_MESSAGE,
  contextResult,
  readEvent,
  runHook,
};
