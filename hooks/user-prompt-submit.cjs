'use strict';

const { resolveDefaultMode } = require('../lib/config.cjs');
const { createStateStore } = require('../lib/state-store.cjs');
const { parseModeIntent } = require('../lib/prompt-parser.cjs');
const {
  buildContextForMode,
  buildReminder,
} = require('../lib/rules.cjs');
const {
  STATE_UNAVAILABLE_MESSAGE,
  MODE_NOT_PERSISTED_MESSAGE,
  contextResult,
  runHook,
} = require('../lib/hook-io.cjs');

const MAX_SESSION_ID_LENGTH = 4096;

function passiveMode(store, sessionId, defaultMode) {
  const state = store.read(sessionId);
  if (state.kind === 'found') return { mode: state.mode };
  if (state.kind === 'missing') {
    const initialized = store.initializeIfMissing(sessionId, defaultMode);
    if (initialized.kind === 'found') return { mode: initialized.mode };
  }
  return { mode: 'off', systemMessage: STATE_UNAVAILABLE_MESSAGE };
}

function handleUserPromptSubmit(event, env = process.env) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  if (event.hook_event_name !== 'UserPromptSubmit') return null;
  if (
    typeof event.session_id !== 'string' ||
    event.session_id.length === 0 ||
    event.session_id.length > MAX_SESSION_ID_LENGTH ||
    typeof event.cwd !== 'string' ||
    event.cwd.length === 0 ||
    typeof event.prompt !== 'string'
  ) return null;

  const defaultMode = resolveDefaultMode({
    env,
    cwd: event.cwd,
    homeDir: env.HOME,
  });
  const store = env.PLUGIN_DATA ? createStateStore(env.PLUGIN_DATA) : null;
  const intent = parseModeIntent(event.prompt, defaultMode);

  if (intent.recognized) {
    const persisted = Boolean(store && store.write(event.session_id, intent.mode));
    const fullContext = buildContextForMode({
      pluginRoot: env.PLUGIN_ROOT,
      mode: intent.mode,
    });
    const acknowledgement = persisted
      ? 'Acknowledge this mode change in one short line.'
      : 'Acknowledge in one short line that this mode applies to this turn only.';
    return contextResult(
      'UserPromptSubmit',
      `${fullContext}\n\n${acknowledgement}`,
      persisted ? undefined : MODE_NOT_PERSISTED_MESSAGE,
    );
  }

  const selected = store
    ? passiveMode(store, event.session_id, defaultMode)
    : { mode: defaultMode };
  return contextResult(
    'UserPromptSubmit',
    buildReminder(selected.mode),
    selected.systemMessage,
  );
}

if (require.main === module) runHook(handleUserPromptSubmit);

module.exports = { handleUserPromptSubmit };
