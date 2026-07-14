'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { canonicalizeMode } = require('./modes.cjs');

const MAX_SKILL_BYTES = 128 * 1024;
const MAX_FRONTMATTER_BYTES = 16 * 1024;
const ACTIVE_MODES = new Set([
  'lite',
  'full',
  'ultra',
  'wenyan-lite',
  'wenyan-full',
  'wenyan-ultra',
]);
const IMPLICIT_NON_STRING_WORDS = new Set([
  'true',
  'false',
  'yes',
  'no',
  'on',
  'off',
  'null',
]);

function sameFile(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

function readSkillBytes(file) {
  let fd;
  try {
    const beforeOpen = fs.lstatSync(file);
    if (
      !beforeOpen.isFile() ||
      beforeOpen.isSymbolicLink() ||
      beforeOpen.size > MAX_SKILL_BYTES
    ) return null;

    const noFollow = fs.constants.O_NOFOLLOW || 0;
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile() ||
      !sameFile(beforeOpen, opened) ||
      opened.size > MAX_SKILL_BYTES
    ) return null;

    const buffer = Buffer.alloc(MAX_SKILL_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const bytesRead = fs.readSync(
        fd,
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }

    const afterRead = fs.fstatSync(fd);
    if (
      length > MAX_SKILL_BYTES ||
      !sameFile(opened, afterRead) ||
      opened.size !== afterRead.size ||
      opened.mtimeMs !== afterRead.mtimeMs ||
      length !== afterRead.size
    ) return null;
    return buffer.subarray(0, length);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function isPlainDescription(value) {
  const normalized = value.toLowerCase();
  return (
    value !== '' &&
    value === value.trim() &&
    /^\p{L}/u.test(value) &&
    !/:\s/u.test(value) &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    !value.includes('#') &&
    !IMPLICIT_NON_STRING_WORDS.has(normalized)
  );
}

function hasValidMetadata(metadata) {
  const lines = metadata.split('\n');
  let nameSeen = false;
  let descriptionSeen = false;
  let descriptionHasContent = false;
  let inDescriptionBlock = false;

  for (const line of lines) {
    if (inDescriptionBlock) {
      if (line.trim() === '') continue;
      if (/^ +/.test(line)) {
        if (!/^ +#/.test(line)) descriptionHasContent = true;
        continue;
      }
      inDescriptionBlock = false;
    }

    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (line === 'name: caveman') {
      if (nameSeen) return false;
      nameSeen = true;
      continue;
    }

    const block = line.match(/^description: ([>|][+-]?)$/);
    if (block) {
      if (descriptionSeen) return false;
      descriptionSeen = true;
      inDescriptionBlock = true;
      continue;
    }

    const plain = line.match(/^description: (.+)$/);
    if (plain) {
      if (descriptionSeen || !isPlainDescription(plain[1])) return false;
      descriptionSeen = true;
      descriptionHasContent = true;
      continue;
    }

    return false;
  }

  return nameSeen && descriptionSeen && descriptionHasContent;
}

function stripFrontmatter(document) {
  const opening = '---\n';
  const closing = '\n---\n';
  if (!document.startsWith(opening)) return null;
  const boundary = document.indexOf(closing, opening.length);
  if (boundary < 0) return null;

  const bodyOffset = boundary + closing.length;
  if (
    Buffer.byteLength(document.slice(0, bodyOffset), 'utf8') >
    MAX_FRONTMATTER_BYTES
  ) return null;

  const metadata = document.slice(opening.length, boundary);
  if (!hasValidMetadata(metadata)) return null;
  const body = document.slice(bodyOffset);
  return body.trim() === '' ? null : body;
}

function normalizeNewlines(document) {
  const normalized = document.replace(/\r\n/g, '\n');
  return normalized.includes('\r') ? null : normalized;
}

function loadSkillBody(pluginRoot) {
  try {
    const file = path.join(pluginRoot, 'skills', 'caveman', 'SKILL.md');
    const bytes = readSkillBytes(file);
    if (!bytes) return null;
    const document = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const normalized = normalizeNewlines(document);
    return normalized === null ? null : stripFrontmatter(normalized);
  } catch {
    return null;
  }
}

function filterForMode(body, mode) {
  return body.split('\n').reduce((lines, line) => {
    const table = line.match(/^\|\s*\*\*(\S+?)\*\*\s*\|/);
    if (table && ACTIVE_MODES.has(table[1])) {
      if (table[1] === mode) lines.push(line);
      return lines;
    }
    const example = line.match(/^- (\S+?):\s/);
    if (example && ACTIVE_MODES.has(example[1])) {
      if (example[1] === mode) lines.push(line);
      return lines;
    }
    lines.push(line);
    return lines;
  }, []).join('\n');
}

function fallback(mode) {
  return [
    `CAVEMAN MODE ACTIVE — level: ${mode}`,
    'Respond tersely while preserving every technical fact.',
    'Technical terms, code, commands, and error text remain exact.',
    'Use clear normal prose for security warnings, irreversible confirmations, and ambiguity-prone steps.',
    'This current mode overrides every earlier caveman mode reminder.',
  ].join('\n');
}

function buildFullContext({ pluginRoot, mode }) {
  const canonicalMode = canonicalizeMode(mode);
  if (!canonicalMode || canonicalMode === 'off') return buildOffReminder();
  const body = loadSkillBody(pluginRoot);
  if (!body) return fallback(canonicalMode);
  return [
    `CAVEMAN MODE ACTIVE — level: ${canonicalMode}`,
    filterForMode(body, canonicalMode),
    'This current mode overrides every earlier caveman mode reminder.',
  ].join('\n\n');
}

function buildReminder(mode) {
  const canonicalMode = canonicalizeMode(mode);
  if (!canonicalMode || canonicalMode === 'off') return buildOffReminder();
  return `CAVEMAN CURRENT MODE: ${canonicalMode}. Preserve technical facts, code, commands, symbols, and exact error text. Apply auto-clarity exceptions. This overrides earlier caveman mode context.`;
}

function buildOffReminder() {
  return 'CAVEMAN CURRENT MODE: off. Use normal prose until explicitly reactivated. This overrides earlier caveman mode context.';
}

function buildContextForMode({ pluginRoot, mode }) {
  return buildFullContext({ pluginRoot, mode });
}

module.exports = {
  MAX_SKILL_BYTES,
  loadSkillBody,
  buildFullContext,
  buildReminder,
  buildOffReminder,
  buildContextForMode,
};
