'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  afterEach,
  beforeEach,
} = require('node:test');
const fs = require('node:fs');
const {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = fs;
const { tmpdir } = require('node:os');
const {
  dirname,
  join,
} = require('node:path');
const {
  MAX_CONFIG_BYTES,
  readConfiguredMode,
  resolveDefaultMode,
} = require('../lib/config.cjs');

let temporaryRoot;
let root;
let nested;
let home;

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value));
}

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), 'caveman-config-'));
  root = join(temporaryRoot, 'repo');
  nested = join(root, 'packages', 'nested');
  home = join(temporaryRoot, 'home');
  mkdirSync(nested, { recursive: true });
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

test('uses environment mode before all files', () => {
  writeJson(join(nested, '.caveman', 'config.json'), { defaultMode: 'ultra' });
  writeJson(join(home, '.config', 'caveman', 'config.json'), { defaultMode: 'full' });

  assert.equal(resolveDefaultMode({
    env: { CAVEMAN_DEFAULT_MODE: 'lite' }, cwd: nested, homeDir: home,
  }), 'lite');
});

test('uses closest repo config and prefers .caveman/config.json at a level', () => {
  writeJson(join(root, '.caveman.json'), { defaultMode: 'full' });
  writeJson(join(nested, '.caveman', 'config.json'), { defaultMode: 'ultra' });
  assert.equal(resolveDefaultMode({ env: {}, cwd: nested, homeDir: home }), 'ultra');
});

test('falls through invalid repo config to user config', () => {
  writeFileSync(join(nested, '.caveman.json'), '{bad');
  writeJson(join(home, '.config', 'caveman', 'config.json'), { defaultMode: 'wenyan-lite' });
  assert.equal(resolveDefaultMode({ env: {}, cwd: nested, homeDir: home }), 'wenyan-lite');
});

test('ignores symlinked and oversized config files', () => {
  const target = join(root, 'target.json');
  const userConfig = join(home, '.config', 'caveman', 'config.json');
  writeJson(target, { defaultMode: 'lite' });
  symlinkSync(target, join(nested, '.caveman.json'));
  assert.equal(readConfiguredMode(join(nested, '.caveman.json')), null);
  mkdirSync(dirname(userConfig), { recursive: true });
  writeFileSync(userConfig, 'x'.repeat(4097));
  assert.equal(resolveDefaultMode({ env: {}, cwd: nested, homeDir: home }), 'wenyan-full');
});

test('rejects a final component swapped to a symlink after initial lstat', () => {
  const configPath = join(nested, '.caveman.json');
  const externalPath = join(temporaryRoot, 'external-config.json');
  writeJson(configPath, { defaultMode: 'off' });
  writeJson(externalPath, { defaultMode: 'ultra' });
  const externalStat = fs.statSync(externalPath);
  const originalLstat = fs.lstatSync;
  const originalReadFile = fs.readFileSync;
  const originalRead = fs.readSync;
  const originalFstat = fs.fstatSync;
  let swapped = false;
  let externalRead = false;

  fs.lstatSync = function swapAfterInitialLstat(candidate, ...args) {
    const stat = originalLstat(candidate, ...args);
    if (candidate === configPath && !swapped) {
      swapped = true;
      fs.unlinkSync(configPath);
      symlinkSync(externalPath, configPath);
    }
    return stat;
  };
  fs.readFileSync = function detectExternalRead(candidate, ...args) {
    if (candidate === configPath && swapped) externalRead = true;
    return originalReadFile(candidate, ...args);
  };
  fs.readSync = function detectExternalDescriptorRead(candidate, ...args) {
    if (typeof candidate === 'number') {
      const candidateStat = originalFstat(candidate);
      if (
        candidateStat.dev === externalStat.dev &&
        candidateStat.ino === externalStat.ino
      ) externalRead = true;
    }
    return originalRead(candidate, ...args);
  };
  let outcome;
  try {
    outcome = readConfiguredMode(configPath);
  } finally {
    fs.lstatSync = originalLstat;
    fs.readFileSync = originalReadFile;
    fs.readSync = originalRead;
  }

  assert.equal(swapped, true);
  assert.equal(externalRead, false);
  assert.equal(outcome, null);
});

test('rejects a regular inode replacement between initial lstat and open', () => {
  const configPath = join(nested, '.caveman.json');
  const replacementPath = join(temporaryRoot, 'replacement-before-open.json');
  writeJson(configPath, { defaultMode: 'lite' });
  writeJson(replacementPath, { defaultMode: 'ultra' });
  const originalOpen = fs.openSync;
  let replaced = false;

  fs.openSync = function replaceBeforeOpen(candidate, ...args) {
    if (candidate === configPath && !replaced) {
      replaced = true;
      fs.renameSync(replacementPath, configPath);
    }
    return originalOpen(candidate, ...args);
  };
  let outcome;
  try {
    outcome = readConfiguredMode(configPath);
  } finally {
    fs.openSync = originalOpen;
  }

  assert.equal(replaced, true);
  assert.equal(outcome, null);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).defaultMode, 'ultra');
});

