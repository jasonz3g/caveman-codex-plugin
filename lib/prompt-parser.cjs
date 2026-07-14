'use strict';

const { canonicalizeMode } = require('./modes.cjs');

const MAX_PROMPT_BYTES = 65536;
const NONE = Object.freeze({ kind: 'none', mode: null, recognized: false });
const CHINESE_MODES = new Map([
  ['轻文言', 'wenyan-lite'],
  ['極簡文言', 'wenyan-ultra'],
  ['极简文言', 'wenyan-ultra'],
  ['文言', 'wenyan-full'],
  ['简洁模式', 'full'],
  ['簡潔模式', 'full'],
  ['极简模式', 'ultra'],
  ['極簡模式', 'ultra'],
]);

function result(mode) {
  return {
    kind: mode === 'off' ? 'deactivate' : 'set',
    mode,
    recognized: true,
  };
}

function resolvedDefault(defaultMode) {
  return canonicalizeMode(defaultMode) || 'wenyan-full';
}

function exactActivationMode(suffix) {
  let mode = canonicalizeMode(suffix);
  if (mode && mode !== 'off') return mode;

  const beforeMode = suffix.match(/^(\S+)\s+mode$/);
  const afterMode = suffix.match(/^mode\s+(\S+)$/);
  const candidate = beforeMode?.[1] || afterMode?.[1];
  mode = canonicalizeMode(candidate);
  return mode && mode !== 'off' ? mode : null;
}

function parseModeIntent(prompt, defaultMode) {
  if (typeof prompt !== 'string' || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) return NONE;
  const normalized = prompt.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return NONE;

  const command = normalized.match(/^[/$]caveman(?:\s+(\S+))?$/);
  if (command) {
    const arg = command[1];
    if (!arg) return result(resolvedDefault(defaultMode));
    if (arg === 'off' || arg === 'stop' || arg === 'disable') return result('off');
    const mode = canonicalizeMode(arg);
    return mode ? result(mode) : NONE;
  }

  const isQuestion =
    /[?？]$/.test(normalized) ||
    /^(what|how|why|when|where|who|whom|whose|which|is|are|am|was|were|do|does|did|can|could|should|would|will|shall|may|might|must|have|has|had)\b/.test(normalized) ||
    /^(什么|什麼|如何|为什么|為什麼|为何|為何|怎么|怎麼|能否|是否|可否|会不会|會不會|要不要|请问|請問)/.test(normalized);
  if (isQuestion) return NONE;

  const isNegated =
    /\b(not|never|cannot|(do|does|did|is|are|was|were|have|has|had|ca|could|should|would|wo|must)n['’]?t)\b/.test(normalized) ||
    /(不要|别|別|请勿|請勿)/.test(normalized);
  if (isNegated) return NONE;

  const directive = normalized.replace(/[.,!;:，。！；：]+$/u, '').trimEnd();
  const wantsOff =
    /^(please\s+)?(stop|disable|deactivate|quit|exit)\s+(the\s+)?caveman(?:\s+mode)?$/.test(directive) ||
    /^caveman(?:\s+mode)?\s+(off|stop|disabled?)$/.test(directive) ||
    /^(please\s+)?((go\s+)?back\s+to\s+|switch\s+(back\s+)?to\s+|return\s+to\s+)?normal\s+mode$/.test(directive) ||
    /^(停止|关闭|關閉|停用)\s*caveman(?:\s+模式)?$/.test(directive) ||
    /^(恢复|恢復)正常模式$/.test(directive);
  if (wantsOff) return result('off');

  const chineseActivation = directive.match(
    /^(启用|啟用|使用|切换到|切換到)\s*caveman(?:\s+(文言|轻文言|極簡文言|极简文言|简洁模式|簡潔模式|极简模式|極簡模式))?$/,
  );
  if (chineseActivation) {
    const label = chineseActivation[2];
    return result(label ? CHINESE_MODES.get(label) : resolvedDefault(defaultMode));
  }

  const englishActivation = directive.match(
    /^(please\s+)?(activate|enable|start|turn on|use|switch to)\s+(the\s+)?caveman(?:\s+(.+))?$/,
  );
  if (englishActivation) {
    const suffix = englishActivation[4];
    if (!suffix || suffix === 'mode') return result(resolvedDefault(defaultMode));
    const mode = exactActivationMode(suffix);
    return mode ? result(mode) : NONE;
  }

  return NONE;
}

module.exports = { MAX_PROMPT_BYTES, parseModeIntent };
