'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { TextDecoder } = require('node:util');
const { canonicalizeMode } = require('./modes.cjs');

const MAX_CONFIG_BYTES = 4096;
const MAX_PARENT_LEVELS = 64;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function sameStableConfigStat(first, second) {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size &&
    first.mode === second.mode &&
    first.nlink === second.nlink &&
    first.mtimeMs === second.mtimeMs &&
    first.ctimeMs === second.ctimeMs
  );
}

function readConfiguredMode(filePath) {
  let fd;
  let bytes;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) return null;
    const noFollow = fs.constants.O_NOFOLLOW;
    if (!Number.isInteger(noFollow) || noFollow === 0) return null;
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.size > MAX_CONFIG_BYTES ||
      !sameStableConfigStat(stat, opened)
    ) return null;
    const buffer = Buffer.allocUnsafe(MAX_CONFIG_BYTES + 1);
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
    if (length > MAX_CONFIG_BYTES) return null;
    const afterRead = fs.fstatSync(fd);
    if (
      !afterRead.isFile() ||
      length !== opened.size ||
      !sameStableConfigStat(opened, afterRead)
    ) return null;
    const finalStat = fs.lstatSync(filePath);
    if (
      !finalStat.isFile() ||
      finalStat.isSymbolicLink() ||
      !sameStableConfigStat(afterRead, finalStat)
    ) return null;
    bytes = buffer.subarray(0, length);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { bytes = undefined; }
    }
  }
  if (bytes === undefined) return null;
  try {
    const value = JSON.parse(UTF8_DECODER.decode(bytes));
    return canonicalizeMode(value && value.defaultMode);
  } catch {
    return null;
  }
}

function findRepoMode(cwd) {
  let current;
  try { current = path.resolve(cwd); } catch { return null; }
  for (let depth = 0; depth < MAX_PARENT_LEVELS; depth += 1) {
    for (const relative of ['.caveman/config.json', '.caveman.json']) {
      const mode = readConfiguredMode(path.join(current, relative));
      if (mode) return mode;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function resolveDefaultMode({ env = process.env, cwd = process.cwd(), homeDir = os.homedir() } = {}) {
  const envMode = canonicalizeMode(env.CAVEMAN_DEFAULT_MODE);
  if (envMode) return envMode;
  const repoMode = findRepoMode(cwd);
  if (repoMode) return repoMode;
  const userMode = readConfiguredMode(path.join(homeDir, '.config', 'caveman', 'config.json'));
  return userMode || 'wenyan-full';
}

module.exports = {
  MAX_CONFIG_BYTES,
  readConfiguredMode,
  findRepoMode,
  resolveDefaultMode,
};