test('rejects pathname replacement after opening the config descriptor', () => {
  const configPath = join(nested, '.caveman.json');
  const replacementPath = join(temporaryRoot, 'replacement-config.json');
  writeJson(configPath, { defaultMode: 'lite' });
  writeJson(replacementPath, { defaultMode: 'ultra' });
  const originalOpen = fs.openSync;
  let replaced = false;

  fs.openSync = function replaceAfterOpen(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (candidate === configPath && !replaced) {
      replaced = true;
      fs.renameSync(replacementPath, configPath);
    }
    return fd;
  };
  let outcome;
  try {
    outcome = readConfiguredMode(configPath);
  } finally {
    fs.openSync = originalOpen;
  }

  assert.equal(replaced, true);
  assert.equal(outcome, null);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).defaultMode, 'ultra');
});

test('rejects a config that grows beyond the bound at descriptor read', () => {
  const configPath = join(nested, '.caveman.json');
  writeJson(configPath, { defaultMode: 'lite' });
  const originalReadFile = fs.readFileSync;
  const originalRead = fs.readSync;
  let grew = false;

  function growBeforeConfigRead(candidate) {
    if ((candidate === configPath || typeof candidate === 'number') && !grew) {
      grew = true;
      fs.appendFileSync(configPath, ' '.repeat(MAX_CONFIG_BYTES + 1));
    }
  }
  fs.readFileSync = function growBeforeWholeDescriptorRead(candidate, ...args) {
    growBeforeConfigRead(candidate);
    return originalReadFile(candidate, ...args);
  };
  fs.readSync = function growBeforeBoundedDescriptorRead(candidate, ...args) {
    growBeforeConfigRead(candidate);
    return originalRead(candidate, ...args);
  };
  let outcome;
  try {
    outcome = readConfiguredMode(configPath);
  } finally {
    fs.readFileSync = originalReadFile;
    fs.readSync = originalRead;
  }

  assert.equal(grew, true);
  assert.equal(outcome, null);
});

test('rejects equal-length config bytes changed at descriptor read', () => {
  const configPath = join(nested, '.caveman.json');
  writeJson(configPath, { defaultMode: 'lite' });
  const beforeStat = fs.statSync(configPath);
  const originalReadFile = fs.readFileSync;
  const originalRead = fs.readSync;
  let changed = false;

  function changeBeforeConfigRead(candidate) {
    if ((candidate === configPath || typeof candidate === 'number') && !changed) {
      changed = true;
      writeFileSync(configPath, JSON.stringify({ defaultMode: 'full' }));
      fs.utimesSync(
        configPath,
        beforeStat.atime,
        new Date(beforeStat.mtimeMs + 2000),
      );
    }
  }
  fs.readFileSync = function changeBeforeWholeDescriptorRead(candidate, ...args) {
    changeBeforeConfigRead(candidate);
    return originalReadFile(candidate, ...args);
  };
  fs.readSync = function changeBeforeBoundedDescriptorRead(candidate, ...args) {
    changeBeforeConfigRead(candidate);
    return originalRead(candidate, ...args);
  };
  let outcome;
  try {
    outcome = readConfiguredMode(configPath);
  } finally {
    fs.readFileSync = originalReadFile;
    fs.readSync = originalRead;
  }

  assert.equal(changed, true);
  assert.equal(outcome, null);
});

test('rejects invalid UTF-8 that replacement decoding would parse', () => {
  const configPath = join(nested, '.caveman.json');
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, Buffer.concat([
    Buffer.from('{"defaultMode":"lite","note":"'),
    Buffer.from([0xc3]),
    Buffer.from('"}'),
  ]));

  assert.equal(readConfiguredMode(configPath), null);
});

test('rejects a config when closing its descriptor fails', () => {
  const configPath = join(nested, '.caveman.json');
  writeJson(configPath, { defaultMode: 'lite' });
  const originalClose = fs.closeSync;
  let failed = false;

  fs.closeSync = function failDescriptorClose(fd, ...args) {
    const result = originalClose(fd, ...args);
    if (!failed) {
      failed = true;
      throw Object.assign(new Error('simulated config close failure'), {
        code: 'EIO',
      });
    }
    return result;
  };
  let outcome;
  try {
    outcome = readConfiguredMode(configPath);
  } finally {
    fs.closeSync = originalClose;
  }

  assert.equal(failed, true);
  assert.equal(outcome, null);
});
