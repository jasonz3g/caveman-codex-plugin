'use strict';

const { resolveDefaultMode } = require('../lib/config.cjs');
const { createStateStore } = require('../lib/state-store.cjs');
const { buildContextForMode } = require('../lib/rules.cjs');
const {
  STATE_UNAVAILABLE_MESSAGE,
  MODE_NOT_PERSISTED_MESSAGE,
  contextResult,
  runHook,
} = require('../lib/hook-io.cjs');

const SOURCES = new Set(['startup', 'resume', 'clear', 'compact']);
const MAX_SESSION_ID_LENGTH = 4096;

function restoreMode(store, sessionId, defaultMode) {
  const state = store.read(sessionId);
  if (state.kind === 'found') return { mode: state.mode };
  if (state.kind === 'missing') {
    const initialized = store.initializeIfMissing(sessionId, defaultMode);
    if (initialized.kind === 'found') return { mode: initialized.mode };
  }
  return { mode: 'off', systemMessage: STATE_UNAVAILABLE_MESSAGE };
}

function handleSessionStart(event, env = process.env) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  if (event.hook_event_name !== 'SessionStart') return null;
  if (
    typeof event.session_id !== 'string' ||
    event.session_id.length === 0 ||
    event.session_id.length > MAX_SESSION_ID_LENGTH ||
    typeof event.cwd !== 'string' ||
    event.cwd.length === 0
  ) return null;
  if (!SOURCES.has(event.source)) return null;

  const defaultMode = resolveDefaultMode({
    env,
    cwd: event.cwd,
    homeDir: env.HOME,
  });
  const store = env.PLUGIN_DATA ? createStateStore(env.PLUGIN_DATA) : null;
  let selected = { mode: defaultMode };

  if (event.source === 'startup' || event.source === 'clear') {
    if (!store || !store.write(event.session_id, defaultMode)) {
      selected.systemMessage = MODE_NOT_PERSISTED_MESSAGE;
    }
  } else if (store) {
    selected = restoreMode(store, event.session_id, defaultMode);
  } else {
    selected.systemMessage = MODE_NOT_PERSISTED_MESSAGE;
  }

  return contextResult(
    'SessionStart',
    buildContextForMode({ pluginRoot: env.PLUGIN_ROOT, mode: selected.mode }),
    selected.systemMessage,
  );
}

if (require.main === module) runHook(handleSessionStart);

module.exports = { handleSessionStart };
