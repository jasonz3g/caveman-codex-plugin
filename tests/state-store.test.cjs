'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { afterEach, beforeEach } = require('node:test');
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
const { basename, dirname, join } = require('node:path');
const { createHash } = require('node:crypto');
const {
  MAX_STATE_BYTES,
  createStateStore,
  stateKey,
} = require('../lib/state-store.cjs');

const FIXED_TIME = Date.parse('2026-07-11T12:00:00.000Z');

let temporaryRoot;
let dataDir;
let externalDir;
let externalFile;

function fixedNow() {
  return new Date(FIXED_TIME);
}

function statePath(sessionId) {
  return join(dataDir, 'sessions', `${stateKey(sessionId)}.json`);
}

function canonicalStatePath(sessionId) {
  return join(realpathSync(dataDir), 'sessions', `${stateKey(sessionId)}.json`);
}

function initializationAliasPath(
  finalPath,
  contents = readFileSync(finalPath),
  pid = '4242',
  nonce = '0123456789abcdef',
) {
  const digest = createHash('sha256').update(contents).digest('hex');
  return join(
    dirname(finalPath),
    `.${basename(finalPath)}.init-v1.${pid}.${nonce}.${digest}.tmp`,
  );
}

function writeStateFile(sessionId, record) {
  const filePath = statePath(sessionId);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(record)}\n`);
  return filePath;
}

function simulatedIoError(message) {
  return Object.assign(new Error(message), { code: 'EIO' });
}

function found(mode) {
  return { kind: 'found', mode };
}

function unavailable() {
  return { kind: 'unavailable' };
}

function missing() {
  return { kind: 'missing' };
}

function assertOnlyStateFile(sessionId) {
  assert.deepEqual(readdirSync(join(dataDir, 'sessions')), [
    `${stateKey(sessionId)}.json`,
  ]);
}

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), 'caveman-state-'));
  dataDir = join(temporaryRoot, 'data');
  externalDir = join(temporaryRoot, 'external-dir');
  externalFile = join(temporaryRoot, 'external-state.json');
  mkdirSync(externalDir);
  writeFileSync(externalFile, JSON.stringify({
    schemaVersion: 1,
    mode: 'ultra',
    updatedAt: fixedNow().toISOString(),
  }));
});

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

test('state store does not expose a prune method', () => {
  const store = createStateStore(dataDir, { now: fixedNow });

  assert.equal('prune' in store, false);
});

test('state store does not export an automatic-expiry policy', () => {
  assert.equal(
    Object.hasOwn(require('../lib/state-store.cjs'), 'MAX_AGE_MS'),
    false,
  );
});

test('isolates modes by hashed session id', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  assert.equal(store.write('session-a', 'lite'), true);
  assert.equal(store.write('session-b', 'wenyan-full'), true);

  assert.deepEqual(store.read('session-a'), found('lite'));
  assert.deepEqual(store.read('session-b'), found('wenyan-full'));
  assert.match(stateKey('session-a'), /^[a-f0-9]{64}$/);
  assert.notEqual(stateKey('session-a'), stateKey('session-b'));
  assert.equal(stateKey(''), null);
  assert.equal(stateKey(1), null);
  assert.equal(stateKey('x'.repeat(4097)), null);
});

test('distinguishes confirmed missing from unavailable state', () => {
  const store = createStateStore(dataDir, { now: fixedNow });

  assert.deepEqual(store.read('missing'), missing());
  assert.deepEqual(store.read(''), unavailable());
  assert.deepEqual(store.read(1), unavailable());
  assert.deepEqual(
    store.initializeIfMissing('', 'wenyan-full'),
    unavailable(),
  );
  assert.deepEqual(
    store.initializeIfMissing(1, 'wenyan-full'),
    unavailable(),
  );
  assert.deepEqual(readdirSync(join(dataDir, 'sessions')), []);

  writeFileSync(statePath('malformed'), '{');
  assert.deepEqual(store.read('malformed'), unavailable());
});

test('read treats an initial canonical lstat failure as unavailable without writing', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'lstat-error';
  assert.equal(store.write(sessionId, 'lite'), true);
  const filePath = canonicalStatePath(sessionId);
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalLstat = fs.lstatSync;
  let failed = false;

  fs.lstatSync = function failingInitialLstat(candidate, ...args) {
    if (candidate === filePath && !failed) {
      failed = true;
      throw simulatedIoError('simulated initial lstat failure');
    }
    return originalLstat(candidate, ...args);
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.lstatSync = originalLstat;
  }

  assert.equal(failed, true);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), beforeContents);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assertOnlyStateFile(sessionId);
});

test('treats ENOENT after initial lstat as unavailable', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  assert.equal(store.write('raced-away', 'lite'), true);
  const filePath = canonicalStatePath('raced-away');
  const originalOpen = fs.openSync;
  let injected = false;

  fs.openSync = function disappearingAfterLstat(candidate, ...args) {
    if (candidate === filePath && !injected) {
      injected = true;
      throw Object.assign(new Error('simulated disappearance'), { code: 'ENOENT' });
    }
    return originalOpen(candidate, ...args);
  };
  try {
    assert.deepEqual(store.read('raced-away'), unavailable());
  } finally {
    fs.openSync = originalOpen;
  }

  assert.equal(injected, true);
  assert.deepEqual(store.read('raced-away'), found('lite'));
});

test('read rejects a symlink swapped in after initial lstat', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  assert.equal(store.write('symlink-swap', 'lite'), true);
  const filePath = canonicalStatePath('symlink-swap');
  const movedPath = join(temporaryRoot, 'moved-state.json');
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalOpen = fs.openSync;
  let swapped = false;

  fs.openSync = function swappingBeforeOpen(candidate, ...args) {
    if (candidate === filePath && !swapped) {
      swapped = true;
      fs.renameSync(filePath, movedPath);
      fs.symlinkSync(movedPath, filePath);
    }
    return originalOpen(candidate, ...args);
  };
  let outcome;
  try {
    outcome = store.read('symlink-swap');
  } finally {
    fs.openSync = originalOpen;
  }

  assert.deepEqual(outcome, unavailable());
  assert.equal(lstatSync(filePath).isSymbolicLink(), true);
  assert.deepEqual(readFileSync(movedPath), beforeContents);
  const afterStat = statSync(movedPath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
});

test('read rejects a regular replacement between lstat and open', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'regular-open-swap';
  assert.equal(store.write(sessionId, 'lite'), true);
  assert.equal(store.write('replacement-source', 'off'), true);
  const filePath = canonicalStatePath(sessionId);
  const replacementPath = canonicalStatePath('replacement-source');
  const movedPath = join(temporaryRoot, 'original-state.json');
  const originalContents = readFileSync(filePath);
  const originalStat = statSync(filePath);
  const replacementStat = statSync(replacementPath);
  const originalOpen = fs.openSync;
  let swapped = false;

  fs.openSync = function replacingBeforeOpen(candidate, ...args) {
    if (candidate === filePath && !swapped) {
      swapped = true;
      fs.renameSync(filePath, movedPath);
      fs.renameSync(replacementPath, filePath);
    }
    return originalOpen(candidate, ...args);
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.openSync = originalOpen;
  }

  assert.equal(swapped, true);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(store.read(sessionId), found('off'));
  assert.deepEqual(readFileSync(movedPath), originalContents);
  const movedStat = statSync(movedPath);
  assert.equal(movedStat.dev, originalStat.dev);
  assert.equal(movedStat.ino, originalStat.ino);
  const finalStat = statSync(filePath);
  assert.equal(finalStat.dev, replacementStat.dev);
  assert.equal(finalStat.ino, replacementStat.ino);
  assertOnlyStateFile(sessionId);
});

test('read treats initial descriptor stat failure as unavailable', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  assert.equal(store.write('fstat-error', 'lite'), true);
  const filePath = canonicalStatePath('fstat-error');
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalFstat = fs.fstatSync;
  let failed = false;

  fs.fstatSync = function failingInitialFstat(...args) {
    if (!failed) {
      failed = true;
      throw simulatedIoError('simulated initial fstat failure');
    }
    return originalFstat(...args);
  };
  let outcome;
  try {
    outcome = store.read('fstat-error');
  } finally {
    fs.fstatSync = originalFstat;
  }

  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), beforeContents);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
});

test('read rejects a nonregular opened descriptor', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  assert.equal(store.write('nonregular-descriptor', 'lite'), true);
  const filePath = canonicalStatePath('nonregular-descriptor');
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalFstat = fs.fstatSync;
  let replaced = false;

  fs.fstatSync = function nonregularInitialFstat(...args) {
    if (!replaced) {
      replaced = true;
      return { isFile: () => false };
    }
    return originalFstat(...args);
  };
  let outcome;
  try {
    outcome = store.read('nonregular-descriptor');
  } finally {
    fs.fstatSync = originalFstat;
  }

  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), beforeContents);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
});

test('read rejects a stable canonical record without exact private mode', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'unsafe-mode';
  assert.equal(store.write(sessionId, 'lite'), true);
  const filePath = canonicalStatePath(sessionId);
  fs.chmodSync(filePath, 0o644);
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);

  const outcome = store.read(sessionId);

  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), beforeContents);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.equal(afterStat.mode & 0o777, 0o644);
  assertOnlyStateFile(sessionId);
});

test('read rejects an opened descriptor owned by another uid', {
  skip: typeof process.getuid !== 'function',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'foreign-owner';
  assert.equal(store.write(sessionId, 'lite'), true);
  const filePath = canonicalStatePath(sessionId);
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalFstat = fs.fstatSync;
  let injected = false;

  fs.fstatSync = function foreignOwnerFstat(...args) {
    const stat = originalFstat(...args);
    if (injected) return stat;
    injected = true;
    return new Proxy(stat, {
      get(target, property) {
        if (property === 'uid') return process.getuid() + 1;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.fstatSync = originalFstat;
  }

  assert.equal(injected, true);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), beforeContents);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assertOnlyStateFile(sessionId);
});

test('read rejects a stable multiply linked canonical record without unlinking', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'multiply-linked';
  assert.equal(store.write(sessionId, 'lite'), true);
  const filePath = canonicalStatePath(sessionId);
  const aliasPath = join(temporaryRoot, 'state-hard-link.json');
  fs.linkSync(filePath, aliasPath);
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  assert.equal(beforeStat.nlink, 2);

  const outcome = store.read(sessionId);

  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), beforeContents);
  assert.deepEqual(readFileSync(aliasPath), beforeContents);
  const canonicalStat = statSync(filePath);
  const aliasStat = statSync(aliasPath);
  assert.equal(canonicalStat.dev, beforeStat.dev);
  assert.equal(canonicalStat.ino, beforeStat.ino);
  assert.equal(aliasStat.dev, beforeStat.dev);
  assert.equal(aliasStat.ino, beforeStat.ino);
  assert.equal(canonicalStat.nlink, 2);
  assertOnlyStateFile(sessionId);
});

test('read treats a descriptor read failure as unavailable without writing', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'read-error';
  assert.equal(store.write(sessionId, 'lite'), true);
  const filePath = canonicalStatePath(sessionId);
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalRead = fs.readSync;
  let failed = false;

  fs.readSync = function failingRead(...args) {
    if (!failed) {
      failed = true;
      throw simulatedIoError('simulated descriptor read failure');
    }
    return originalRead(...args);
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.readSync = originalRead;
  }

  assert.equal(failed, true);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), beforeContents);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assertOnlyStateFile(sessionId);
});

test('read rejects a short descriptor read that ends before the stated size', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'short-read';
  assert.equal(store.write(sessionId, 'lite'), true);
  const filePath = canonicalStatePath(sessionId);
  const canonicalContents = readFileSync(filePath);
  fs.appendFileSync(filePath, ' '.repeat(16));
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalRead = fs.readSync;
  let reads = 0;

  fs.readSync = function endingEarly(fd, buffer, offset, length, position) {
    reads += 1;
    if (reads === 1) {
      return originalRead(
        fd,
        buffer,
        offset,
        Math.min(length, canonicalContents.length),
        position,
      );
    }
    return 0;
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.readSync = originalRead;
  }

  assert.equal(reads, 2);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), beforeContents);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assertOnlyStateFile(sessionId);
});

test('read rejects a canonical record that grows during descriptor read', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'growing-read';
  assert.equal(store.write(sessionId, 'lite'), true);
  const filePath = canonicalStatePath(sessionId);
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalRead = fs.readSync;
  let grown = false;

  fs.readSync = function growingRead(...args) {
    const bytesRead = originalRead(...args);
    if (!grown) {
      grown = true;
      fs.appendFileSync(filePath, ' ');
    }
    return bytesRead;
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.readSync = originalRead;
  }

  assert.equal(grown, true);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), Buffer.concat([
    beforeContents,
    Buffer.from(' '),
  ]));
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assertOnlyStateFile(sessionId);
});

test('read rejects a canonical record truncated during descriptor read', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'truncated-read';
  assert.equal(store.write(sessionId, 'lite'), true);
  const filePath = canonicalStatePath(sessionId);
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const winnerContents = beforeContents.subarray(0, beforeContents.length - 1);
  const originalRead = fs.readSync;
  let truncated = false;

  fs.readSync = function truncatingRead(...args) {
    const bytesRead = originalRead(...args);
    if (!truncated) {
      truncated = true;
      fs.truncateSync(filePath, winnerContents.length);
    }
    return bytesRead;
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.readSync = originalRead;
  }

  assert.equal(truncated, true);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), winnerContents);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assertOnlyStateFile(sessionId);
});

test('read treats the post-read descriptor stat failure as unavailable', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'post-read-fstat-error';
  assert.equal(store.write(sessionId, 'lite'), true);
  const filePath = canonicalStatePath(sessionId);
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalFstat = fs.fstatSync;
  let calls = 0;

  fs.fstatSync = function failingPostReadFstat(...args) {
    calls += 1;
    if (calls === 2) {
      throw simulatedIoError('simulated post-read fstat failure');
    }
    return originalFstat(...args);
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.fstatSync = originalFstat;
  }

  assert.equal(calls, 2);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), beforeContents);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assertOnlyStateFile(sessionId);
});

test('read rejects descriptor identity drift after reading', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'descriptor-identity-drift';
  assert.equal(store.write(sessionId, 'lite'), true);
  const filePath = canonicalStatePath(sessionId);
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalFstat = fs.fstatSync;
  let calls = 0;

  fs.fstatSync = function driftingPostReadIdentity(...args) {
    const stat = originalFstat(...args);
    calls += 1;
    if (calls !== 2) return stat;
    return new Proxy(stat, {
      get(target, property) {
        if (property === 'ino') return target.ino + 1;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.fstatSync = originalFstat;
  }

  assert.equal(calls, 2);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), beforeContents);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assertOnlyStateFile(sessionId);
});

test('read rejects a modification-time change during descriptor read', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'mtime-drift';
  assert.equal(store.write(sessionId, 'lite'), true);
  const filePath = canonicalStatePath(sessionId);
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const winnerMtime = new Date(beforeStat.mtimeMs + 2000);
  const originalRead = fs.readSync;
  let changed = false;

  fs.readSync = function changingMtime(...args) {
    const bytesRead = originalRead(...args);
    if (!changed) {
      changed = true;
      fs.utimesSync(filePath, beforeStat.atime, winnerMtime);
    }
    return bytesRead;
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.readSync = originalRead;
  }

  assert.equal(changed, true);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), beforeContents);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.equal(afterStat.mtimeMs, winnerMtime.getTime());
  assertOnlyStateFile(sessionId);
});

test('treats canonical replacement during a read as unavailable', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  assert.equal(store.write('replaced-during-read', 'lite'), true);
  const originalRead = fs.readSync;
  let interleaved = false;

  fs.readSync = function replacingRead(...args) {
    const result = originalRead(...args);
    if (!interleaved) {
      interleaved = true;
      assert.equal(store.write('replaced-during-read', 'off'), true);
    }
    return result;
  };
  let outcome;
  try {
    outcome = store.read('replaced-during-read');
  } finally {
    fs.readSync = originalRead;
  }

  assert.equal(interleaved, true);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(store.read('replaced-during-read'), found('off'));
});

test('read rejects a mode change during descriptor read', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  assert.equal(store.write('mode-drift', 'lite'), true);
  const filePath = canonicalStatePath('mode-drift');
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalRead = fs.readSync;
  let changed = false;

  fs.readSync = function changingMode(...args) {
    const result = originalRead(...args);
    if (!changed) {
      changed = true;
      fs.chmodSync(filePath, 0o644);
    }
    return result;
  };
  let outcome;
  try {
    outcome = store.read('mode-drift');
  } finally {
    fs.readSync = originalRead;
  }

  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), beforeContents);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.equal(afterStat.mode & 0o777, 0o644);
});

test('read rejects owner drift after descriptor read', {
  skip: typeof process.getuid !== 'function',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'owner-drift';
  assert.equal(store.write(sessionId, 'lite'), true);
  const filePath = canonicalStatePath(sessionId);
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalFstat = fs.fstatSync;
  let calls = 0;

  fs.fstatSync = function driftingPostReadOwner(...args) {
    const stat = originalFstat(...args);
    calls += 1;
    if (calls !== 2) return stat;
    return new Proxy(stat, {
      get(target, property) {
        if (property === 'uid') return process.getuid() + 1;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.fstatSync = originalFstat;
  }

  assert.equal(calls, 2);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), beforeContents);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assertOnlyStateFile(sessionId);
});

test('read rejects group drift between descriptor and pathname metadata', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'group-drift';
  assert.equal(store.write(sessionId, 'lite'), true);
  const filePath = canonicalStatePath(sessionId);
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalFstat = fs.fstatSync;
  let fileStats = 0;

  fs.fstatSync = function driftingDescriptorGroup(...args) {
    const stat = originalFstat(...args);
    if (!stat.isFile()) return stat;
    fileStats += 1;
    return new Proxy(stat, {
      get(target, property) {
        if (property === 'gid') return target.gid + 1;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.fstatSync = originalFstat;
  }

  assert.ok(fileStats >= 2);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), beforeContents);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assertOnlyStateFile(sessionId);
});

test('read rejects a hard link added during descriptor read without unlinking', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'link-count-drift';
  assert.equal(store.write(sessionId, 'lite'), true);
  const filePath = canonicalStatePath(sessionId);
  const aliasPath = join(temporaryRoot, 'concurrent-state-link.json');
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalRead = fs.readSync;
  let linked = false;

  fs.readSync = function linkingDuringRead(...args) {
    const bytesRead = originalRead(...args);
    if (!linked) {
      linked = true;
      fs.linkSync(filePath, aliasPath);
    }
    return bytesRead;
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.readSync = originalRead;
  }

  assert.equal(linked, true);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), beforeContents);
  assert.deepEqual(readFileSync(aliasPath), beforeContents);
  const canonicalStat = statSync(filePath);
  const aliasStat = statSync(aliasPath);
  assert.equal(canonicalStat.dev, beforeStat.dev);
  assert.equal(canonicalStat.ino, beforeStat.ino);
  assert.equal(aliasStat.dev, beforeStat.dev);
  assert.equal(aliasStat.ino, beforeStat.ino);
  assert.equal(canonicalStat.nlink, 2);
  assertOnlyStateFile(sessionId);
});

test('read rejects status-change time drift during descriptor read', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'ctime-drift';
  assert.equal(store.write(sessionId, 'lite'), true);
  const filePath = canonicalStatePath(sessionId);
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalRead = fs.readSync;
  let changed = false;

  fs.readSync = function changingStatusTwice(...args) {
    const bytesRead = originalRead(...args);
    if (!changed) {
      changed = true;
      fs.chmodSync(filePath, 0o644);
      fs.chmodSync(filePath, 0o600);
    }
    return bytesRead;
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.readSync = originalRead;
  }

  assert.equal(changed, true);
  const afterStat = statSync(filePath);
  assert.notEqual(afterStat.ctimeMs, beforeStat.ctimeMs);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), beforeContents);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.equal(afterStat.mode & 0o777, 0o600);
  assertOnlyStateFile(sessionId);
});

test('read treats the final canonical lstat failure as unavailable', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'final-lstat-error';
  assert.equal(store.write(sessionId, 'lite'), true);
  const filePath = canonicalStatePath(sessionId);
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalLstat = fs.lstatSync;
  let calls = 0;

  fs.lstatSync = function failingFinalLstat(candidate, ...args) {
    if (candidate === filePath) {
      calls += 1;
      if (calls === 2) {
        throw simulatedIoError('simulated final lstat failure');
      }
    }
    return originalLstat(candidate, ...args);
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.lstatSync = originalLstat;
  }

  assert.equal(calls, 2);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), beforeContents);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assertOnlyStateFile(sessionId);
});

test('read treats ENOENT from the final canonical lstat as unavailable', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'final-lstat-enoent';
  assert.equal(store.write(sessionId, 'lite'), true);
  const filePath = canonicalStatePath(sessionId);
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalLstat = fs.lstatSync;
  let calls = 0;

  fs.lstatSync = function missingAtFinalLstat(candidate, ...args) {
    if (candidate === filePath) {
      calls += 1;
      if (calls === 2) {
        throw Object.assign(new Error('simulated final disappearance'), {
          code: 'ENOENT',
        });
      }
    }
    return originalLstat(candidate, ...args);
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.lstatSync = originalLstat;
  }

  assert.equal(calls, 2);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), beforeContents);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assertOnlyStateFile(sessionId);
});

test('read rejects a canonical record that grows before final path validation', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'final-size-drift';
  assert.equal(store.write(sessionId, 'lite'), true);
  const filePath = canonicalStatePath(sessionId);
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalLstat = fs.lstatSync;
  let calls = 0;

  fs.lstatSync = function growingBeforeFinalLstat(candidate, ...args) {
    if (candidate === filePath) {
      calls += 1;
      if (calls === 2) fs.appendFileSync(filePath, ' ');
    }
    return originalLstat(candidate, ...args);
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.lstatSync = originalLstat;
  }

  assert.equal(calls, 2);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), Buffer.concat([
    beforeContents,
    Buffer.from(' '),
  ]));
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assertOnlyStateFile(sessionId);
});

test('read rejects modification-time drift before final path validation', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'final-mtime-drift';
  assert.equal(store.write(sessionId, 'lite'), true);
  const filePath = canonicalStatePath(sessionId);
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const winnerMtime = new Date(beforeStat.mtimeMs + 2000);
  const originalLstat = fs.lstatSync;
  let calls = 0;

  fs.lstatSync = function changingMtimeBeforeFinalLstat(candidate, ...args) {
    if (candidate === filePath) {
      calls += 1;
      if (calls === 2) {
        fs.utimesSync(filePath, beforeStat.atime, winnerMtime);
      }
    }
    return originalLstat(candidate, ...args);
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.lstatSync = originalLstat;
  }

  assert.equal(calls, 2);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), beforeContents);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.equal(afterStat.mtimeMs, winnerMtime.getTime());
  assertOnlyStateFile(sessionId);
});

test('read rejects mode drift before final path validation', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'final-mode-drift';
  assert.equal(store.write(sessionId, 'lite'), true);
  const filePath = canonicalStatePath(sessionId);
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalLstat = fs.lstatSync;
  let calls = 0;

  fs.lstatSync = function changingModeBeforeFinalLstat(candidate, ...args) {
    if (candidate === filePath) {
      calls += 1;
      if (calls === 2) fs.chmodSync(filePath, 0o644);
    }
    return originalLstat(candidate, ...args);
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.lstatSync = originalLstat;
  }

  assert.equal(calls, 2);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), beforeContents);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.equal(afterStat.mode & 0o777, 0o644);
  assertOnlyStateFile(sessionId);
});

test('read rejects owner drift at final path validation', {
  skip: typeof process.getuid !== 'function',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'final-owner-drift';
  assert.equal(store.write(sessionId, 'lite'), true);
  const filePath = canonicalStatePath(sessionId);
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalLstat = fs.lstatSync;
  let calls = 0;

  fs.lstatSync = function driftingOwnerAtFinalLstat(candidate, ...args) {
    const stat = originalLstat(candidate, ...args);
    if (candidate !== filePath) return stat;
    calls += 1;
    if (calls !== 2) return stat;
    return new Proxy(stat, {
      get(target, property) {
        if (property === 'uid') return process.getuid() + 1;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.lstatSync = originalLstat;
  }

  assert.equal(calls, 2);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), beforeContents);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assertOnlyStateFile(sessionId);
});

test('read rejects a hard link added before final path validation without unlinking', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'final-link-count-drift';
  assert.equal(store.write(sessionId, 'lite'), true);
  const filePath = canonicalStatePath(sessionId);
  const aliasPath = join(temporaryRoot, 'final-concurrent-state-link.json');
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalLstat = fs.lstatSync;
  let calls = 0;

  fs.lstatSync = function linkingBeforeFinalLstat(candidate, ...args) {
    if (candidate === filePath) {
      calls += 1;
      if (calls === 2) fs.linkSync(filePath, aliasPath);
    }
    return originalLstat(candidate, ...args);
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.lstatSync = originalLstat;
  }

  assert.equal(calls, 2);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), beforeContents);
  assert.deepEqual(readFileSync(aliasPath), beforeContents);
  const canonicalStat = statSync(filePath);
  const aliasStat = statSync(aliasPath);
  assert.equal(canonicalStat.dev, beforeStat.dev);
  assert.equal(canonicalStat.ino, beforeStat.ino);
  assert.equal(aliasStat.dev, beforeStat.dev);
  assert.equal(aliasStat.ino, beforeStat.ino);
  assert.equal(canonicalStat.nlink, 2);
  assertOnlyStateFile(sessionId);
});

test('read rejects status-change time drift before final path validation', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'final-ctime-drift';
  assert.equal(store.write(sessionId, 'lite'), true);
  const filePath = canonicalStatePath(sessionId);
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalLstat = fs.lstatSync;
  let calls = 0;

  fs.lstatSync = function changingStatusBeforeFinalLstat(candidate, ...args) {
    if (candidate === filePath) {
      calls += 1;
      if (calls === 2) {
        fs.chmodSync(filePath, 0o644);
        fs.chmodSync(filePath, 0o600);
      }
    }
    return originalLstat(candidate, ...args);
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.lstatSync = originalLstat;
  }

  assert.equal(calls, 2);
  const afterStat = statSync(filePath);
  assert.notEqual(afterStat.ctimeMs, beforeStat.ctimeMs);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), beforeContents);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.equal(afterStat.mode & 0o777, 0o600);
  assertOnlyStateFile(sessionId);
});

test('read rejects a sessions-root symlink swap that preserves record identity', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'root-symlink-swap';
  assert.equal(store.write(sessionId, 'lite'), true);
  const sessionsDir = join(dataDir, 'sessions');
  const movedSessionsDir = join(temporaryRoot, 'moved-sessions');
  const filePath = canonicalStatePath(sessionId);
  const movedFilePath = join(movedSessionsDir, `${stateKey(sessionId)}.json`);
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalRead = fs.readSync;
  let swapped = false;

  fs.readSync = function swappingSessionsRoot(...args) {
    const bytesRead = originalRead(...args);
    if (!swapped) {
      swapped = true;
      fs.renameSync(sessionsDir, movedSessionsDir);
      symlinkSync(movedSessionsDir, sessionsDir);
    }
    return bytesRead;
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.readSync = originalRead;
  }

  assert.equal(swapped, true);
  assert.deepEqual(outcome, unavailable());
  assert.equal(lstatSync(sessionsDir).isSymbolicLink(), true);
  assert.deepEqual(readFileSync(movedFilePath), beforeContents);
  const afterStat = statSync(movedFilePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.deepEqual(readdirSync(movedSessionsDir), [
    `${stateKey(sessionId)}.json`,
  ]);
});

test('read rejects replacement of the sessions root with the same record inode', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'root-replaced-during-read';
  assert.equal(store.write(sessionId, 'lite'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const fileName = `${stateKey(sessionId)}.json`;
  const filePath = join(sessionsDir, fileName);
  const displacedDir = join(temporaryRoot, 'displaced-sessions');
  const originalRoot = lstatSync(sessionsDir);
  const originalRecord = lstatSync(filePath);
  const originalContents = readFileSync(filePath);
  const originalLstat = fs.lstatSync;
  let canonicalLstats = 0;
  let replaced = false;

  fs.lstatSync = function replaceRootAfterFinalRecordSample(candidate, ...args) {
    const sampled = originalLstat(candidate, ...args);
    if (candidate === filePath) {
      canonicalLstats += 1;
      if (canonicalLstats === 2) {
        replaced = true;
        fs.renameSync(sessionsDir, displacedDir);
        fs.mkdirSync(sessionsDir, { mode: 0o700 });
        fs.renameSync(join(displacedDir, fileName), filePath);
      }
    }
    return sampled;
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.lstatSync = originalLstat;
  }

  assert.equal(replaced, true);
  const replacementRoot = lstatSync(sessionsDir);
  const finalRecord = lstatSync(filePath);
  assert.notEqual(replacementRoot.ino, originalRoot.ino);
  assert.equal(finalRecord.dev, originalRecord.dev);
  assert.equal(finalRecord.ino, originalRecord.ino);
  assert.deepEqual(readFileSync(filePath), originalContents);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readdirSync(displacedDir), []);
  assertOnlyStateFile(sessionId);
});

test('read rejects invalid UTF-8 even when replacement decoding would form valid JSON', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'invalid-utf8';
  assert.equal(store.write(sessionId, 'lite'), true);
  const filePath = canonicalStatePath(sessionId);
  const invalidContents = Buffer.concat([
    Buffer.from(
      `{"schemaVersion":1,"mode":"lite","updatedAt":"${fixedNow().toISOString()}","note":"`,
    ),
    Buffer.from([0x80]),
    Buffer.from('"}\n'),
  ]);
  writeFileSync(filePath, invalidContents);
  const beforeStat = statSync(filePath);

  const outcome = store.read(sessionId);

  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), invalidContents);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assertOnlyStateFile(sessionId);
});

test('read treats descriptor close failure as unavailable without writing', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'close-error';
  assert.equal(store.write(sessionId, 'lite'), true);
  const filePath = canonicalStatePath(sessionId);
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalClose = fs.closeSync;
  let failed = false;

  fs.closeSync = function failingClose(fd) {
    originalClose(fd);
    failed = true;
    throw simulatedIoError('simulated descriptor close failure');
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.closeSync = originalClose;
  }

  assert.equal(failed, true);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), beforeContents);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assertOnlyStateFile(sessionId);
});

test('transient read failure cannot overwrite a stored off mode', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  assert.equal(store.write('session-off', 'off'), true);
  const filePath = canonicalStatePath('session-off');
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalOpen = fs.openSync;
  let injected = false;

  fs.openSync = function failingOnce(candidate, ...args) {
    if (candidate === filePath && !injected) {
      injected = true;
      throw simulatedIoError('simulated transient read failure');
    }
    return originalOpen(candidate, ...args);
  };
  try {
    assert.deepEqual(
      store.initializeIfMissing('session-off', 'wenyan-full'),
      unavailable(),
    );
  } finally {
    fs.openSync = originalOpen;
  }

  assert.equal(injected, true);
  assert.deepEqual(store.read('session-off'), found('off'));
  assert.deepEqual(readFileSync(filePath), beforeContents);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assertOnlyStateFile('session-off');
});

test('read requires a parent barrier before accepting a sole-link record', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'read-final-only-barrier';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const filePath = canonicalStatePath(sessionId);
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalOpen = fs.openSync;
  let failed = false;

  fs.openSync = function failReadParentBarrier(candidate, ...args) {
    if (candidate === sessionsDir && !failed) {
      failed = true;
      throw simulatedIoError('simulated read parent barrier failure');
    }
    return originalOpen(candidate, ...args);
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.openSync = originalOpen;
  }

  assert.equal(failed, true);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), beforeContents);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assertOnlyStateFile(sessionId);
});

test('read normalizes one strict same-inode publication alias', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'read-recovers-publication-alias';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const aliasPath = initializationAliasPath(canonicalPath);
  fs.linkSync(canonicalPath, aliasPath);
  const beforeContents = readFileSync(canonicalPath);
  const beforeStat = statSync(canonicalPath);
  assert.equal(beforeStat.nlink, 2);

  const outcome = store.read(sessionId);

  assert.deepEqual(outcome, found('off'));
  assert.equal(existsSync(aliasPath), false);
  assert.deepEqual(readFileSync(canonicalPath), beforeContents);
  const afterStat = statSync(canonicalPath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.equal(afterStat.nlink, 1);
  assertOnlyStateFile(sessionId);
});

test('read revalidates when another normalizer wins after initial close', {
  skip: process.platform === 'win32',
}, () => {
  const firstStore = createStateStore(dataDir, { now: fixedNow });
  const secondStore = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'read-normalizer-wins-after-initial-close';
  assert.equal(firstStore.write(sessionId, 'off'), true);
  const canonicalPath = canonicalStatePath(sessionId);
  const aliasPath = initializationAliasPath(canonicalPath);
  fs.linkSync(canonicalPath, aliasPath);
  const beforeContents = readFileSync(canonicalPath);
  const beforeStat = statSync(canonicalPath);
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let initialFd;
  let interleaved = false;
  let secondOutcome;

  fs.openSync = function captureInitialCanonical(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (candidate === canonicalPath && initialFd === undefined) initialFd = fd;
    return fd;
  };
  fs.closeSync = function normalizeAfterInitialClose(fd, ...args) {
    const result = originalClose(fd, ...args);
    if (fd === initialFd && !interleaved) {
      interleaved = true;
      secondOutcome = secondStore.initializeIfMissing(
        sessionId,
        'wenyan-full',
      );
    }
    return result;
  };
  let firstOutcome;
  try {
    firstOutcome = firstStore.read(sessionId);
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
  }

  assert.equal(interleaved, true);
  assert.deepEqual(secondOutcome, found('off'));
  assert.deepEqual(firstOutcome, found('off'));
  assert.equal(existsSync(aliasPath), false);
  assert.deepEqual(readFileSync(canonicalPath), beforeContents);
  const afterStat = statSync(canonicalPath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.equal(afterStat.nlink, 1);
  assertOnlyStateFile(sessionId);
});

test('read never recovers a two-link pair after initial close failure', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'pair-initial-close-failure';
  assert.equal(store.write(sessionId, 'off'), true);
  const canonicalPath = canonicalStatePath(sessionId);
  const aliasPath = initializationAliasPath(canonicalPath);
  fs.linkSync(canonicalPath, aliasPath);
  const beforeContents = readFileSync(canonicalPath);
  const beforeStat = statSync(canonicalPath);
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let initialFd;
  let failed = false;

  fs.openSync = function captureInitialCanonical(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (candidate === canonicalPath && initialFd === undefined) initialFd = fd;
    return fd;
  };
  fs.closeSync = function failInitialCanonicalClose(fd, ...args) {
    const result = originalClose(fd, ...args);
    if (fd === initialFd && !failed) {
      failed = true;
      throw simulatedIoError('simulated initial canonical close failure');
    }
    return result;
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
  }

  assert.equal(failed, true);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(aliasPath), true);
  assert.deepEqual(readFileSync(canonicalPath), beforeContents);
  assert.deepEqual(readFileSync(aliasPath), beforeContents);
  const canonicalStat = statSync(canonicalPath);
  const aliasStat = statSync(aliasPath);
  assert.equal(canonicalStat.dev, beforeStat.dev);
  assert.equal(canonicalStat.ino, beforeStat.ino);
  assert.equal(aliasStat.dev, beforeStat.dev);
  assert.equal(aliasStat.ino, beforeStat.ino);
  assert.equal(canonicalStat.nlink, 2);
});

test('read never recovers a two-link pair after initial open failure', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'pair-initial-open-failure';
  assert.equal(store.write(sessionId, 'off'), true);
  const canonicalPath = canonicalStatePath(sessionId);
  const aliasPath = initializationAliasPath(canonicalPath);
  fs.linkSync(canonicalPath, aliasPath);
  const beforeContents = readFileSync(canonicalPath);
  const beforeStat = statSync(canonicalPath);
  const originalOpen = fs.openSync;
  let failed = false;

  fs.openSync = function failInitialCanonicalOpen(candidate, ...args) {
    if (candidate === canonicalPath && !failed) {
      failed = true;
      throw simulatedIoError('simulated initial canonical open failure');
    }
    return originalOpen(candidate, ...args);
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.openSync = originalOpen;
  }

  assert.equal(failed, true);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(aliasPath), true);
  assert.deepEqual(readFileSync(canonicalPath), beforeContents);
  assert.deepEqual(readFileSync(aliasPath), beforeContents);
  const canonicalStat = statSync(canonicalPath);
  const aliasStat = statSync(aliasPath);
  assert.equal(canonicalStat.dev, beforeStat.dev);
  assert.equal(canonicalStat.ino, beforeStat.ino);
  assert.equal(aliasStat.dev, beforeStat.dev);
  assert.equal(aliasStat.ino, beforeStat.ino);
  assert.equal(canonicalStat.nlink, 2);
});

test('read never recovers a two-link pair after alias observation failure', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'pair-alias-observation-failure';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const aliasPath = initializationAliasPath(canonicalPath);
  fs.linkSync(canonicalPath, aliasPath);
  const beforeContents = readFileSync(canonicalPath);
  const beforeStat = statSync(canonicalPath);
  const originalReaddir = fs.readdirSync;
  let failed = false;

  fs.readdirSync = function failInitialAliasObservation(candidate, ...args) {
    if (candidate === sessionsDir && !failed) {
      failed = true;
      throw simulatedIoError('simulated alias observation failure');
    }
    return originalReaddir(candidate, ...args);
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.readdirSync = originalReaddir;
  }

  assert.equal(failed, true);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(aliasPath), true);
  assert.deepEqual(readFileSync(canonicalPath), beforeContents);
  assert.deepEqual(readFileSync(aliasPath), beforeContents);
  const canonicalStat = statSync(canonicalPath);
  const aliasStat = statSync(aliasPath);
  assert.equal(canonicalStat.dev, beforeStat.dev);
  assert.equal(canonicalStat.ino, beforeStat.ino);
  assert.equal(aliasStat.dev, beforeStat.dev);
  assert.equal(aliasStat.ino, beforeStat.ino);
  assert.equal(canonicalStat.nlink, 2);
});

test('read never recovers a pair after observer root-check failure', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'pair-observer-root-check-failure';
  assert.equal(store.write(sessionId, 'off'), true);
  const dataRoot = realpathSync(dataDir);
  const canonicalPath = canonicalStatePath(sessionId);
  const aliasPath = initializationAliasPath(canonicalPath);
  fs.linkSync(canonicalPath, aliasPath);
  const beforeContents = readFileSync(canonicalPath);
  const beforeStat = statSync(canonicalPath);
  const originalOpen = fs.openSync;
  const originalFstat = fs.fstatSync;
  const originalRealpath = fs.realpathSync;
  let canonicalFd;
  let descriptorObserved = false;
  let failed = false;

  fs.openSync = function captureInitialCanonical(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (candidate === canonicalPath && canonicalFd === undefined) {
      canonicalFd = fd;
    }
    return fd;
  };
  fs.fstatSync = function observeInitialCanonical(fd, ...args) {
    const stat = originalFstat(fd, ...args);
    if (fd === canonicalFd) descriptorObserved = true;
    return stat;
  };
  fs.realpathSync = function failObserverRootCheck(candidate, ...args) {
    if (descriptorObserved && candidate === dataRoot && !failed) {
      failed = true;
      throw simulatedIoError('simulated observer root-check failure');
    }
    return originalRealpath(candidate, ...args);
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.openSync = originalOpen;
    fs.fstatSync = originalFstat;
    fs.realpathSync = originalRealpath;
  }

  assert.equal(failed, true);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(aliasPath), true);
  assert.deepEqual(readFileSync(canonicalPath), beforeContents);
  assert.deepEqual(readFileSync(aliasPath), beforeContents);
  const canonicalStat = statSync(canonicalPath);
  const aliasStat = statSync(aliasPath);
  assert.equal(canonicalStat.dev, beforeStat.dev);
  assert.equal(canonicalStat.ino, beforeStat.ino);
  assert.equal(aliasStat.dev, beforeStat.dev);
  assert.equal(aliasStat.ino, beforeStat.ino);
  assert.equal(canonicalStat.nlink, 2);
});

test('read never adopts an alias first published after initial close', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'alias-first-published-after-initial-close';
  assert.equal(store.write(sessionId, 'off'), true);
  const canonicalPath = canonicalStatePath(sessionId);
  const foreignLinkPath = join(temporaryRoot, 'pre-observation-foreign-link');
  const aliasPath = initializationAliasPath(canonicalPath);
  fs.linkSync(canonicalPath, foreignLinkPath);
  const beforeContents = readFileSync(canonicalPath);
  const beforeStat = statSync(canonicalPath);
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let initialFd;
  let interleaved = false;

  fs.openSync = function captureInitialCanonical(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (candidate === canonicalPath && initialFd === undefined) initialFd = fd;
    return fd;
  };
  fs.closeSync = function publishAliasAfterInitialClose(fd, ...args) {
    const result = originalClose(fd, ...args);
    if (fd === initialFd && !interleaved) {
      interleaved = true;
      fs.unlinkSync(foreignLinkPath);
      fs.linkSync(canonicalPath, aliasPath);
    }
    return result;
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
  }

  assert.equal(interleaved, true);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(aliasPath), true);
  assert.deepEqual(readFileSync(canonicalPath), beforeContents);
  assert.deepEqual(readFileSync(aliasPath), beforeContents);
  const canonicalStat = statSync(canonicalPath);
  const aliasStat = statSync(aliasPath);
  assert.equal(canonicalStat.dev, beforeStat.dev);
  assert.equal(canonicalStat.ino, beforeStat.ino);
  assert.equal(aliasStat.dev, beforeStat.dev);
  assert.equal(aliasStat.ino, beforeStat.ino);
  assert.equal(canonicalStat.nlink, 2);
});

test('initializes a missing session as a private canonical record', () => {
  const store = createStateStore(dataDir, { now: fixedNow });

  assert.deepEqual(
    store.initializeIfMissing('new-session', ' WENYAN '),
    found('wenyan-full'),
  );
  const filePath = canonicalStatePath('new-session');
  assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), {
    schemaVersion: 1,
    mode: 'wenyan-full',
    updatedAt: fixedNow().toISOString(),
  });
  if (process.platform !== 'win32') {
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
  }
  assertOnlyStateFile('new-session');
});

test('initialization requires durable publication of a new sessions directory', () => {
  mkdirSync(dataDir, { mode: 0o700 });
  const dataRoot = realpathSync(dataDir);
  const originalOpen = fs.openSync;
  let failed = false;

  fs.openSync = function failSessionsParentBarrier(candidate, ...args) {
    if (candidate === dataRoot && !failed) {
      failed = true;
      throw simulatedIoError('simulated sessions parent barrier failure');
    }
    return originalOpen(candidate, ...args);
  };
  let outcome;
  try {
    const store = createStateStore(dataDir, { now: fixedNow });
    outcome = store.initializeIfMissing(
      'sessions-parent-barrier',
      'wenyan-full',
    );
  } finally {
    fs.openSync = originalOpen;
  }

  assert.equal(failed, true);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readdirSync(join(dataRoot, 'sessions')), []);
});

test('a later store cannot forget a sessions-directory parent barrier debt', () => {
  mkdirSync(dataDir, { mode: 0o700 });
  const dataRoot = realpathSync(dataDir);
  const sessionId = 'persistent-sessions-parent-barrier';
  const originalOpen = fs.openSync;
  let failBarrier = true;
  let failures = 0;

  fs.openSync = function failDataRootBarrier(candidate, ...args) {
    if (candidate === dataRoot && failBarrier) {
      failures += 1;
      throw simulatedIoError('simulated persistent data-root barrier failure');
    }
    return originalOpen(candidate, ...args);
  };
  let first;
  let second;
  let recovered;
  try {
    first = createStateStore(dataDir, { now: fixedNow })
      .initializeIfMissing(sessionId, 'wenyan-full');
    second = createStateStore(dataDir, { now: fixedNow })
      .initializeIfMissing(sessionId, 'wenyan-full');
    failBarrier = false;
    recovered = createStateStore(dataDir, { now: fixedNow })
      .initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.openSync = originalOpen;
  }

  assert.ok(failures >= 2);
  assert.deepEqual(first, unavailable());
  assert.deepEqual(second, unavailable());
  assert.deepEqual(recovered, found('wenyan-full'));
  assertOnlyStateFile(sessionId);
});

test('initialization preserves an existing active mode', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const originalTime = new Date(FIXED_TIME - 1_000);
  assert.equal(store.write('existing', 'ultra', originalTime), true);
  const filePath = canonicalStatePath('existing');
  const before = readFileSync(filePath, 'utf8');

  assert.deepEqual(
    store.initializeIfMissing('existing', 'wenyan-full'),
    found('ultra'),
  );
  assert.equal(readFileSync(filePath, 'utf8'), before);
});

test('initialization requires a parent barrier before accepting a final-only record', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'final-only-barrier';
  assert.equal(store.write(sessionId, 'ultra'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const filePath = canonicalStatePath(sessionId);
  const beforeContents = readFileSync(filePath);
  const beforeStat = statSync(filePath);
  const originalOpen = fs.openSync;
  let failed = false;

  fs.openSync = function failingFinalOnlyBarrier(candidate, ...args) {
    if (candidate === sessionsDir && !failed) {
      failed = true;
      throw simulatedIoError('simulated final-only reader barrier failure');
    }
    return originalOpen(candidate, ...args);
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.openSync = originalOpen;
  }

  assert.equal(failed, true);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), beforeContents);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assertOnlyStateFile(sessionId);
});

test('initialization rejects a valid final replaced after its reader barrier', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'existing-final-replaced-after-barrier';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const replacementPath = join(temporaryRoot, 'replacement-after-barrier.json');
  const replacementContents = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    mode: 'ultra',
    updatedAt: fixedNow().toISOString(),
  })}\n`);
  writeFileSync(replacementPath, replacementContents, { mode: 0o600 });
  fs.chmodSync(replacementPath, 0o600);
  const replacementStat = statSync(replacementPath);
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let directoryOpens = 0;
  let barrierReopenFd;
  let replaced = false;

  fs.openSync = function captureBarrierReopen(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (candidate === sessionsDir) {
      directoryOpens += 1;
      if (directoryOpens === 2) barrierReopenFd = fd;
    }
    return fd;
  };
  fs.closeSync = function replaceFinalAfterBarrier(fd, ...args) {
    const result = originalClose(fd, ...args);
    if (fd === barrierReopenFd && !replaced) {
      replaced = true;
      fs.renameSync(replacementPath, canonicalPath);
    }
    return result;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
  }

  assert.equal(replaced, true);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(store.read(sessionId), found('ultra'));
  assert.deepEqual(readFileSync(canonicalPath), replacementContents);
  const finalStat = statSync(canonicalPath);
  assert.equal(finalStat.dev, replacementStat.dev);
  assert.equal(finalStat.ino, replacementStat.ino);
  assertOnlyStateFile(sessionId);
});

test('initialization normalizes one strict same-inode publication alias', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'recover-publication-alias';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const aliasPath = initializationAliasPath(canonicalPath);
  fs.linkSync(canonicalPath, aliasPath);
  const beforeContents = readFileSync(canonicalPath);
  const beforeStat = statSync(canonicalPath);
  assert.equal(beforeStat.nlink, 2);

  const outcome = store.initializeIfMissing(sessionId, 'wenyan-full');

  assert.deepEqual(outcome, found('off'));
  assert.equal(existsSync(aliasPath), false);
  assert.deepEqual(readFileSync(canonicalPath), beforeContents);
  const afterStat = statSync(canonicalPath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.equal(afterStat.nlink, 1);
  assertOnlyStateFile(sessionId);
});

test('read resumes a digest-bound publication pair already in quarantine', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'resume-publication-pair-in-quarantine';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const canonicalContents = readFileSync(canonicalPath);
  const digest = createHash('sha256').update(canonicalContents).digest('hex');
  const quarantinePath = join(
    sessionsDir,
    `.${basename(canonicalPath)}.q.publication-alias.${digest}.0123456789abcdef.${'34'.repeat(8)}`,
  );
  mkdirSync(quarantinePath, { mode: 0o700 });
  fs.chmodSync(quarantinePath, 0o700);
  const entryPath = join(quarantinePath, 'entry');
  fs.linkSync(canonicalPath, entryPath);
  const beforeStat = statSync(canonicalPath);
  assert.equal(beforeStat.nlink, 2);

  const outcome = store.read(sessionId);

  assert.deepEqual(outcome, found('off'));
  assert.equal(existsSync(quarantinePath), false);
  assert.deepEqual(readFileSync(canonicalPath), canonicalContents);
  const afterStat = statSync(canonicalPath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.equal(afterStat.nlink, 1);
  assertOnlyStateFile(sessionId);
});

test('initialization leaves a same-inode reset quarantine entry inert', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'inert-reset-quarantine-pair';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const canonicalContents = readFileSync(canonicalPath);
  const digest = createHash('sha256').update(canonicalContents).digest('hex');
  const quarantinePath = join(
    sessionsDir,
    `.${basename(canonicalPath)}.q.reset-stage.${digest}.0123456789abcdef.${'56'.repeat(8)}`,
  );
  mkdirSync(quarantinePath, { mode: 0o700 });
  fs.chmodSync(quarantinePath, 0o700);
  const entryPath = join(quarantinePath, 'entry');
  fs.linkSync(canonicalPath, entryPath);
  const beforeStat = statSync(canonicalPath);
  assert.equal(beforeStat.nlink, 2);

  const outcome = store.initializeIfMissing(sessionId, 'wenyan-full');

  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readdirSync(quarantinePath), ['entry']);
  for (const candidate of [canonicalPath, entryPath]) {
    assert.deepEqual(readFileSync(candidate), canonicalContents);
    const stat = statSync(candidate);
    assert.equal(stat.dev, beforeStat.dev);
    assert.equal(stat.ino, beforeStat.ino);
    assert.equal(stat.nlink, 2);
  }
});

test('initialization rejects a publication pair replaced after its first barrier', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'publication-pair-replaced-after-first-barrier';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const canonicalContents = readFileSync(canonicalPath);
  const aliasPath = initializationAliasPath(canonicalPath, canonicalContents);
  fs.linkSync(canonicalPath, aliasPath);
  const originalStat = statSync(canonicalPath);
  const replacementPath = join(temporaryRoot, 'replacement-publication-pair.json');
  writeFileSync(replacementPath, canonicalContents, { mode: 0o600 });
  fs.chmodSync(replacementPath, 0o600);
  const replacementStat = statSync(replacementPath);
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const originalLink = fs.linkSync;
  const originalUnlink = fs.unlinkSync;
  let directoryOpens = 0;
  let barrierReopenFd;
  let replaced = false;

  fs.openSync = function captureFirstRecoveryBarrier(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (candidate === sessionsDir) {
      directoryOpens += 1;
      if (directoryOpens === 2) barrierReopenFd = fd;
    }
    return fd;
  };
  fs.closeSync = function replacePairAfterFirstBarrier(fd, ...args) {
    const result = originalClose(fd, ...args);
    if (fd === barrierReopenFd && !replaced) {
      replaced = true;
      originalUnlink(aliasPath);
      fs.renameSync(replacementPath, canonicalPath);
      originalLink(canonicalPath, aliasPath);
    }
    return result;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
  }

  assert.equal(replaced, true);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(canonicalPath), canonicalContents);
  assert.deepEqual(readFileSync(aliasPath), canonicalContents);
  for (const candidate of [canonicalPath, aliasPath]) {
    const stat = statSync(candidate);
    assert.equal(stat.dev, replacementStat.dev);
    assert.equal(stat.ino, replacementStat.ino);
    assert.notEqual(stat.ino, originalStat.ino);
    assert.equal(stat.nlink, 2);
  }
  assert.deepEqual(readdirSync(sessionsDir).sort(), [
    basename(canonicalPath),
    basename(aliasPath),
  ].sort());
});

test('initialization normalizes one same-inode alias beside an inert temporary', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'recover-alias-beside-inert-temporary';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const canonicalContents = readFileSync(canonicalPath);
  const aliasPath = initializationAliasPath(canonicalPath, canonicalContents);
  const orphanPath = initializationAliasPath(
    canonicalPath,
    canonicalContents,
    '4243',
    'fedcba9876543210',
  );
  fs.linkSync(canonicalPath, aliasPath);
  writeFileSync(orphanPath, canonicalContents, { mode: 0o600 });
  fs.chmodSync(orphanPath, 0o600);
  const canonicalStat = statSync(canonicalPath);
  const orphanStat = statSync(orphanPath);
  assert.equal(canonicalStat.nlink, 2);
  assert.notEqual(orphanStat.ino, canonicalStat.ino);

  const outcome = store.initializeIfMissing(sessionId, 'wenyan-full');

  assert.deepEqual(outcome, found('off'));
  assert.equal(existsSync(aliasPath), false);
  assert.deepEqual(readFileSync(canonicalPath), canonicalContents);
  assert.deepEqual(readFileSync(orphanPath), canonicalContents);
  const finalCanonicalStat = statSync(canonicalPath);
  const finalOrphanStat = statSync(orphanPath);
  assert.equal(finalCanonicalStat.dev, canonicalStat.dev);
  assert.equal(finalCanonicalStat.ino, canonicalStat.ino);
  assert.equal(finalCanonicalStat.nlink, 1);
  assert.equal(finalOrphanStat.dev, orphanStat.dev);
  assert.equal(finalOrphanStat.ino, orphanStat.ino);
  assert.deepEqual(readdirSync(sessionsDir).sort(), [
    basename(canonicalPath),
    basename(orphanPath),
  ].sort());
});

test('initialization preserves multiple same-inode publication aliases', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'multiple-publication-aliases';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const firstAlias = initializationAliasPath(canonicalPath);
  const secondAlias = initializationAliasPath(
    canonicalPath,
    readFileSync(canonicalPath),
    '4243',
    'fedcba9876543210',
  );
  fs.linkSync(canonicalPath, firstAlias);
  fs.linkSync(canonicalPath, secondAlias);
  const beforeContents = readFileSync(canonicalPath);
  const beforeStat = statSync(canonicalPath);
  assert.equal(beforeStat.nlink, 3);

  const outcome = store.initializeIfMissing(sessionId, 'wenyan-full');

  assert.deepEqual(outcome, unavailable());
  for (const candidate of [canonicalPath, firstAlias, secondAlias]) {
    assert.deepEqual(readFileSync(candidate), beforeContents);
    const stat = statSync(candidate);
    assert.equal(stat.dev, beforeStat.dev);
    assert.equal(stat.ino, beforeStat.ino);
    assert.equal(stat.nlink, 3);
  }
  assert.deepEqual(readdirSync(sessionsDir).sort(), [
    basename(canonicalPath),
    basename(firstAlias),
    basename(secondAlias),
  ].sort());
});

test('initialization rejects a malformed same-inode temporary without mutation', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'malformed-same-inode-temporary';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const aliasPath = join(
    sessionsDir,
    `.${basename(canonicalPath)}.init-v1.bad-pid.0123456789abcdef.${'0'.repeat(64)}.tmp`,
  );
  fs.linkSync(canonicalPath, aliasPath);
  const beforeContents = readFileSync(canonicalPath);
  const beforeStat = statSync(canonicalPath);
  assert.equal(beforeStat.nlink, 2);

  const outcome = store.initializeIfMissing(sessionId, 'wenyan-full');

  assert.deepEqual(outcome, unavailable());
  for (const candidate of [canonicalPath, aliasPath]) {
    assert.deepEqual(readFileSync(candidate), beforeContents);
    const stat = statSync(candidate);
    assert.equal(stat.dev, beforeStat.dev);
    assert.equal(stat.ino, beforeStat.ino);
    assert.equal(stat.nlink, 2);
  }
  assert.deepEqual(readdirSync(sessionsDir).sort(), [
    basename(canonicalPath),
    basename(aliasPath),
  ].sort());
});

test('initialization rejects a digestless same-inode temporary without mutation', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'digestless-same-inode-temporary';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const aliasPath = join(
    sessionsDir,
    `.${basename(canonicalPath)}.init-v1.4242.0123456789abcdef.tmp`,
  );
  fs.linkSync(canonicalPath, aliasPath);
  const beforeContents = readFileSync(canonicalPath);
  const beforeStat = statSync(canonicalPath);
  assert.equal(beforeStat.nlink, 2);

  const outcome = store.initializeIfMissing(sessionId, 'wenyan-full');

  assert.deepEqual(outcome, unavailable());
  for (const candidate of [canonicalPath, aliasPath]) {
    assert.deepEqual(readFileSync(candidate), beforeContents);
    const stat = statSync(candidate);
    assert.equal(stat.dev, beforeStat.dev);
    assert.equal(stat.ino, beforeStat.ino);
    assert.equal(stat.nlink, 2);
  }
  assert.deepEqual(readdirSync(sessionsDir).sort(), [
    basename(canonicalPath),
    basename(aliasPath),
  ].sort());
});

test('racing initialization normalizers revalidate an ENOENT loser', {
  skip: process.platform === 'win32',
}, () => {
  const firstStore = createStateStore(dataDir, { now: fixedNow });
  const secondStore = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'racing-normalizers';
  assert.equal(firstStore.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const aliasPath = initializationAliasPath(canonicalPath);
  fs.linkSync(canonicalPath, aliasPath);
  const beforeContents = readFileSync(canonicalPath);
  const beforeStat = statSync(canonicalPath);
  const originalRename = fs.renameSync;
  let interleaved = false;
  let secondOutcome;

  fs.renameSync = function normalizingBeforeQuarantine(source, ...args) {
    if (source === aliasPath && !interleaved) {
      interleaved = true;
      secondOutcome = secondStore.initializeIfMissing(
        sessionId,
        'wenyan-full',
      );
    }
    return originalRename(source, ...args);
  };
  let firstOutcome;
  try {
    firstOutcome = firstStore.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.renameSync = originalRename;
  }

  assert.equal(interleaved, true);
  assert.deepEqual(secondOutcome, found('off'));
  assert.deepEqual(firstOutcome, found('off'));
  assert.equal(existsSync(aliasPath), false);
  assert.deepEqual(readFileSync(canonicalPath), beforeContents);
  const afterStat = statSync(canonicalPath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.equal(afterStat.nlink, 1);
  assertOnlyStateFile(sessionId);
});

test('initialization revalidates a normalizer winner after initial close', {
  skip: process.platform === 'win32',
}, () => {
  const firstStore = createStateStore(dataDir, { now: fixedNow });
  const secondStore = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'initialize-normalizer-wins-after-initial-close';
  assert.equal(firstStore.write(sessionId, 'off'), true);
  const canonicalPath = canonicalStatePath(sessionId);
  const aliasPath = initializationAliasPath(canonicalPath);
  fs.linkSync(canonicalPath, aliasPath);
  const beforeContents = readFileSync(canonicalPath);
  const beforeStat = statSync(canonicalPath);
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let initialFd;
  let interleaved = false;
  let secondOutcome;

  fs.openSync = function captureInitialCanonical(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (candidate === canonicalPath && initialFd === undefined) initialFd = fd;
    return fd;
  };
  fs.closeSync = function normalizeAfterInitialClose(fd, ...args) {
    const result = originalClose(fd, ...args);
    if (fd === initialFd && !interleaved) {
      interleaved = true;
      secondOutcome = secondStore.initializeIfMissing(
        sessionId,
        'wenyan-full',
      );
    }
    return result;
  };
  let firstOutcome;
  try {
    firstOutcome = firstStore.initializeIfMissing(
      sessionId,
      'wenyan-full',
    );
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
  }

  assert.equal(interleaved, true);
  assert.deepEqual(secondOutcome, found('off'));
  assert.deepEqual(firstOutcome, found('off'));
  assert.equal(existsSync(aliasPath), false);
  assert.deepEqual(readFileSync(canonicalPath), beforeContents);
  const afterStat = statSync(canonicalPath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.equal(afterStat.nlink, 1);
  assertOnlyStateFile(sessionId);
});

test('initialization never recovers a two-link pair after initial close failure', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'initialize-pair-initial-close-failure';
  assert.equal(store.write(sessionId, 'off'), true);
  const canonicalPath = canonicalStatePath(sessionId);
  const aliasPath = initializationAliasPath(canonicalPath);
  fs.linkSync(canonicalPath, aliasPath);
  const beforeContents = readFileSync(canonicalPath);
  const beforeStat = statSync(canonicalPath);
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let initialFd;
  let failed = false;

  fs.openSync = function captureInitialCanonical(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (candidate === canonicalPath && initialFd === undefined) initialFd = fd;
    return fd;
  };
  fs.closeSync = function failInitialCanonicalClose(fd, ...args) {
    const result = originalClose(fd, ...args);
    if (fd === initialFd && !failed) {
      failed = true;
      throw simulatedIoError('simulated initial canonical close failure');
    }
    return result;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
  }

  assert.equal(failed, true);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(aliasPath), true);
  assert.deepEqual(readFileSync(canonicalPath), beforeContents);
  assert.deepEqual(readFileSync(aliasPath), beforeContents);
  const canonicalStat = statSync(canonicalPath);
  const aliasStat = statSync(aliasPath);
  assert.equal(canonicalStat.dev, beforeStat.dev);
  assert.equal(canonicalStat.ino, beforeStat.ino);
  assert.equal(aliasStat.dev, beforeStat.dev);
  assert.equal(aliasStat.ino, beforeStat.ino);
  assert.equal(canonicalStat.nlink, 2);
});

test('initialization never recovers a pair after alias observation failure', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'initialize-pair-alias-observation-failure';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const aliasPath = initializationAliasPath(canonicalPath);
  fs.linkSync(canonicalPath, aliasPath);
  const beforeContents = readFileSync(canonicalPath);
  const beforeStat = statSync(canonicalPath);
  const originalReaddir = fs.readdirSync;
  let failed = false;

  fs.readdirSync = function failInitialAliasObservation(candidate, ...args) {
    if (candidate === sessionsDir && !failed) {
      failed = true;
      throw simulatedIoError('simulated alias observation failure');
    }
    return originalReaddir(candidate, ...args);
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.readdirSync = originalReaddir;
  }

  assert.equal(failed, true);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(aliasPath), true);
  assert.deepEqual(readFileSync(canonicalPath), beforeContents);
  assert.deepEqual(readFileSync(aliasPath), beforeContents);
  const canonicalStat = statSync(canonicalPath);
  const aliasStat = statSync(aliasPath);
  assert.equal(canonicalStat.dev, beforeStat.dev);
  assert.equal(canonicalStat.ino, beforeStat.ino);
  assert.equal(aliasStat.dev, beforeStat.dev);
  assert.equal(aliasStat.ino, beforeStat.ino);
  assert.equal(canonicalStat.nlink, 2);
});

test('initialization never adopts an alias first published after initial close', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'initialize-alias-first-published-after-close';
  assert.equal(store.write(sessionId, 'off'), true);
  const canonicalPath = canonicalStatePath(sessionId);
  const foreignLinkPath = join(temporaryRoot, 'initialize-foreign-link');
  const aliasPath = initializationAliasPath(canonicalPath);
  fs.linkSync(canonicalPath, foreignLinkPath);
  const beforeContents = readFileSync(canonicalPath);
  const beforeStat = statSync(canonicalPath);
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let initialFd;
  let interleaved = false;

  fs.openSync = function captureInitialCanonical(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (candidate === canonicalPath && initialFd === undefined) initialFd = fd;
    return fd;
  };
  fs.closeSync = function publishAliasAfterInitialClose(fd, ...args) {
    const result = originalClose(fd, ...args);
    if (fd === initialFd && !interleaved) {
      interleaved = true;
      fs.unlinkSync(foreignLinkPath);
      fs.linkSync(canonicalPath, aliasPath);
    }
    return result;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
  }

  assert.equal(interleaved, true);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(aliasPath), true);
  assert.deepEqual(readFileSync(canonicalPath), beforeContents);
  assert.deepEqual(readFileSync(aliasPath), beforeContents);
  const canonicalStat = statSync(canonicalPath);
  const aliasStat = statSync(aliasPath);
  assert.equal(canonicalStat.dev, beforeStat.dev);
  assert.equal(canonicalStat.ino, beforeStat.ino);
  assert.equal(aliasStat.dev, beforeStat.dev);
  assert.equal(aliasStat.ino, beforeStat.ino);
  assert.equal(canonicalStat.nlink, 2);
});

test('racing initialization normalizers revalidate a pair-verification loser', {
  skip: process.platform === 'win32',
}, () => {
  const firstStore = createStateStore(dataDir, { now: fixedNow });
  const secondStore = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'racing-pair-normalizers';
  assert.equal(firstStore.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const aliasPath = initializationAliasPath(canonicalPath);
  fs.linkSync(canonicalPath, aliasPath);
  const beforeContents = readFileSync(canonicalPath);
  const beforeStat = statSync(canonicalPath);
  const originalLstat = fs.lstatSync;
  let aliasLstats = 0;
  let interleaved = false;
  let secondOutcome;

  fs.lstatSync = function normalizeBeforePairVerification(candidate, ...args) {
    const sampled = originalLstat(candidate, ...args);
    if (candidate === aliasPath) {
      aliasLstats += 1;
      if (aliasLstats === 3 && !interleaved) {
        interleaved = true;
        secondOutcome = secondStore.initializeIfMissing(
          sessionId,
          'wenyan-full',
        );
      }
    }
    return sampled;
  };
  let firstOutcome;
  try {
    firstOutcome = firstStore.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.lstatSync = originalLstat;
  }

  assert.equal(interleaved, true);
  assert.deepEqual(secondOutcome, found('off'));
  assert.deepEqual(firstOutcome, found('off'));
  assert.equal(existsSync(aliasPath), false);
  assert.deepEqual(readFileSync(canonicalPath), beforeContents);
  const afterStat = statSync(canonicalPath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.equal(afterStat.nlink, 1);
  assertOnlyStateFile(sessionId);
});

test('initialization revalidates an ENOENT alias-identity loser', {
  skip: process.platform === 'win32',
}, () => {
  const firstStore = createStateStore(dataDir, { now: fixedNow });
  const secondStore = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'alias-identity-enoent-loser';
  assert.equal(firstStore.write(sessionId, 'off'), true);
  const canonicalPath = canonicalStatePath(sessionId);
  const aliasPath = initializationAliasPath(canonicalPath);
  fs.linkSync(canonicalPath, aliasPath);
  const beforeContents = readFileSync(canonicalPath);
  const beforeStat = statSync(canonicalPath);
  const originalLstat = fs.lstatSync;
  let aliasLstats = 0;
  let interleaved = false;
  let secondOutcome;

  fs.lstatSync = function normalizeBeforeAliasIdentity(candidate, ...args) {
    if (candidate === aliasPath) {
      aliasLstats += 1;
      if (aliasLstats === 3 && !interleaved) {
        interleaved = true;
        secondOutcome = secondStore.initializeIfMissing(
          sessionId,
          'wenyan-full',
        );
      }
    }
    return originalLstat(candidate, ...args);
  };
  let firstOutcome;
  try {
    firstOutcome = firstStore.initializeIfMissing(
      sessionId,
      'wenyan-full',
    );
  } finally {
    fs.lstatSync = originalLstat;
  }

  assert.equal(interleaved, true);
  assert.deepEqual(secondOutcome, found('off'));
  assert.deepEqual(firstOutcome, found('off'));
  assert.equal(existsSync(aliasPath), false);
  assert.deepEqual(readFileSync(canonicalPath), beforeContents);
  const afterStat = statSync(canonicalPath);
  assert.equal(afterStat.dev, beforeStat.dev);
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.equal(afterStat.nlink, 1);
  assertOnlyStateFile(sessionId);
});

test('initialization never deletes a foreign inode swapped into an alias path', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'foreign-inode-swapped-into-alias';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const aliasPath = initializationAliasPath(canonicalPath);
  fs.linkSync(canonicalPath, aliasPath);
  const canonicalContents = readFileSync(canonicalPath);
  const canonicalStat = statSync(canonicalPath);
  const foreignContents = Buffer.from('foreign initialization evidence\n');
  const originalLstat = fs.lstatSync;
  const originalUnlink = fs.unlinkSync;
  let aliasLstats = 0;
  let swapped = false;
  let foreignStat;

  fs.lstatSync = function swapAliasAfterValidation(candidate, ...args) {
    const sampled = originalLstat(candidate, ...args);
    if (candidate === aliasPath) {
      aliasLstats += 1;
      if (aliasLstats === 6 && !swapped) {
        swapped = true;
        originalUnlink(aliasPath);
        writeFileSync(aliasPath, foreignContents, { mode: 0o600 });
        fs.chmodSync(aliasPath, 0o600);
        foreignStat = originalLstat(aliasPath);
      }
    }
    return sampled;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.lstatSync = originalLstat;
  }

  assert.equal(swapped, true);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(canonicalPath), canonicalContents);
  const finalCanonicalStat = statSync(canonicalPath);
  assert.equal(finalCanonicalStat.dev, canonicalStat.dev);
  assert.equal(finalCanonicalStat.ino, canonicalStat.ino);
  assert.equal(finalCanonicalStat.nlink, 1);
  const quarantineNames = readdirSync(sessionsDir)
    .filter((name) => name !== basename(canonicalPath));
  assert.equal(quarantineNames.length, 1);
  assert.ok(quarantineNames[0].startsWith(`.${basename(canonicalPath)}.q.`));
  const quarantinePath = join(sessionsDir, quarantineNames[0]);
  const quarantineStat = lstatSync(quarantinePath);
  assert.equal(quarantineStat.isDirectory(), true);
  assert.equal(quarantineStat.isSymbolicLink(), false);
  assert.equal(quarantineStat.mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(quarantinePath), ['entry']);
  const preservedPath = join(quarantinePath, 'entry');
  assert.deepEqual(readFileSync(preservedPath), foreignContents);
  const preservedStat = statSync(preservedPath);
  assert.equal(preservedStat.dev, foreignStat.dev);
  assert.equal(preservedStat.ino, foreignStat.ino);
});

test('initialization never adopts or clobbers a colliding quarantine directory', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'quarantine-directory-collision';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const canonicalContents = readFileSync(canonicalPath);
  const aliasNonce = '0123456789abcdef';
  const aliasPath = initializationAliasPath(
    canonicalPath,
    canonicalContents,
    '4242',
    aliasNonce,
  );
  fs.linkSync(canonicalPath, aliasPath);
  const canonicalStat = statSync(canonicalPath);
  const digest = createHash('sha256').update(canonicalContents).digest('hex');
  const collidingCleanupNonce = '11'.repeat(8);
  const collisionPath = join(
    sessionsDir,
    `.${basename(canonicalPath)}.q.publication-alias.${digest}.${aliasNonce}.${collidingCleanupNonce}`,
  );
  mkdirSync(collisionPath, { mode: 0o700 });
  fs.chmodSync(collisionPath, 0o700);
  const collisionEntry = join(collisionPath, 'entry');
  const collisionContents = Buffer.from('preexisting quarantine evidence\n');
  writeFileSync(collisionEntry, collisionContents, { mode: 0o600 });
  const collisionStat = statSync(collisionPath);
  const collisionEntryStat = statSync(collisionEntry);
  const cryptoModule = require('node:crypto');
  const originalRandomBytes = cryptoModule.randomBytes;
  let cleanupNonces = 0;

  cryptoModule.randomBytes = function collidingOnce(size, ...args) {
    if (size === 8 && args.length === 0) {
      cleanupNonces += 1;
      return Buffer.alloc(8, cleanupNonces === 1 ? 0x11 : 0x22);
    }
    return originalRandomBytes(size, ...args);
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    cryptoModule.randomBytes = originalRandomBytes;
  }

  assert.equal(cleanupNonces, 2);
  assert.deepEqual(outcome, found('off'));
  assert.equal(existsSync(aliasPath), false);
  assert.deepEqual(readFileSync(canonicalPath), canonicalContents);
  const finalCanonicalStat = statSync(canonicalPath);
  assert.equal(finalCanonicalStat.dev, canonicalStat.dev);
  assert.equal(finalCanonicalStat.ino, canonicalStat.ino);
  assert.equal(finalCanonicalStat.nlink, 1);
  assert.deepEqual(readFileSync(collisionEntry), collisionContents);
  const finalCollisionStat = statSync(collisionPath);
  const finalCollisionEntryStat = statSync(collisionEntry);
  assert.equal(finalCollisionStat.dev, collisionStat.dev);
  assert.equal(finalCollisionStat.ino, collisionStat.ino);
  assert.equal(finalCollisionEntryStat.dev, collisionEntryStat.dev);
  assert.equal(finalCollisionEntryStat.ino, collisionEntryStat.ino);
  assert.deepEqual(readdirSync(sessionsDir).sort(), [
    basename(canonicalPath),
    basename(collisionPath),
  ].sort());
});

test('initialization leaves malformed evidence recreated after recovery cleanup inert', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'recreated-malformed-publication-alias';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const aliasPath = initializationAliasPath(canonicalPath);
  fs.linkSync(canonicalPath, aliasPath);
  const canonicalContents = readFileSync(canonicalPath);
  const canonicalStat = statSync(canonicalPath);
  const originalUnlink = fs.unlinkSync;
  let recreated = false;

  fs.unlinkSync = function recreatingMalformedAlias(candidate, ...args) {
    const result = originalUnlink(candidate, ...args);
    if (basename(candidate) === 'entry' && !recreated) {
      recreated = true;
      writeFileSync(aliasPath, '{', { mode: 0o600 });
      fs.chmodSync(aliasPath, 0o600);
    }
    return result;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.unlinkSync = originalUnlink;
  }

  assert.equal(recreated, true);
  assert.deepEqual(outcome, found('off'));
  assert.deepEqual(store.read(sessionId), found('off'));
  assert.deepEqual(readFileSync(canonicalPath), canonicalContents);
  assert.equal(readFileSync(aliasPath, 'utf8'), '{');
  const finalCanonicalStat = statSync(canonicalPath);
  const finalAliasStat = statSync(aliasPath);
  assert.equal(finalCanonicalStat.dev, canonicalStat.dev);
  assert.equal(finalCanonicalStat.ino, canonicalStat.ino);
  assert.notEqual(finalAliasStat.ino, finalCanonicalStat.ino);
  assert.equal(finalCanonicalStat.nlink, 1);
  assert.deepEqual(readdirSync(sessionsDir).sort(), [
    basename(canonicalPath),
    basename(aliasPath),
  ].sort());
});

test('initialization leaves a different-inode strict temporary inert', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'different-publication-alias';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const aliasContents = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    mode: 'wenyan-full',
    updatedAt: fixedNow().toISOString(),
  })}\n`);
  const aliasPath = initializationAliasPath(canonicalPath, aliasContents);
  writeFileSync(aliasPath, aliasContents, { mode: 0o600 });
  const canonicalContents = readFileSync(canonicalPath);
  const canonicalStat = statSync(canonicalPath);
  const aliasStat = statSync(aliasPath);
  assert.notEqual(aliasStat.ino, canonicalStat.ino);

  const outcome = store.initializeIfMissing(sessionId, 'wenyan-full');

  assert.deepEqual(outcome, found('off'));
  assert.deepEqual(readFileSync(canonicalPath), canonicalContents);
  assert.deepEqual(readFileSync(aliasPath), aliasContents);
  const finalCanonicalStat = statSync(canonicalPath);
  const finalAliasStat = statSync(aliasPath);
  assert.equal(finalCanonicalStat.dev, canonicalStat.dev);
  assert.equal(finalCanonicalStat.ino, canonicalStat.ino);
  assert.equal(finalAliasStat.dev, aliasStat.dev);
  assert.equal(finalAliasStat.ino, aliasStat.ino);
  assert.deepEqual(readdirSync(sessionsDir).sort(), [
    basename(canonicalPath),
    basename(aliasPath),
  ].sort());
});

test('initialization rejects a foreign same-inode publication alias without mutation', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'foreign-publication-alias';
  const foreignSessionId = 'foreign-publication-owner';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const foreignAlias = initializationAliasPath(
    join(sessionsDir, `${stateKey(foreignSessionId)}.json`),
    readFileSync(canonicalPath),
  );
  fs.linkSync(canonicalPath, foreignAlias);
  const beforeContents = readFileSync(canonicalPath);
  const beforeStat = statSync(canonicalPath);
  assert.equal(beforeStat.nlink, 2);

  const outcome = store.initializeIfMissing(sessionId, 'wenyan-full');

  assert.deepEqual(outcome, unavailable());
  for (const candidate of [canonicalPath, foreignAlias]) {
    assert.deepEqual(readFileSync(candidate), beforeContents);
    const stat = statSync(candidate);
    assert.equal(stat.dev, beforeStat.dev);
    assert.equal(stat.ino, beforeStat.ino);
    assert.equal(stat.nlink, 2);
  }
  assert.deepEqual(readdirSync(sessionsDir).sort(), [
    basename(canonicalPath),
    basename(foreignAlias),
  ].sort());
});

test('initialization leaves a different-inode malformed temporary inert', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'malformed-publication-alias';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const aliasPath = join(
    sessionsDir,
    `.${basename(canonicalPath)}.init-v1.bad-pid.0123456789abcdef.${'0'.repeat(64)}.tmp`,
  );
  const aliasContents = Buffer.from('{');
  writeFileSync(aliasPath, aliasContents, { mode: 0o600 });
  const canonicalContents = readFileSync(canonicalPath);
  const canonicalStat = statSync(canonicalPath);
  const aliasStat = statSync(aliasPath);

  const outcome = store.initializeIfMissing(sessionId, 'wenyan-full');

  assert.deepEqual(outcome, found('off'));
  assert.deepEqual(readFileSync(canonicalPath), canonicalContents);
  assert.deepEqual(readFileSync(aliasPath), aliasContents);
  const finalCanonicalStat = statSync(canonicalPath);
  const finalAliasStat = statSync(aliasPath);
  assert.equal(finalCanonicalStat.dev, canonicalStat.dev);
  assert.equal(finalCanonicalStat.ino, canonicalStat.ino);
  assert.equal(finalAliasStat.dev, aliasStat.dev);
  assert.equal(finalAliasStat.ino, aliasStat.ino);
  assert.deepEqual(readdirSync(sessionsDir).sort(), [
    basename(canonicalPath),
    basename(aliasPath),
  ].sort());
});

test('existing state initialization does not require a working clock', () => {
  const writer = createStateStore(dataDir, { now: fixedNow });
  assert.equal(writer.write('existing-no-clock', 'ultra'), true);
  const store = createStateStore(dataDir, {
    now() {
      throw new Error('clock unavailable');
    },
  });

  assert.deepEqual(
    store.initializeIfMissing('existing-no-clock', 'wenyan-full'),
    found('ultra'),
  );
  assert.deepEqual(
    store.initializeIfMissing('existing-no-clock', 'not-a-mode'),
    found('ultra'),
  );
  assert.deepEqual(
    store.initializeIfMissing('existing-no-clock', 'wenyan-full', 'not-a-date'),
    found('ultra'),
  );
});

test('initializeIfMissing preserves a concurrent off winner', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'concurrent-off';
  const filePath = canonicalStatePath(sessionId);
  const originalLink = fs.linkSync;
  let interleaved = false;

  fs.linkSync = function interleavingLink(source, destination) {
    if (destination === filePath && !interleaved) {
      interleaved = true;
      assert.equal(store.write(sessionId, 'off'), true);
    }
    return originalLink(source, destination);
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.linkSync = originalLink;
  }

  assert.equal(interleaved, true);
  assert.deepEqual(outcome, found('off'));
  assert.deepEqual(store.read(sessionId), found('off'));
  assertOnlyStateFile(sessionId);
});

test('initialization returns an explicit replacement published during cleanup', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'replacement-after-link';
  const originalUnlink = fs.unlinkSync;
  let interleaved = false;

  fs.unlinkSync = function replacingDuringCleanup(candidate) {
    if (basename(candidate) === 'entry' && !interleaved) {
      interleaved = true;
      assert.equal(store.write(sessionId, 'off'), true);
    }
    return originalUnlink(candidate);
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.unlinkSync = originalUnlink;
  }

  assert.equal(interleaved, true);
  assert.deepEqual(outcome, found('off'));
  assert.deepEqual(store.read(sessionId), found('off'));
  assertOnlyStateFile(sessionId);
});

test('initialization is unavailable if the root changes after publication', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionsDir = join(dataDir, 'sessions');
  const originalLink = fs.linkSync;
  let interleaved = false;

  fs.linkSync = function replacingRootAfterLink(source, destination) {
    const result = originalLink(source, destination);
    if (!interleaved) {
      interleaved = true;
      rmSync(sessionsDir, { recursive: true });
      symlinkSync(externalDir, sessionsDir);
    }
    return result;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing('root-race', 'wenyan-full');
  } finally {
    fs.linkSync = originalLink;
  }

  assert.equal(interleaved, true);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(store.read('root-race'), unavailable());
  assert.deepEqual(readdirSync(externalDir), []);
});

test('EEXIST with a malformed concurrent winner is unavailable', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'malformed-winner';
  const filePath = canonicalStatePath(sessionId);
  const originalLink = fs.linkSync;

  fs.linkSync = function installMalformedWinner(source, destination) {
    if (destination === filePath) {
      writeFileSync(destination, '{');
      throw Object.assign(new Error('simulated concurrent winner'), {
        code: 'EEXIST',
      });
    }
    return originalLink(source, destination);
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.linkSync = originalLink;
  }

  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(store.read(sessionId), unavailable());
  assertOnlyStateFile(sessionId);
});

test('EEXIST with a disappeared concurrent winner is unavailable', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'disappeared-winner';
  const filePath = canonicalStatePath(sessionId);
  const originalLink = fs.linkSync;
  const originalUnlink = fs.unlinkSync;
  let temporaryPath;

  fs.linkSync = function installTransientWinner(source, destination) {
    if (destination === filePath) {
      temporaryPath = source;
      writeStateFile(sessionId, {
        schemaVersion: 1,
        mode: 'off',
        updatedAt: fixedNow().toISOString(),
      });
      throw Object.assign(new Error('simulated concurrent winner'), {
        code: 'EEXIST',
      });
    }
    return originalLink(source, destination);
  };
  fs.unlinkSync = function removeWinnerAfterTemp(candidate) {
    const result = originalUnlink(candidate);
    if (basename(candidate) === 'entry' && existsSync(filePath)) {
      originalUnlink(filePath);
    }
    return result;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.linkSync = originalLink;
    fs.unlinkSync = originalUnlink;
  }

  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(store.read(sessionId), missing());
  assert.deepEqual(readdirSync(join(dataDir, 'sessions')), []);
});

test('EEXIST never recovers a two-link winner after initial open failure', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'winner-pair-initial-open-failure';
  const canonicalPath = canonicalStatePath(sessionId);
  const originalLink = fs.linkSync;
  const originalOpen = fs.openSync;
  let aliasPath;
  let installed = false;
  let failed = false;
  let winnerContents;
  let winnerStat;

  fs.linkSync = function installTwoLinkWinner(source, destination, ...args) {
    if (destination === canonicalPath && !installed) {
      writeStateFile(sessionId, {
        schemaVersion: 1,
        mode: 'off',
        updatedAt: fixedNow().toISOString(),
      });
      fs.chmodSync(canonicalPath, 0o600);
      winnerContents = readFileSync(canonicalPath);
      aliasPath = initializationAliasPath(canonicalPath, winnerContents);
      originalLink(canonicalPath, aliasPath);
      winnerStat = statSync(canonicalPath);
      installed = true;
      throw Object.assign(new Error('simulated concurrent winner'), {
        code: 'EEXIST',
      });
    }
    return originalLink(source, destination, ...args);
  };
  fs.openSync = function failInitialWinnerOpen(candidate, ...args) {
    if (candidate === canonicalPath && installed && !failed) {
      failed = true;
      throw simulatedIoError('simulated initial winner open failure');
    }
    return originalOpen(candidate, ...args);
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.linkSync = originalLink;
    fs.openSync = originalOpen;
  }

  assert.equal(installed, true);
  assert.equal(failed, true);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(aliasPath), true);
  assert.deepEqual(readFileSync(canonicalPath), winnerContents);
  assert.deepEqual(readFileSync(aliasPath), winnerContents);
  const canonicalStat = statSync(canonicalPath);
  const aliasStat = statSync(aliasPath);
  assert.equal(canonicalStat.dev, winnerStat.dev);
  assert.equal(canonicalStat.ino, winnerStat.ino);
  assert.equal(aliasStat.dev, winnerStat.dev);
  assert.equal(aliasStat.ino, winnerStat.ino);
  assert.equal(canonicalStat.nlink, 2);
});

test('EEXIST never adopts a winner alias first published after close', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'winner-alias-first-published-after-close';
  const canonicalPath = canonicalStatePath(sessionId);
  const foreignLinkPath = join(temporaryRoot, 'winner-foreign-link');
  const originalLink = fs.linkSync;
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let aliasPath;
  let installed = false;
  let winnerFd;
  let interleaved = false;
  let winnerContents;
  let winnerStat;

  fs.linkSync = function installTwoLinkWinner(source, destination, ...args) {
    if (destination === canonicalPath && !installed) {
      writeStateFile(sessionId, {
        schemaVersion: 1,
        mode: 'off',
        updatedAt: fixedNow().toISOString(),
      });
      fs.chmodSync(canonicalPath, 0o600);
      winnerContents = readFileSync(canonicalPath);
      aliasPath = initializationAliasPath(canonicalPath, winnerContents);
      originalLink(canonicalPath, foreignLinkPath);
      winnerStat = statSync(canonicalPath);
      installed = true;
      throw Object.assign(new Error('simulated concurrent winner'), {
        code: 'EEXIST',
      });
    }
    return originalLink(source, destination, ...args);
  };
  fs.openSync = function captureInitialWinner(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (candidate === canonicalPath && installed && winnerFd === undefined) {
      winnerFd = fd;
    }
    return fd;
  };
  fs.closeSync = function publishAliasAfterWinnerClose(fd, ...args) {
    const result = originalClose(fd, ...args);
    if (fd === winnerFd && !interleaved) {
      interleaved = true;
      fs.unlinkSync(foreignLinkPath);
      originalLink(canonicalPath, aliasPath);
    }
    return result;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.linkSync = originalLink;
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
  }

  assert.equal(installed, true);
  assert.ok(winnerFd !== undefined);
  assert.equal(interleaved, true);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(aliasPath), true);
  assert.deepEqual(readFileSync(canonicalPath), winnerContents);
  assert.deepEqual(readFileSync(aliasPath), winnerContents);
  const canonicalStat = statSync(canonicalPath);
  const aliasStat = statSync(aliasPath);
  assert.equal(canonicalStat.dev, winnerStat.dev);
  assert.equal(canonicalStat.ino, winnerStat.ino);
  assert.equal(aliasStat.dev, winnerStat.dev);
  assert.equal(aliasStat.ino, winnerStat.ino);
  assert.equal(canonicalStat.nlink, 2);
});

test('EEXIST winner requires a strict final-only parent barrier', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'winner-barrier';
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const originalLink = fs.linkSync;
  const originalOpen = fs.openSync;
  let stagePath;
  let installed = false;
  let winnerReady = false;
  let canonicalReads = 0;
  let failed = false;
  let winnerContents;
  let winnerStat;

  fs.linkSync = function installingWinner(source, destination) {
    if (destination === canonicalPath && !installed) {
      installed = true;
      writeStateFile(sessionId, {
        schemaVersion: 1,
        mode: 'off',
        updatedAt: fixedNow().toISOString(),
      });
      fs.chmodSync(canonicalPath, 0o600);
      winnerContents = readFileSync(canonicalPath);
      winnerStat = statSync(canonicalPath);
      winnerReady = true;
      throw Object.assign(new Error('simulated concurrent winner'), {
        code: 'EEXIST',
      });
    }
    return originalLink(source, destination);
  };
  fs.openSync = function failingWinnerBarrier(candidate, ...args) {
    if (candidate === sessionsDir && canonicalReads === 2 && !failed) {
      failed = true;
      throw simulatedIoError('simulated winner parent barrier failure');
    }
    const fd = originalOpen(candidate, ...args);
    if (candidate === canonicalPath && winnerReady) canonicalReads += 1;
    if (!stagePath && candidate.endsWith('.tmp')) stagePath = candidate;
    return fd;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.linkSync = originalLink;
    fs.openSync = originalOpen;
  }

  assert.equal(installed, true);
  assert.equal(failed, true);
  assert.ok(stagePath);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(stagePath), false);
  assert.deepEqual(readFileSync(canonicalPath), winnerContents);
  const afterStat = statSync(canonicalPath);
  assert.equal(afterStat.dev, winnerStat.dev);
  assert.equal(afterStat.ino, winnerStat.ino);
  assertOnlyStateFile(sessionId);
});

test('EEXIST rejects a valid winner replaced after its final-only barrier', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'winner-replaced-after-final-only-barrier';
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const replacementPath = join(temporaryRoot, 'replacement-after-winner-barrier.json');
  const replacementContents = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    mode: 'ultra',
    updatedAt: fixedNow().toISOString(),
  })}\n`);
  writeFileSync(replacementPath, replacementContents, { mode: 0o600 });
  fs.chmodSync(replacementPath, 0o600);
  const replacementStat = statSync(replacementPath);
  const originalLink = fs.linkSync;
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let installed = false;
  let canonicalReads = 0;
  let finalBarrierDirectoryOpens = 0;
  let finalBarrierReopenFd;
  let replaced = false;

  fs.linkSync = function installingWinner(source, destination, ...args) {
    if (destination === canonicalPath && !installed) {
      installed = true;
      writeStateFile(sessionId, {
        schemaVersion: 1,
        mode: 'off',
        updatedAt: fixedNow().toISOString(),
      });
      fs.chmodSync(canonicalPath, 0o600);
      throw Object.assign(new Error('simulated concurrent winner'), {
        code: 'EEXIST',
      });
    }
    return originalLink(source, destination, ...args);
  };
  fs.openSync = function captureWinnerBarrierReopen(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (candidate === canonicalPath && installed) canonicalReads += 1;
    if (candidate === sessionsDir && canonicalReads === 2) {
      finalBarrierDirectoryOpens += 1;
      if (finalBarrierDirectoryOpens === 2) finalBarrierReopenFd = fd;
    }
    return fd;
  };
  fs.closeSync = function replaceWinnerAfterBarrier(fd, ...args) {
    const result = originalClose(fd, ...args);
    if (fd === finalBarrierReopenFd && !replaced) {
      replaced = true;
      fs.renameSync(replacementPath, canonicalPath);
    }
    return result;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.linkSync = originalLink;
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
  }

  assert.equal(installed, true);
  assert.equal(replaced, true);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(store.read(sessionId), found('ultra'));
  assert.deepEqual(readFileSync(canonicalPath), replacementContents);
  const finalStat = statSync(canonicalPath);
  assert.equal(finalStat.dev, replacementStat.dev);
  assert.equal(finalStat.ino, replacementStat.ino);
  assertOnlyStateFile(sessionId);
});

test('EEXIST leaves a different-inode strict temporary inert beside its winner', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'winner-with-different-inode-temporary';
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const orphanContents = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    mode: 'ultra',
    updatedAt: fixedNow().toISOString(),
  })}\n`);
  const orphanPath = initializationAliasPath(canonicalPath, orphanContents);
  const originalLink = fs.linkSync;
  let installed = false;
  let winnerContents;
  let winnerStat;
  let orphanStat;

  fs.linkSync = function installingWinnerAndOrphan(source, destination, ...args) {
    if (destination === canonicalPath && !installed) {
      installed = true;
      writeStateFile(sessionId, {
        schemaVersion: 1,
        mode: 'off',
        updatedAt: fixedNow().toISOString(),
      });
      fs.chmodSync(canonicalPath, 0o600);
      writeFileSync(orphanPath, orphanContents, { mode: 0o600 });
      fs.chmodSync(orphanPath, 0o600);
      winnerContents = readFileSync(canonicalPath);
      winnerStat = statSync(canonicalPath);
      orphanStat = statSync(orphanPath);
      assert.notEqual(orphanStat.ino, winnerStat.ino);
      throw Object.assign(new Error('simulated concurrent winner'), {
        code: 'EEXIST',
      });
    }
    return originalLink(source, destination, ...args);
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.linkSync = originalLink;
  }

  assert.equal(installed, true);
  assert.deepEqual(outcome, found('off'));
  assert.deepEqual(readFileSync(canonicalPath), winnerContents);
  assert.deepEqual(readFileSync(orphanPath), orphanContents);
  const finalWinnerStat = statSync(canonicalPath);
  const finalOrphanStat = statSync(orphanPath);
  assert.equal(finalWinnerStat.dev, winnerStat.dev);
  assert.equal(finalWinnerStat.ino, winnerStat.ino);
  assert.equal(finalOrphanStat.dev, orphanStat.dev);
  assert.equal(finalOrphanStat.ino, orphanStat.ino);
  assert.deepEqual(readdirSync(sessionsDir).sort(), [
    basename(canonicalPath),
    basename(orphanPath),
  ].sort());
});

test('EEXIST winner rejects sessions-root replacement during alias scan', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'winner-alias-scan-root-race';
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const displacedDir = join(temporaryRoot, 'displaced-winner-alias-scan');
  const canonicalPath = canonicalStatePath(sessionId);
  const originalRoot = lstatSync(sessionsDir);
  const originalLink = fs.linkSync;
  const originalReaddir = fs.readdirSync;
  let stagePath;
  let winnerContents;
  let winnerStat;
  let installed = false;
  let replaced = false;

  fs.linkSync = function installingWinner(source, destination, ...args) {
    if (destination === canonicalPath && !installed) {
      stagePath = source;
      installed = true;
      writeStateFile(sessionId, {
        schemaVersion: 1,
        mode: 'off',
        updatedAt: fixedNow().toISOString(),
      });
      fs.chmodSync(canonicalPath, 0o600);
      winnerContents = readFileSync(canonicalPath);
      winnerStat = statSync(canonicalPath);
      throw Object.assign(new Error('simulated concurrent winner'), {
        code: 'EEXIST',
      });
    }
    return originalLink(source, destination, ...args);
  };
  fs.readdirSync = function replacingRootDuringAliasScan(candidate, ...args) {
    const entries = originalReaddir(candidate, ...args);
    if (candidate === sessionsDir && installed && !replaced) {
      replaced = true;
      fs.renameSync(sessionsDir, displacedDir);
      mkdirSync(sessionsDir, { mode: 0o700 });
      fs.renameSync(
        join(displacedDir, basename(canonicalPath)),
        canonicalPath,
      );
    }
    return entries;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.linkSync = originalLink;
    fs.readdirSync = originalReaddir;
  }

  assert.equal(installed, true);
  assert.equal(replaced, true);
  assert.ok(stagePath);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(store.read(sessionId), unavailable());
  assert.equal(existsSync(stagePath), false);
  const replacementRoot = lstatSync(sessionsDir);
  const finalWinner = statSync(canonicalPath);
  assert.notEqual(replacementRoot.ino, originalRoot.ino);
  assert.equal(finalWinner.dev, winnerStat.dev);
  assert.equal(finalWinner.ino, winnerStat.ino);
  assert.deepEqual(readFileSync(canonicalPath), winnerContents);
  assert.deepEqual(readdirSync(displacedDir), []);
  assertOnlyStateFile(sessionId);
});

test('EEXIST final-only winner requires a barrier after alias cleanup', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'winner-alias-cleanup-barrier';
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  let aliasPath;
  const originalLink = fs.linkSync;
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const originalUnlink = fs.unlinkSync;
  const originalRmdir = fs.rmdirSync;
  let installed = false;
  let ownedStageRemoved = false;
  let directoryOpens = 0;
  let barrierReopenFd;
  let aliasRemoved = false;
  let failed = false;
  let winnerContents;
  let winnerStat;

  fs.linkSync = function installLinkedWinner(source, destination, ...args) {
    if (destination === canonicalPath && !installed) {
      installed = true;
      writeStateFile(sessionId, {
        schemaVersion: 1,
        mode: 'off',
        updatedAt: fixedNow().toISOString(),
      });
      fs.chmodSync(canonicalPath, 0o600);
      aliasPath = initializationAliasPath(canonicalPath);
      originalLink(canonicalPath, aliasPath);
      winnerContents = readFileSync(canonicalPath);
      winnerStat = statSync(canonicalPath);
      throw Object.assign(new Error('simulated concurrent winner'), {
        code: 'EEXIST',
      });
    }
    return originalLink(source, destination, ...args);
  };
  fs.openSync = function failPostCleanupBarrier(candidate, ...args) {
    if (candidate === sessionsDir && ownedStageRemoved) {
      directoryOpens += 1;
      if (directoryOpens === 3) {
        failed = true;
        throw simulatedIoError('simulated post-cleanup barrier failure');
      }
    }
    const fd = originalOpen(candidate, ...args);
    if (candidate === sessionsDir && directoryOpens === 2) {
      barrierReopenFd = fd;
    }
    return fd;
  };
  fs.rmdirSync = function captureOwnedStageRemoval(candidate, ...args) {
    const result = originalRmdir(candidate, ...args);
    if (
      dirname(candidate) === sessionsDir &&
      basename(candidate).includes('.q.owned-stage.')
    ) ownedStageRemoved = true;
    return result;
  };
  fs.closeSync = function removeAliasAfterBarrier(fd, ...args) {
    const result = originalClose(fd, ...args);
    if (fd === barrierReopenFd && !aliasRemoved) {
      aliasRemoved = true;
      originalUnlink(aliasPath);
    }
    return result;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.linkSync = originalLink;
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
    fs.rmdirSync = originalRmdir;
  }

  assert.equal(installed, true);
  assert.equal(aliasRemoved, true);
  assert.deepEqual(outcome, unavailable());
  assert.equal(failed, true);
  assert.equal(existsSync(aliasPath), false);
  assert.deepEqual(readFileSync(canonicalPath), winnerContents);
  const finalWinner = statSync(canonicalPath);
  assert.equal(finalWinner.dev, winnerStat.dev);
  assert.equal(finalWinner.ino, winnerStat.ino);
  assert.equal(finalWinner.nlink, 1);
  assertOnlyStateFile(sessionId);
});

test('EEXIST revalidates a two-link winner normalized before recovery scan', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'winner-normalized-before-recovery-scan';
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  let aliasPath;
  const originalLink = fs.linkSync;
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const originalUnlink = fs.unlinkSync;
  let installed = false;
  let winnerFd;
  let aliasRemoved = false;
  const winnerContents = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    mode: 'off',
    updatedAt: fixedNow().toISOString(),
  })}\n`);
  let winnerStat;

  fs.linkSync = function installTwoLinkWinner(source, destination, ...args) {
    if (destination === canonicalPath && !installed) {
      installed = true;
      writeStateFile(sessionId, {
        schemaVersion: 1,
        mode: 'off',
        updatedAt: fixedNow().toISOString(),
      });
      fs.chmodSync(canonicalPath, 0o600);
      aliasPath = initializationAliasPath(canonicalPath, winnerContents);
      originalLink(canonicalPath, aliasPath);
      winnerStat = statSync(canonicalPath);
      throw Object.assign(new Error('simulated concurrent winner'), {
        code: 'EEXIST',
      });
    }
    return originalLink(source, destination, ...args);
  };
  fs.openSync = function captureWinnerRead(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (candidate === canonicalPath && installed && winnerFd === undefined) {
      winnerFd = fd;
    }
    return fd;
  };
  fs.closeSync = function normalizeWinnerAfterRead(fd, ...args) {
    const result = originalClose(fd, ...args);
    if (fd === winnerFd && !aliasRemoved) {
      aliasRemoved = true;
      originalUnlink(aliasPath);
    }
    return result;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.linkSync = originalLink;
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
  }

  assert.equal(installed, true);
  assert.ok(winnerFd !== undefined);
  assert.equal(aliasRemoved, true);
  assert.deepEqual(outcome, found('off'));
  assert.equal(existsSync(aliasPath), false);
  assert.deepEqual(readFileSync(canonicalPath), winnerContents);
  const finalWinner = statSync(canonicalPath);
  assert.equal(finalWinner.dev, winnerStat.dev);
  assert.equal(finalWinner.ino, winnerStat.ino);
  assert.equal(finalWinner.nlink, 1);
  assertOnlyStateFile(sessionId);
});

test('EEXIST cleanup failure cannot report successful initialization', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'winner-cleanup-failure';
  const canonicalPath = canonicalStatePath(sessionId);
  const originalOpen = fs.openSync;
  const originalLink = fs.linkSync;
  const originalUnlink = fs.unlinkSync;
  let stagePath;
  let cleanupFailed = false;

  fs.openSync = function captureOwnedStage(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (!stagePath && candidate.endsWith('.tmp')) stagePath = candidate;
    return fd;
  };
  fs.linkSync = function installConcurrentWinner(source, destination) {
    if (destination === canonicalPath) {
      writeStateFile(sessionId, {
        schemaVersion: 1,
        mode: 'off',
        updatedAt: fixedNow().toISOString(),
      });
      fs.chmodSync(canonicalPath, 0o600);
      throw Object.assign(new Error('simulated concurrent winner'), {
        code: 'EEXIST',
      });
    }
    return originalLink(source, destination);
  };
  fs.unlinkSync = function failOwnedStageCleanup(candidate, ...args) {
    if (basename(candidate) === 'entry' && !cleanupFailed) {
      cleanupFailed = true;
      throw simulatedIoError('simulated EEXIST cleanup failure');
    }
    return originalUnlink(candidate, ...args);
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.openSync = originalOpen;
    fs.linkSync = originalLink;
    fs.unlinkSync = originalUnlink;
  }

  assert.equal(cleanupFailed, true);
  assert.ok(stagePath);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(stagePath), false);
  assert.equal(existsSync(canonicalPath), true);
  const winnerStat = statSync(canonicalPath);
  assert.equal(winnerStat.nlink, 1);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const quarantineNames = readdirSync(sessionsDir)
    .filter((name) => name !== basename(canonicalPath));
  assert.equal(quarantineNames.length, 1);
  const quarantinedPath = join(sessionsDir, quarantineNames[0], 'entry');
  const stageStat = statSync(quarantinedPath);
  assert.notEqual(stageStat.ino, winnerStat.ino);
  assert.equal(stageStat.nlink, 1);
});

test('EEXIST cleanup never deletes a foreign inode swapped into its stage', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'winner-cleanup-foreign-stage';
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const winnerContents = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    mode: 'off',
    updatedAt: fixedNow().toISOString(),
  })}\n`);
  const foreignContents = Buffer.from('foreign EEXIST stage evidence\n');
  const originalOpen = fs.openSync;
  const originalLstat = fs.lstatSync;
  const originalLink = fs.linkSync;
  const originalUnlink = fs.unlinkSync;
  let stagePath;
  let stageLstats = 0;
  let swapped = false;
  let foreignStat;

  fs.openSync = function captureOwnedStage(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (!stagePath && candidate.endsWith('.tmp')) stagePath = candidate;
    return fd;
  };
  fs.linkSync = function installConcurrentWinner(source, destination, ...args) {
    if (destination === canonicalPath) {
      writeFileSync(canonicalPath, winnerContents, { mode: 0o600 });
      fs.chmodSync(canonicalPath, 0o600);
      throw Object.assign(new Error('simulated concurrent winner'), {
        code: 'EEXIST',
      });
    }
    return originalLink(source, destination, ...args);
  };
  fs.lstatSync = function swapStageAfterCleanupCheck(candidate, ...args) {
    const sampled = originalLstat(candidate, ...args);
    if (candidate === stagePath) {
      stageLstats += 1;
      if (stageLstats === 4 && !swapped) {
        swapped = true;
        originalUnlink(stagePath);
        writeFileSync(stagePath, foreignContents, { mode: 0o600 });
        fs.chmodSync(stagePath, 0o600);
        foreignStat = originalLstat(stagePath);
      }
    }
    return sampled;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.openSync = originalOpen;
    fs.lstatSync = originalLstat;
    fs.linkSync = originalLink;
  }

  assert.ok(stagePath);
  assert.equal(swapped, true);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(canonicalPath), winnerContents);
  assert.equal(statSync(canonicalPath).nlink, 1);
  const quarantineNames = readdirSync(sessionsDir)
    .filter((name) => name !== basename(canonicalPath));
  assert.equal(quarantineNames.length, 1);
  assert.ok(quarantineNames[0].startsWith(`.${basename(canonicalPath)}.q.owned-stage.`));
  const preservedPath = join(sessionsDir, quarantineNames[0], 'entry');
  assert.deepEqual(readFileSync(preservedPath), foreignContents);
  const preservedStat = statSync(preservedPath);
  assert.equal(preservedStat.dev, foreignStat.dev);
  assert.equal(preservedStat.ino, foreignStat.ino);
});

test('non-EEXIST publication failure cleans its verified temporary file', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'failed-publication';
  const filePath = canonicalStatePath(sessionId);
  const originalLink = fs.linkSync;
  let injected = false;

  fs.linkSync = function failingLink(source, destination) {
    if (destination === filePath) {
      injected = true;
      throw simulatedIoError('simulated link failure');
    }
    return originalLink(source, destination);
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.linkSync = originalLink;
  }

  assert.equal(injected, true);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(store.read(sessionId), missing());
  assert.deepEqual(readdirSync(join(dataDir, 'sessions')), []);
});

test('non-EEXIST cleanup never deletes a foreign inode swapped into its stage', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'failed-publication-foreign-stage';
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const foreignContents = Buffer.from('foreign non-EEXIST stage evidence\n');
  const originalOpen = fs.openSync;
  const originalLstat = fs.lstatSync;
  const originalLink = fs.linkSync;
  const originalUnlink = fs.unlinkSync;
  let stagePath;
  let stageLstats = 0;
  let swapped = false;
  let foreignStat;

  fs.openSync = function captureOwnedStage(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (!stagePath && candidate.endsWith('.tmp')) stagePath = candidate;
    return fd;
  };
  fs.linkSync = function failPublication(source, destination, ...args) {
    if (destination === canonicalPath) {
      throw simulatedIoError('simulated non-EEXIST publication failure');
    }
    return originalLink(source, destination, ...args);
  };
  fs.lstatSync = function swapStageAfterCleanupCheck(candidate, ...args) {
    const sampled = originalLstat(candidate, ...args);
    if (candidate === stagePath) {
      stageLstats += 1;
      if (stageLstats === 4 && !swapped) {
        swapped = true;
        originalUnlink(stagePath);
        writeFileSync(stagePath, foreignContents, { mode: 0o600 });
        fs.chmodSync(stagePath, 0o600);
        foreignStat = originalLstat(stagePath);
      }
    }
    return sampled;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.openSync = originalOpen;
    fs.lstatSync = originalLstat;
    fs.linkSync = originalLink;
  }

  assert.ok(stagePath);
  assert.equal(swapped, true);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(canonicalPath), false);
  const quarantineNames = readdirSync(sessionsDir);
  assert.equal(quarantineNames.length, 1);
  const preservedPath = join(sessionsDir, quarantineNames[0], 'entry');
  assert.deepEqual(readFileSync(preservedPath), foreignContents);
  const preservedStat = statSync(preservedPath);
  assert.equal(preservedStat.dev, foreignStat.dev);
  assert.equal(preservedStat.ino, foreignStat.ino);
});

test('pre-link cleanup never deletes a foreign inode swapped into its stage', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'pre-link-cleanup-foreign-stage';
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const foreignContents = Buffer.from('foreign pre-link stage evidence\n');
  const originalOpen = fs.openSync;
  const originalLstat = fs.lstatSync;
  const originalUnlink = fs.unlinkSync;
  let stagePath;
  let stageLstats = 0;
  let swapped = false;
  let foreignStat;

  fs.openSync = function captureOwnedStage(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (!stagePath && candidate.endsWith('.tmp')) stagePath = candidate;
    return fd;
  };
  fs.lstatSync = function failValidationThenSwapCleanup(candidate, ...args) {
    if (candidate === stagePath) {
      stageLstats += 1;
      if (stageLstats === 3) {
        throw simulatedIoError('simulated pre-link stage validation failure');
      }
      const sampled = originalLstat(candidate, ...args);
      if (stageLstats === 4 && !swapped) {
        swapped = true;
        originalUnlink(stagePath);
        writeFileSync(stagePath, foreignContents, { mode: 0o600 });
        fs.chmodSync(stagePath, 0o600);
        foreignStat = originalLstat(stagePath);
      }
      return sampled;
    }
    return originalLstat(candidate, ...args);
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.openSync = originalOpen;
    fs.lstatSync = originalLstat;
  }

  assert.ok(stagePath);
  assert.equal(swapped, true);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(canonicalPath), false);
  const quarantineNames = readdirSync(sessionsDir);
  assert.equal(quarantineNames.length, 1);
  const preservedPath = join(sessionsDir, quarantineNames[0], 'entry');
  assert.deepEqual(readFileSync(preservedPath), foreignContents);
  const preservedStat = statSync(preservedPath);
  assert.equal(preservedStat.dev, foreignStat.dev);
  assert.equal(preservedStat.ino, foreignStat.ino);
});

test('initialization rejects a hard-linked stage before fsync without publishing', {
  skip: process.platform === 'win32' || typeof process.getuid !== 'function',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'hard-linked-stage';
  const canonicalPath = canonicalStatePath(sessionId);
  const aliasPath = join(temporaryRoot, 'external-stage-link.json');
  const originalOpen = fs.openSync;
  let stagePath;
  let stageIdentity;

  fs.openSync = function linkingNewStage(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (!stagePath && candidate.endsWith('.tmp')) {
      stagePath = candidate;
      fs.linkSync(candidate, aliasPath);
      stageIdentity = statSync(aliasPath);
      assert.equal(stageIdentity.nlink, 2);
      assert.equal(stageIdentity.size, 0);
    }
    return fd;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.openSync = originalOpen;
  }

  assert.ok(stagePath);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(canonicalPath), false);
  assert.equal(existsSync(stagePath), true);
  assert.deepEqual(readdirSync(join(dataDir, 'sessions')), [basename(stagePath)]);
  assert.deepEqual(readFileSync(stagePath), Buffer.alloc(0));
  assert.deepEqual(readFileSync(aliasPath), Buffer.alloc(0));
  const stageStat = statSync(stagePath);
  const aliasStat = statSync(aliasPath);
  assert.equal(stageStat.dev, stageIdentity.dev);
  assert.equal(stageStat.ino, stageIdentity.ino);
  assert.equal(stageStat.nlink, 2);
  assert.equal(aliasStat.dev, stageIdentity.dev);
  assert.equal(aliasStat.ino, stageIdentity.ino);
  assert.equal(aliasStat.nlink, 2);
});

test('initialization rejects an initially nonprivate stage without publishing', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'nonprivate-stage';
  const canonicalPath = canonicalStatePath(sessionId);
  const originalOpen = fs.openSync;
  let stagePath;

  fs.openSync = function wideningNewStage(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (!stagePath && candidate.endsWith('.tmp')) {
      stagePath = candidate;
      fs.chmodSync(candidate, 0o644);
    }
    return fd;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.openSync = originalOpen;
  }

  assert.ok(stagePath);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(canonicalPath), false);
  assert.equal(existsSync(stagePath), true);
  assert.equal(statSync(stagePath).mode & 0o777, 0o644);
  assert.deepEqual(readdirSync(join(dataDir, 'sessions')), [basename(stagePath)]);
});

test('initialization rejects a stage reported under another owner', {
  skip: typeof process.getuid !== 'function',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'foreign-stage-owner';
  const canonicalPath = canonicalStatePath(sessionId);
  const originalFstat = fs.fstatSync;
  let injected = false;

  fs.fstatSync = function foreignStageOwner(...args) {
    const stat = originalFstat(...args);
    if (injected) return stat;
    injected = true;
    return new Proxy(stat, {
      get(target, property) {
        if (property === 'uid') return process.getuid() + 1;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.fstatSync = originalFstat;
  }

  assert.equal(injected, true);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(canonicalPath), false);
  const evidenceNames = readdirSync(join(dataDir, 'sessions'));
  assert.equal(evidenceNames.length, 1);
  const evidencePath = join(dataDir, 'sessions', evidenceNames[0]);
  const evidenceStat = statSync(evidencePath);
  assert.equal(evidenceStat.size, 0);
  assert.equal(evidenceStat.nlink, 1);
});

test('initialization fsync failure leaves the session missing', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const originalFsync = fs.fsyncSync;
  let injected = false;

  fs.fsyncSync = function failingInitializationFsync(...args) {
    if (!injected) {
      injected = true;
      throw simulatedIoError('simulated initialization fsync failure');
    }
    return originalFsync(...args);
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing('fsync-failure', 'wenyan-full');
  } finally {
    fs.fsyncSync = originalFsync;
  }

  assert.equal(injected, true);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(store.read('fsync-failure'), missing());
  assert.deepEqual(readdirSync(join(dataDir, 'sessions')), []);
});

test('failed initialization never deletes a foreign inode swapped into its stage', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'failed-initialization-foreign-stage';
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const foreignContents = Buffer.from('foreign failed-initialization evidence\n');
  const originalOpen = fs.openSync;
  const originalFsync = fs.fsyncSync;
  const originalLstat = fs.lstatSync;
  const originalUnlink = fs.unlinkSync;
  let stagePath;
  let stageFd;
  let stageLstats = 0;
  let fsyncFailed = false;
  let swapped = false;
  let foreignStat;

  fs.openSync = function captureOwnedStage(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (!stagePath && candidate.endsWith('.tmp')) {
      stagePath = candidate;
      stageFd = fd;
    }
    return fd;
  };
  fs.fsyncSync = function failStageFsync(fd, ...args) {
    if (fd === stageFd && !fsyncFailed) {
      fsyncFailed = true;
      throw simulatedIoError('simulated stage fsync failure');
    }
    return originalFsync(fd, ...args);
  };
  fs.lstatSync = function swapStageAfterFailureCleanupCheck(candidate, ...args) {
    const sampled = originalLstat(candidate, ...args);
    if (candidate === stagePath) {
      stageLstats += 1;
      if (stageLstats === 1 && !swapped) {
        swapped = true;
        originalUnlink(stagePath);
        writeFileSync(stagePath, foreignContents, { mode: 0o600 });
        fs.chmodSync(stagePath, 0o600);
        foreignStat = originalLstat(stagePath);
      }
    }
    return sampled;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.openSync = originalOpen;
    fs.fsyncSync = originalFsync;
    fs.lstatSync = originalLstat;
  }

  assert.ok(stagePath);
  assert.equal(fsyncFailed, true);
  assert.equal(swapped, true);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(canonicalPath), false);
  const quarantineNames = readdirSync(sessionsDir);
  assert.equal(quarantineNames.length, 1);
  const preservedPath = join(sessionsDir, quarantineNames[0], 'entry');
  assert.deepEqual(readFileSync(preservedPath), foreignContents);
  const preservedStat = statSync(preservedPath);
  assert.equal(preservedStat.dev, foreignStat.dev);
  assert.equal(preservedStat.ino, foreignStat.ino);
});

test('initializeIfMissing rejects identical bytes rewritten after file fsync', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'identical-rewrite-after-fsync';
  const canonicalPath = canonicalStatePath(sessionId);
  const originalOpen = fs.openSync;
  const originalFsync = fs.fsyncSync;
  let stagePath;
  let changed = false;

  fs.openSync = function captureStagePath(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (!stagePath && candidate.endsWith('.tmp')) stagePath = candidate;
    return fd;
  };
  fs.fsyncSync = function rewriteStageAfterFsync(fd, ...args) {
    const result = originalFsync(fd, ...args);
    if (stagePath && !changed) {
      changed = true;
      const contents = readFileSync(stagePath);
      writeFileSync(stagePath, contents);
      fs.chmodSync(stagePath, 0o600);
    }
    return result;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.openSync = originalOpen;
    fs.fsyncSync = originalFsync;
  }

  assert.ok(stagePath);
  assert.equal(changed, true);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(canonicalPath), false);
  assert.equal(existsSync(stagePath), false);
  assert.deepEqual(readdirSync(join(dataDir, 'sessions')), []);
});

test('initializeIfMissing rejects group drift after stage fsync', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'stage-group-drift-after-fsync';
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const originalFstat = fs.fstatSync;
  const originalLstat = fs.lstatSync;
  let stagePath;
  let stageFd;
  let stageClosed = false;

  function withDriftedGroup(stat) {
    return new Proxy(stat, {
      get(target, property) {
        if (property === 'gid') return target.gid + 1;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  fs.openSync = function captureInitializationStage(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (!stagePath && candidate.endsWith('.tmp')) {
      stagePath = candidate;
      stageFd = fd;
    }
    return fd;
  };
  fs.closeSync = function beginGroupDriftAfterStageClose(fd, ...args) {
    const result = originalClose(fd, ...args);
    if (fd === stageFd) stageClosed = true;
    return result;
  };
  fs.fstatSync = function driftOpenedFileGroup(fd, ...args) {
    const stat = originalFstat(fd, ...args);
    return stageClosed && stat.isFile() ? withDriftedGroup(stat) : stat;
  };
  fs.lstatSync = function driftPathFileGroup(candidate, ...args) {
    const stat = originalLstat(candidate, ...args);
    return (
      stageClosed &&
      candidate.startsWith(`${sessionsDir}/`) &&
      stat.isFile()
    ) ? withDriftedGroup(stat) : stat;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
    fs.fstatSync = originalFstat;
    fs.lstatSync = originalLstat;
  }

  assert.ok(stagePath);
  assert.equal(stageClosed, true);
  assert.deepEqual(outcome, unavailable());
});

test('initializeIfMissing rejects equal-length stage bytes changed after fsync', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'equal-length-change-after-fsync';
  const canonicalPath = canonicalStatePath(sessionId);
  const intendedContents = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    mode: 'wenyan-full',
    updatedAt: fixedNow().toISOString(),
  })}\n`);
  const replacementContents = Buffer.from(`${JSON.stringify({
    mode: 'wenyan-full',
    schemaVersion: 1,
    updatedAt: fixedNow().toISOString(),
  })}\n`);
  assert.equal(replacementContents.length, intendedContents.length);
  assert.notDeepEqual(replacementContents, intendedContents);
  const originalOpen = fs.openSync;
  const originalFsync = fs.fsyncSync;
  let stagePath;
  let changed = false;

  fs.openSync = function captureStagePath(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (!stagePath && candidate.endsWith('.tmp')) stagePath = candidate;
    return fd;
  };
  fs.fsyncSync = function changeStageAfterFsync(fd, ...args) {
    const result = originalFsync(fd, ...args);
    if (stagePath && !changed) {
      changed = true;
      writeFileSync(stagePath, replacementContents);
    }
    return result;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.openSync = originalOpen;
    fs.fsyncSync = originalFsync;
  }

  assert.ok(stagePath);
  assert.equal(changed, true);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(canonicalPath), false);
  assert.equal(existsSync(stagePath), false);
  const quarantineNames = readdirSync(join(dataDir, 'sessions'));
  assert.equal(quarantineNames.length, 1);
  assert.deepEqual(
    readFileSync(join(dataDir, 'sessions', quarantineNames[0], 'entry')),
    replacementContents,
  );
});

test('initializeIfMissing rejects stage bytes changed after fsync before publication', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'changed-after-fsync';
  const canonicalPath = canonicalStatePath(sessionId);
  const replacementContents = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    mode: 'off',
    updatedAt: fixedNow().toISOString(),
  })}\n`);
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let stagePath;
  let changed = false;

  fs.openSync = function capturingStage(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (!stagePath && candidate.endsWith('.tmp')) stagePath = candidate;
    return fd;
  };
  fs.closeSync = function changingClosedStage(fd) {
    const result = originalClose(fd);
    if (stagePath && !changed) {
      changed = true;
      writeFileSync(stagePath, replacementContents);
    }
    return result;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
  }

  assert.ok(stagePath);
  assert.equal(changed, true);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(canonicalPath), false);
  assert.equal(existsSync(stagePath), false);
  const quarantineNames = readdirSync(join(dataDir, 'sessions'));
  assert.equal(quarantineNames.length, 1);
  assert.deepEqual(
    readFileSync(join(dataDir, 'sessions', quarantineNames[0], 'entry')),
    replacementContents,
  );
});

test('initialization rejects stage bytes changed after verification before no-replace publication', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'changed-after-stage-verification';
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const replacementContents = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    mode: 'off',
    updatedAt: fixedNow().toISOString(),
  })}\n`);
  const originalLink = fs.linkSync;
  let stagePath;
  let changed = false;

  fs.linkSync = function changingVerifiedStage(source, destination, ...args) {
    if (destination === canonicalPath && !changed) {
      stagePath = source;
      changed = true;
      writeFileSync(source, replacementContents);
      fs.chmodSync(source, 0o600);
    }
    return originalLink(source, destination, ...args);
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.linkSync = originalLink;
  }

  assert.equal(changed, true);
  assert.ok(stagePath);
  assert.match(
    basename(stagePath),
    /\.init-v1\.[1-9][0-9]{0,9}\.[0-9a-f]{16}\.[0-9a-f]{64}\.tmp$/,
  );
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(store.read(sessionId), unavailable());
  assert.equal(existsSync(stagePath), true);
  assert.equal(existsSync(canonicalPath), true);
  const stageStat = statSync(stagePath);
  const canonicalStat = statSync(canonicalPath);
  assert.equal(stageStat.dev, canonicalStat.dev);
  assert.equal(stageStat.ino, canonicalStat.ino);
  assert.equal(stageStat.nlink, 2);
  assert.deepEqual(readFileSync(stagePath), replacementContents);
  assert.deepEqual(readFileSync(canonicalPath), replacementContents);
  assert.deepEqual(readdirSync(sessionsDir).sort(), [
    basename(canonicalPath),
    basename(stagePath),
  ].sort());
});

test('initialization rejects semantically equivalent stage bytes changed before no-replace publication', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'equivalent-change-before-publication';
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const intendedContents = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    mode: 'wenyan-full',
    updatedAt: fixedNow().toISOString(),
  })}\n`);
  const replacementContents = Buffer.from(`${JSON.stringify({
    mode: 'wenyan-full',
    schemaVersion: 1,
    updatedAt: fixedNow().toISOString(),
  })}\n`);
  assert.equal(replacementContents.length, intendedContents.length);
  assert.notDeepEqual(replacementContents, intendedContents);
  const originalLink = fs.linkSync;
  let stagePath;
  let changed = false;

  fs.linkSync = function changingVerifiedStage(source, destination, ...args) {
    if (destination === canonicalPath && !changed) {
      stagePath = source;
      const before = statSync(source);
      changed = true;
      writeFileSync(source, replacementContents);
      fs.chmodSync(source, 0o600);
      fs.utimesSync(source, before.atimeMs / 1000, before.mtimeMs / 1000);
    }
    return originalLink(source, destination, ...args);
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.linkSync = originalLink;
  }

  assert.equal(changed, true);
  assert.ok(stagePath);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(store.read(sessionId), unavailable());
  assert.equal(existsSync(stagePath), true);
  assert.equal(existsSync(canonicalPath), true);
  const stageStat = statSync(stagePath);
  const canonicalStat = statSync(canonicalPath);
  assert.equal(stageStat.dev, canonicalStat.dev);
  assert.equal(stageStat.ino, canonicalStat.ino);
  assert.equal(stageStat.nlink, 2);
  assert.deepEqual(readFileSync(stagePath), replacementContents);
  assert.deepEqual(readFileSync(canonicalPath), replacementContents);
  assert.deepEqual(readdirSync(sessionsDir).sort(), [
    basename(canonicalPath),
    basename(stagePath),
  ].sort());
});

test('initialization does not publish into a root replaced during pre-link stage validation', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'pre-link-stage-root-race';
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const displacedDir = join(temporaryRoot, 'displaced-pre-link-stage');
  const canonicalPath = canonicalStatePath(sessionId);
  const originalRoot = lstatSync(sessionsDir);
  const originalLstat = fs.lstatSync;
  const originalLink = fs.linkSync;
  let stagePath;
  let stageLstats = 0;
  let replaced = false;

  fs.lstatSync = function replacingRootDuringStageValidation(candidate, ...args) {
    const sampled = originalLstat(candidate, ...args);
    if (typeof candidate === 'string' && candidate.endsWith('.tmp')) {
      stagePath = candidate;
      stageLstats += 1;
      if (stageLstats === 3 && !replaced) {
        replaced = true;
        fs.renameSync(sessionsDir, displacedDir);
        mkdirSync(sessionsDir, { mode: 0o700 });
        originalLink(
          join(displacedDir, basename(stagePath)),
          stagePath,
        );
      }
    }
    return sampled;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.lstatSync = originalLstat;
  }

  assert.equal(stageLstats, 3);
  assert.equal(replaced, true);
  assert.ok(stagePath);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(store.read(sessionId), unavailable());
  const replacementRoot = lstatSync(sessionsDir);
  assert.notEqual(replacementRoot.ino, originalRoot.ino);
  assert.equal(existsSync(canonicalPath), false);
  assert.equal(existsSync(stagePath), true);
  assert.equal(
    existsSync(join(displacedDir, basename(stagePath))),
    true,
  );
  assert.deepEqual(readdirSync(sessionsDir), [basename(stagePath)]);
  assert.deepEqual(readdirSync(displacedDir), [basename(stagePath)]);
});

test('initialization preserves a two-link prefix when the first parent barrier fails', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'first-parent-barrier';
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const expectedContents = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    mode: 'wenyan-full',
    updatedAt: fixedNow().toISOString(),
  })}\n`);
  const originalOpen = fs.openSync;
  let stagePath;
  let failed = false;

  fs.openSync = function failingFirstParentOpen(candidate, ...args) {
    if (candidate === sessionsDir && !failed) {
      failed = true;
      throw simulatedIoError('simulated first parent barrier failure');
    }
    const fd = originalOpen(candidate, ...args);
    if (!stagePath && candidate.endsWith('.tmp')) stagePath = candidate;
    return fd;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.openSync = originalOpen;
  }

  assert.equal(failed, true);
  assert.ok(stagePath);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(stagePath), true);
  assert.equal(existsSync(canonicalPath), true);
  assert.deepEqual(readFileSync(stagePath), expectedContents);
  assert.deepEqual(readFileSync(canonicalPath), expectedContents);
  const stageStat = statSync(stagePath);
  const canonicalStat = statSync(canonicalPath);
  assert.equal(stageStat.dev, canonicalStat.dev);
  assert.equal(stageStat.ino, canonicalStat.ino);
  assert.equal(stageStat.nlink, 2);
  assert.deepEqual(readdirSync(sessionsDir).sort(), [
    basename(canonicalPath),
    basename(stagePath),
  ].sort());
});

test('initialization preserves all evidence when a third link appears after the first barrier', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'third-link-after-barrier';
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const aliasPath = join(temporaryRoot, 'third-publication-link.json');
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let stagePath;
  let directoryOpens = 0;
  let reopenedDirectoryFd;
  let linked = false;

  fs.openSync = function capturingBarrierReopen(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (!stagePath && candidate.endsWith('.tmp')) stagePath = candidate;
    if (candidate === sessionsDir) {
      directoryOpens += 1;
      if (directoryOpens === 2) reopenedDirectoryFd = fd;
    }
    return fd;
  };
  fs.closeSync = function linkingAfterFirstBarrier(fd) {
    const result = originalClose(fd);
    if (fd === reopenedDirectoryFd && !linked) {
      linked = true;
      fs.linkSync(canonicalPath, aliasPath);
    }
    return result;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
  }

  assert.equal(linked, true);
  assert.ok(stagePath);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(stagePath), true);
  assert.equal(existsSync(canonicalPath), true);
  assert.equal(existsSync(aliasPath), true);
  const stageStat = statSync(stagePath);
  const canonicalStat = statSync(canonicalPath);
  const aliasStat = statSync(aliasPath);
  assert.equal(stageStat.dev, canonicalStat.dev);
  assert.equal(stageStat.ino, canonicalStat.ino);
  assert.equal(aliasStat.dev, canonicalStat.dev);
  assert.equal(aliasStat.ino, canonicalStat.ino);
  assert.equal(stageStat.nlink, 3);
  assert.deepEqual(readdirSync(sessionsDir).sort(), [
    basename(canonicalPath),
    basename(stagePath),
  ].sort());
});

test('initialization preserves a foreign inode under publication-alias role', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'foreign-inode-swapped-into-publication-alias';
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const expectedContents = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    mode: 'wenyan-full',
    updatedAt: fixedNow().toISOString(),
  })}\n`);
  const foreignContents = Buffer.from('foreign publication-alias evidence\n');
  const originalOpen = fs.openSync;
  const originalLstat = fs.lstatSync;
  const originalUnlink = fs.unlinkSync;
  let stagePath;
  let stageLstats = 0;
  let swapped = false;
  let foreignStat;

  fs.openSync = function captureOwnedStage(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (!stagePath && candidate.endsWith('.tmp')) stagePath = candidate;
    return fd;
  };
  fs.lstatSync = function swapOwnedStageAfterValidation(candidate, ...args) {
    const sampled = originalLstat(candidate, ...args);
    if (candidate === stagePath) {
      stageLstats += 1;
      if (stageLstats === 8 && !swapped) {
        swapped = true;
        originalUnlink(stagePath);
        writeFileSync(stagePath, foreignContents, { mode: 0o600 });
        fs.chmodSync(stagePath, 0o600);
        foreignStat = originalLstat(stagePath);
      }
    }
    return sampled;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.openSync = originalOpen;
    fs.lstatSync = originalLstat;
  }

  assert.ok(stagePath);
  assert.equal(swapped, true);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(canonicalPath), expectedContents);
  assert.equal(statSync(canonicalPath).nlink, 1);
  const quarantineNames = readdirSync(sessionsDir)
    .filter((name) => name !== basename(canonicalPath));
  assert.equal(quarantineNames.length, 1);
  assert.ok(quarantineNames[0].startsWith(
    `.${basename(canonicalPath)}.q.publication-alias.`,
  ));
  const quarantinePath = join(sessionsDir, quarantineNames[0]);
  const quarantineStat = lstatSync(quarantinePath);
  assert.equal(quarantineStat.isDirectory(), true);
  assert.equal(quarantineStat.isSymbolicLink(), false);
  assert.equal(quarantineStat.mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(quarantinePath), ['entry']);
  const preservedPath = join(quarantinePath, 'entry');
  assert.deepEqual(readFileSync(preservedPath), foreignContents);
  const preservedStat = statSync(preservedPath);
  assert.equal(preservedStat.dev, foreignStat.dev);
  assert.equal(preservedStat.ino, foreignStat.ino);
});

test('initialization rejects same-inode bytes changed after pair verification', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'same-inode-bytes-changed-after-pair-verification';
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const replacementContents = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    mode: 'ultra',
    updatedAt: fixedNow().toISOString(),
  })}\n`);
  const originalOpen = fs.openSync;
  const originalLstat = fs.lstatSync;
  let stagePath;
  let stageLstats = 0;
  let changed = false;

  fs.openSync = function captureOwnedStage(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (!stagePath && candidate.endsWith('.tmp')) stagePath = candidate;
    return fd;
  };
  fs.lstatSync = function changePairAfterVerification(candidate, ...args) {
    const sampled = originalLstat(candidate, ...args);
    if (candidate === stagePath) {
      stageLstats += 1;
      if (stageLstats === 8 && !changed) {
        changed = true;
        writeFileSync(stagePath, replacementContents);
        fs.chmodSync(stagePath, 0o600);
      }
    }
    return sampled;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.openSync = originalOpen;
    fs.lstatSync = originalLstat;
  }

  assert.ok(stagePath);
  assert.equal(changed, true);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(stagePath), false);
  assert.deepEqual(readFileSync(canonicalPath), replacementContents);
  const canonicalStat = statSync(canonicalPath);
  const quarantineNames = readdirSync(sessionsDir)
    .filter((name) => name !== basename(canonicalPath));
  assert.equal(quarantineNames.length, 1);
  const quarantinePath = join(sessionsDir, quarantineNames[0]);
  assert.deepEqual(readdirSync(quarantinePath), ['entry']);
  const quarantinedPath = join(quarantinePath, 'entry');
  assert.deepEqual(readFileSync(quarantinedPath), replacementContents);
  const quarantinedStat = statSync(quarantinedPath);
  assert.equal(quarantinedStat.dev, canonicalStat.dev);
  assert.equal(quarantinedStat.ino, canonicalStat.ino);
  assert.equal(quarantinedStat.nlink, 2);
});

test('initialization preserves a quarantined two-link prefix when cleanup fails', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'stage-unlink-failure';
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const originalOpen = fs.openSync;
  const originalUnlink = fs.unlinkSync;
  let stagePath;
  let failed = false;

  fs.openSync = function capturingStageForUnlink(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (!stagePath && candidate.endsWith('.tmp')) stagePath = candidate;
    return fd;
  };
  fs.unlinkSync = function failingStageUnlink(candidate, ...args) {
    if (basename(candidate) === 'entry' && !failed) {
      failed = true;
      throw simulatedIoError('simulated stage unlink failure');
    }
    return originalUnlink(candidate, ...args);
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.openSync = originalOpen;
    fs.unlinkSync = originalUnlink;
  }

  assert.equal(failed, true);
  assert.ok(stagePath);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(stagePath), false);
  assert.equal(existsSync(canonicalPath), true);
  const canonicalStat = statSync(canonicalPath);
  const quarantineNames = readdirSync(sessionsDir)
    .filter((name) => name !== basename(canonicalPath));
  assert.equal(quarantineNames.length, 1);
  const quarantinePath = join(sessionsDir, quarantineNames[0]);
  assert.deepEqual(readdirSync(quarantinePath), ['entry']);
  const quarantinedStat = statSync(join(quarantinePath, 'entry'));
  assert.equal(quarantinedStat.dev, canonicalStat.dev);
  assert.equal(quarantinedStat.ino, canonicalStat.ino);
  assert.equal(quarantinedStat.nlink, 2);
});

test('initialization preserves its pair when the quarantine parent barrier fails', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'second-parent-barrier';
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const expectedContents = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    mode: 'wenyan-full',
    updatedAt: fixedNow().toISOString(),
  })}\n`);
  const originalOpen = fs.openSync;
  let stagePath;
  let directoryOpens = 0;
  let failed = false;

  fs.openSync = function failingSecondParentOpen(candidate, ...args) {
    if (candidate === sessionsDir) {
      directoryOpens += 1;
      if (directoryOpens === 3) {
        failed = true;
        throw simulatedIoError('simulated second parent barrier failure');
      }
    }
    const fd = originalOpen(candidate, ...args);
    if (!stagePath && candidate.endsWith('.tmp')) stagePath = candidate;
    return fd;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.openSync = originalOpen;
  }

  assert.equal(failed, true);
  assert.ok(stagePath);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(stagePath), true);
  assert.equal(existsSync(canonicalPath), true);
  assert.deepEqual(readFileSync(stagePath), expectedContents);
  assert.deepEqual(readFileSync(canonicalPath), expectedContents);
  const stageStat = statSync(stagePath);
  const canonicalStat = statSync(canonicalPath);
  assert.equal(stageStat.dev, canonicalStat.dev);
  assert.equal(stageStat.ino, canonicalStat.ino);
  assert.equal(stageStat.nlink, 2);
  const quarantineNames = readdirSync(sessionsDir).filter((name) => (
    name !== basename(stagePath) && name !== basename(canonicalPath)
  ));
  assert.equal(quarantineNames.length, 1);
  const quarantinePath = join(sessionsDir, quarantineNames[0]);
  assert.equal(lstatSync(quarantinePath).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(quarantinePath), []);
});

test('read retries an empty initialization-quarantine barrier before found', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'empty-quarantine-barrier-debt';
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const expectedContents = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    mode: 'wenyan-full',
    updatedAt: fixedNow().toISOString(),
  })}\n`);
  const originalOpen = fs.openSync;
  const originalUnlink = fs.unlinkSync;
  let quarantinePath;
  let entryRemoved = false;
  let failBarrier = true;
  let barrierFailures = 0;

  fs.unlinkSync = function captureQuarantineEntryRemoval(candidate, ...args) {
    const result = originalUnlink(candidate, ...args);
    if (basename(candidate) === 'entry') {
      quarantinePath = dirname(candidate);
      entryRemoved = true;
    }
    return result;
  };
  fs.openSync = function failEmptyQuarantineBarrier(candidate, ...args) {
    if (
      failBarrier &&
      entryRemoved &&
      candidate === quarantinePath
    ) {
      barrierFailures += 1;
      throw simulatedIoError('simulated empty quarantine barrier failure');
    }
    return originalOpen(candidate, ...args);
  };
  let initialized;
  let blockedRead;
  let recoveredRead;
  try {
    initialized = store.initializeIfMissing(sessionId, 'wenyan-full');
    blockedRead = store.read(sessionId);
    failBarrier = false;
    recoveredRead = store.read(sessionId);
  } finally {
    fs.openSync = originalOpen;
    fs.unlinkSync = originalUnlink;
  }

  assert.equal(entryRemoved, true);
  assert.ok(barrierFailures >= 2);
  assert.deepEqual(initialized, unavailable());
  assert.deepEqual(blockedRead, unavailable());
  assert.deepEqual(recoveredRead, found('wenyan-full'));
  assert.deepEqual(readFileSync(canonicalPath), expectedContents);
  assert.equal(statSync(canonicalPath).nlink, 1);
  assert.ok(quarantinePath);
  assert.equal(dirname(quarantinePath), sessionsDir);
  assert.deepEqual(readdirSync(quarantinePath), []);
});

test('initializeIfMissing retries an empty quarantine barrier before found', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'empty-quarantine-initialize-debt';
  const canonicalPath = canonicalStatePath(sessionId);
  const originalOpen = fs.openSync;
  const originalUnlink = fs.unlinkSync;
  let quarantinePath;
  let entryRemoved = false;
  let failBarrier = true;
  let barrierFailures = 0;

  fs.unlinkSync = function captureQuarantineEntryRemoval(candidate, ...args) {
    const result = originalUnlink(candidate, ...args);
    if (basename(candidate) === 'entry') {
      quarantinePath = dirname(candidate);
      entryRemoved = true;
    }
    return result;
  };
  fs.openSync = function failEmptyQuarantineBarrier(candidate, ...args) {
    if (
      failBarrier &&
      entryRemoved &&
      candidate === quarantinePath
    ) {
      barrierFailures += 1;
      throw simulatedIoError('simulated empty quarantine barrier failure');
    }
    return originalOpen(candidate, ...args);
  };
  let initialized;
  let blockedRetry;
  let recoveredRetry;
  try {
    initialized = store.initializeIfMissing(sessionId, 'wenyan-full');
    blockedRetry = store.initializeIfMissing(sessionId, 'off');
    failBarrier = false;
    recoveredRetry = store.initializeIfMissing(sessionId, 'off');
  } finally {
    fs.openSync = originalOpen;
    fs.unlinkSync = originalUnlink;
  }

  assert.equal(entryRemoved, true);
  assert.ok(barrierFailures >= 2);
  assert.deepEqual(initialized, unavailable());
  assert.deepEqual(blockedRetry, unavailable());
  assert.deepEqual(recoveredRetry, found('wenyan-full'));
  assert.equal(statSync(canonicalPath).nlink, 1);
  assert.ok(quarantinePath);
  assert.deepEqual(readdirSync(quarantinePath), []);
});

test('pair recovery honors an existing empty quarantine barrier', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'pair-beside-empty-quarantine';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const contents = readFileSync(canonicalPath);
  const digest = createHash('sha256').update(contents).digest('hex');
  const aliasPath = initializationAliasPath(canonicalPath, contents);
  const quarantinePath = join(
    sessionsDir,
    `.${basename(canonicalPath)}.q.publication-alias.${digest}.0123456789abcdef.fedcba9876543210`,
  );
  fs.linkSync(canonicalPath, aliasPath);
  mkdirSync(quarantinePath, { mode: 0o700 });
  const originalOpen = fs.openSync;
  let failBarrier = true;
  let barrierFailures = 0;

  fs.openSync = function failExistingQuarantineBarrier(candidate, ...args) {
    if (failBarrier && candidate === quarantinePath) {
      barrierFailures += 1;
      throw simulatedIoError('simulated existing quarantine barrier failure');
    }
    return originalOpen(candidate, ...args);
  };
  let blockedRead;
  let recoveredRead;
  try {
    blockedRead = store.read(sessionId);
    failBarrier = false;
    recoveredRead = store.read(sessionId);
  } finally {
    fs.openSync = originalOpen;
  }

  assert.ok(barrierFailures >= 1);
  assert.deepEqual(blockedRead, unavailable());
  assert.deepEqual(recoveredRead, found('off'));
  assert.equal(existsSync(aliasPath), false);
  assert.deepEqual(readFileSync(canonicalPath), contents);
  assert.equal(statSync(canonicalPath).nlink, 1);
  assert.deepEqual(readdirSync(quarantinePath), []);
});

test('read rejects empty quarantine identity revalidation failures', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'empty-quarantine-identity-revalidation-failure';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const contents = readFileSync(canonicalPath);
  const digest = createHash('sha256').update(contents).digest('hex');
  const quarantinePath = join(
    sessionsDir,
    `.${basename(canonicalPath)}.q.owned-stage.${digest}.0123456789abcdef.fedcba9876543210`,
  );
  mkdirSync(quarantinePath, { mode: 0o700 });
  const originalLstat = fs.lstatSync;
  const originalOpen = fs.openSync;
  let quarantineLstats = 0;
  let quarantineOpens = 0;

  fs.lstatSync = function failQuarantineRevalidation(candidate, ...args) {
    if (candidate === quarantinePath) {
      quarantineLstats += 1;
      if (quarantineLstats === 3 || quarantineLstats === 5) {
        throw simulatedIoError('simulated quarantine revalidation failure');
      }
    }
    return originalLstat(candidate, ...args);
  };
  fs.openSync = function countQuarantineOpens(candidate, ...args) {
    if (candidate === quarantinePath) quarantineOpens += 1;
    return originalOpen(candidate, ...args);
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.lstatSync = originalLstat;
    fs.openSync = originalOpen;
  }

  assert.equal(quarantineLstats, 3);
  assert.equal(quarantineOpens, 0);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(canonicalPath), contents);
  assert.deepEqual(readdirSync(quarantinePath), []);
});

test('read rejects empty quarantine contents changed between snapshots', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'empty-quarantine-content-drift';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const contents = readFileSync(canonicalPath);
  const digest = createHash('sha256').update(contents).digest('hex');
  const quarantinePath = join(
    sessionsDir,
    `.${basename(canonicalPath)}.q.owned-stage.${digest}.0123456789abcdef.fedcba9876543210`,
  );
  const markerPath = join(quarantinePath, 'late-marker');
  mkdirSync(quarantinePath, { mode: 0o700 });
  const originalOpen = fs.openSync;
  let canonicalOpens = 0;
  let changed = false;

  fs.openSync = function changeQuarantineBeforeFinalSnapshot(candidate, ...args) {
    if (candidate === canonicalPath) {
      canonicalOpens += 1;
      if (canonicalOpens === 3 && !changed) {
        changed = true;
        writeFileSync(markerPath, 'late evidence\n');
      }
    }
    return originalOpen(candidate, ...args);
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.openSync = originalOpen;
  }

  assert.equal(changed, true);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(canonicalPath), contents);
  assert.equal(readFileSync(markerPath, 'utf8'), 'late evidence\n');
});

test('read rejects empty quarantine identity changed between snapshots', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'empty-quarantine-identity-drift';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const contents = readFileSync(canonicalPath);
  const digest = createHash('sha256').update(contents).digest('hex');
  const quarantinePath = join(
    sessionsDir,
    `.${basename(canonicalPath)}.q.publication-alias.${digest}.0123456789abcdef.fedcba9876543210`,
  );
  mkdirSync(quarantinePath, { mode: 0o700 });
  const beforeQuarantine = statSync(quarantinePath);
  const originalOpen = fs.openSync;
  let canonicalOpens = 0;
  let changed = false;

  fs.openSync = function replaceQuarantineBeforeFinalSnapshot(candidate, ...args) {
    if (candidate === canonicalPath) {
      canonicalOpens += 1;
      if (canonicalOpens === 3 && !changed) {
        changed = true;
        rmSync(quarantinePath, { recursive: true });
        mkdirSync(quarantinePath, { mode: 0o700 });
      }
    }
    return originalOpen(candidate, ...args);
  };
  let outcome;
  try {
    outcome = store.read(sessionId);
  } finally {
    fs.openSync = originalOpen;
  }

  assert.equal(changed, true);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(canonicalPath), contents);
  const afterQuarantine = statSync(quarantinePath);
  assert.notEqual(afterQuarantine.ino, beforeQuarantine.ino);
  assert.deepEqual(readdirSync(quarantinePath), []);
});

test('read rejects empty quarantine descriptor close failures', {
  skip: process.platform === 'win32',
}, () => {
  for (const closeOrdinal of [1, 2]) {
    const store = createStateStore(dataDir, { now: fixedNow });
    const sessionId = `empty-quarantine-close-${closeOrdinal}`;
    assert.equal(store.write(sessionId, 'off'), true);
    const sessionsDir = join(realpathSync(dataDir), 'sessions');
    const canonicalPath = canonicalStatePath(sessionId);
    const contents = readFileSync(canonicalPath);
    const digest = createHash('sha256').update(contents).digest('hex');
    const quarantinePath = join(
      sessionsDir,
      `.${basename(canonicalPath)}.q.owned-stage.${digest}.0123456789abcdef.fedcba9876543210`,
    );
    mkdirSync(quarantinePath, { mode: 0o700 });
    const originalOpen = fs.openSync;
    const originalClose = fs.closeSync;
    let quarantineOpens = 0;
    let failedFd;
    let failed = false;

    fs.openSync = function captureQuarantineDescriptor(candidate, ...args) {
      const fd = originalOpen(candidate, ...args);
      if (candidate === quarantinePath) {
        quarantineOpens += 1;
        if (quarantineOpens === closeOrdinal) failedFd = fd;
      }
      return fd;
    };
    fs.closeSync = function failQuarantineClose(fd, ...args) {
      const result = originalClose(fd, ...args);
      if (fd === failedFd && !failed) {
        failed = true;
        throw simulatedIoError('simulated quarantine close failure');
      }
      return result;
    };
    let outcome;
    try {
      outcome = store.read(sessionId);
    } finally {
      fs.openSync = originalOpen;
      fs.closeSync = originalClose;
    }

    assert.equal(failed, true);
    assert.equal(quarantineOpens, closeOrdinal);
    assert.deepEqual(outcome, unavailable());
    assert.deepEqual(readFileSync(canonicalPath), contents);
    assert.deepEqual(readdirSync(quarantinePath), []);
  }
});

test('store binding rejects data-root descriptor close failures', {
  skip: process.platform === 'win32',
}, () => {
  for (const closeOrdinal of [1, 2]) {
    const boundDataDir = join(temporaryRoot, `data-root-close-${closeOrdinal}`);
    mkdirSync(join(boundDataDir, 'sessions'), {
      recursive: true,
      mode: 0o700,
    });
    const dataRoot = realpathSync(boundDataDir);
    const originalOpen = fs.openSync;
    const originalClose = fs.closeSync;
    let dataOpens = 0;
    let failedFd;
    let failed = false;

    fs.openSync = function captureDataRootDescriptor(candidate, ...args) {
      const fd = originalOpen(candidate, ...args);
      if (candidate === dataRoot) {
        dataOpens += 1;
        if (dataOpens === closeOrdinal) failedFd = fd;
      }
      return fd;
    };
    fs.closeSync = function failDataRootClose(fd, ...args) {
      const result = originalClose(fd, ...args);
      if (fd === failedFd && !failed) {
        failed = true;
        throw simulatedIoError('simulated data-root close failure');
      }
      return result;
    };
    let store;
    try {
      store = createStateStore(boundDataDir, { now: fixedNow });
    } finally {
      fs.openSync = originalOpen;
      fs.closeSync = originalClose;
    }

    assert.equal(failed, true);
    assert.equal(dataOpens, closeOrdinal);
    assert.deepEqual(store.read('unbound-session'), unavailable());
    assert.deepEqual(readdirSync(join(boundDataDir, 'sessions')), []);
  }
});

test('initialization leaves a final-only prefix when quarantine removal is not durable', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'quarantine-removal-parent-barrier-failure';
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const expectedContents = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    mode: 'wenyan-full',
    updatedAt: fixedNow().toISOString(),
  })}\n`);
  const originalOpen = fs.openSync;
  const originalRmdir = fs.rmdirSync;
  let stagePath;
  let quarantineRemoved = false;
  let failed = false;

  fs.openSync = function failRemovalParentBarrier(candidate, ...args) {
    if (candidate === sessionsDir && quarantineRemoved && !failed) {
      failed = true;
      throw simulatedIoError('simulated quarantine removal parent barrier failure');
    }
    const fd = originalOpen(candidate, ...args);
    if (!stagePath && candidate.endsWith('.tmp')) stagePath = candidate;
    return fd;
  };
  fs.rmdirSync = function captureQuarantineRemoval(candidate, ...args) {
    const result = originalRmdir(candidate, ...args);
    if (dirname(candidate) === sessionsDir) quarantineRemoved = true;
    return result;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.openSync = originalOpen;
    fs.rmdirSync = originalRmdir;
  }

  assert.ok(stagePath);
  assert.equal(quarantineRemoved, true);
  assert.equal(failed, true);
  assert.deepEqual(outcome, unavailable());
  assert.equal(existsSync(stagePath), false);
  assert.deepEqual(readFileSync(canonicalPath), expectedContents);
  assert.equal(statSync(canonicalPath).nlink, 1);
  assertOnlyStateFile(sessionId);
});

test('initialization rejects root replacement after the second parent barrier', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'root-replaced-after-second-barrier';
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const displacedDir = join(temporaryRoot, 'displaced-after-second-barrier');
  const fileName = `${stateKey(sessionId)}.json`;
  const filePath = join(sessionsDir, fileName);
  const expectedContents = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    mode: 'wenyan-full',
    updatedAt: fixedNow().toISOString(),
  })}\n`);
  const originalRoot = lstatSync(sessionsDir);
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const originalLstat = fs.lstatSync;
  const originalRmdir = fs.rmdirSync;
  let quarantineRemoved = false;
  let cleanupBarrierOpens = 0;
  let finalDirectoryFd;
  let finalDirectoryClosed = false;
  let rootSamplesAfterClose = 0;
  let replaced = false;

  fs.openSync = function trackSecondBarrierOpen(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (candidate === sessionsDir && quarantineRemoved) {
      cleanupBarrierOpens += 1;
      if (cleanupBarrierOpens === 2) finalDirectoryFd = fd;
    }
    return fd;
  };
  fs.rmdirSync = function trackQuarantineRemoval(candidate, ...args) {
    const result = originalRmdir(candidate, ...args);
    if (dirname(candidate) === sessionsDir) quarantineRemoved = true;
    return result;
  };
  fs.closeSync = function trackSecondBarrierClose(fd, ...args) {
    const result = originalClose(fd, ...args);
    if (fd === finalDirectoryFd) finalDirectoryClosed = true;
    return result;
  };
  fs.lstatSync = function replaceRootAfterBarrier(candidate, ...args) {
    const sampled = originalLstat(candidate, ...args);
    if (candidate === sessionsDir && finalDirectoryClosed && !replaced) {
      rootSamplesAfterClose += 1;
      if (rootSamplesAfterClose === 3) {
        replaced = true;
        fs.renameSync(sessionsDir, displacedDir);
        fs.mkdirSync(sessionsDir, { mode: 0o700 });
        fs.renameSync(join(displacedDir, fileName), filePath);
      }
    }
    return sampled;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
    fs.lstatSync = originalLstat;
    fs.rmdirSync = originalRmdir;
  }

  assert.equal(replaced, true);
  const replacementRoot = lstatSync(sessionsDir);
  const published = lstatSync(filePath);
  assert.notEqual(replacementRoot.ino, originalRoot.ino);
  assert.equal(published.nlink, 1);
  assert.deepEqual(readFileSync(filePath), expectedContents);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readdirSync(displacedDir), []);
  assertOnlyStateFile(sessionId);
});

test('initialization rejects root replacement during the final record read', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'root-replaced-during-final-read';
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const displacedDir = join(temporaryRoot, 'displaced-during-final-read');
  const fileName = `${stateKey(sessionId)}.json`;
  const filePath = join(sessionsDir, fileName);
  const expectedContents = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    mode: 'wenyan-full',
    updatedAt: fixedNow().toISOString(),
  })}\n`);
  const originalRoot = lstatSync(sessionsDir);
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const originalLstat = fs.lstatSync;
  const originalRmdir = fs.rmdirSync;
  let quarantineRemoved = false;
  let cleanupBarrierOpens = 0;
  let finalDirectoryFd;
  let finalDirectoryClosed = false;
  let finalRecordSamples = 0;
  let sampledRecord;
  let replaced = false;

  fs.openSync = function trackSecondBarrierOpen(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (candidate === sessionsDir && quarantineRemoved) {
      cleanupBarrierOpens += 1;
      if (cleanupBarrierOpens === 2) finalDirectoryFd = fd;
    }
    return fd;
  };
  fs.rmdirSync = function trackQuarantineRemoval(candidate, ...args) {
    const result = originalRmdir(candidate, ...args);
    if (dirname(candidate) === sessionsDir) quarantineRemoved = true;
    return result;
  };
  fs.closeSync = function trackSecondBarrierClose(fd, ...args) {
    const result = originalClose(fd, ...args);
    if (fd === finalDirectoryFd) finalDirectoryClosed = true;
    return result;
  };
  fs.lstatSync = function replaceRootDuringFinalRead(candidate, ...args) {
    const sampled = originalLstat(candidate, ...args);
    if (candidate === filePath && finalDirectoryClosed && !replaced) {
      finalRecordSamples += 1;
      if (finalRecordSamples === 2) {
        sampledRecord = sampled;
        replaced = true;
        fs.renameSync(sessionsDir, displacedDir);
        fs.mkdirSync(sessionsDir, { mode: 0o700 });
        fs.renameSync(join(displacedDir, fileName), filePath);
      }
    }
    return sampled;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
    fs.lstatSync = originalLstat;
    fs.rmdirSync = originalRmdir;
  }

  assert.equal(replaced, true);
  const replacementRoot = lstatSync(sessionsDir);
  const published = lstatSync(filePath);
  assert.notEqual(replacementRoot.ino, originalRoot.ino);
  assert.equal(published.dev, sampledRecord.dev);
  assert.equal(published.ino, sampledRecord.ino);
  assert.equal(published.nlink, 1);
  assert.deepEqual(readFileSync(filePath), expectedContents);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readdirSync(displacedDir), []);
  assertOnlyStateFile(sessionId);
});

test('initialization leaves a private-name temp-only orphan inert', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'temp-only-orphan';
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const fileName = `${stateKey(sessionId)}.json`;
  const orphanContents = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    mode: 'off',
    updatedAt: fixedNow().toISOString(),
  })}\n`);
  const orphanPath = initializationAliasPath(
    join(sessionsDir, fileName),
    orphanContents,
  );
  const orphanName = basename(orphanPath);
  writeFileSync(orphanPath, orphanContents, { mode: 0o600 });
  const orphanStat = statSync(orphanPath);

  const outcome = store.initializeIfMissing(sessionId, 'wenyan-full');

  assert.deepEqual(outcome, found('wenyan-full'));
  assert.deepEqual(store.read(sessionId), found('wenyan-full'));
  assert.deepEqual(readFileSync(orphanPath), orphanContents);
  const afterOrphanStat = statSync(orphanPath);
  assert.equal(afterOrphanStat.dev, orphanStat.dev);
  assert.equal(afterOrphanStat.ino, orphanStat.ino);
  assert.deepEqual(readdirSync(sessionsDir).sort(), [
    fileName,
    orphanName,
  ].sort());
});

test('initialization rejects same-path sessions-root replacement before staging', () => {
  const sessionsDir = join(dataDir, 'sessions');
  const displacedDir = join(temporaryRoot, 'displaced-before-stage');
  let replaced = false;
  let originalRoot;
  const store = createStateStore(dataDir, {
    now() {
      originalRoot = lstatSync(sessionsDir);
      fs.renameSync(sessionsDir, displacedDir);
      fs.mkdirSync(sessionsDir, { mode: 0o700 });
      replaced = true;
      return fixedNow();
    },
  });

  const outcome = store.initializeIfMissing(
    'same-path-root-race',
    'wenyan-full',
  );

  assert.equal(replaced, true);
  const replacementRoot = lstatSync(sessionsDir);
  assert.notEqual(replacementRoot.ino, originalRoot.ino);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readdirSync(sessionsDir), []);
  assert.deepEqual(readdirSync(displacedDir), []);
});

test('initialization rejects a valid record under a replaced sessions root', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'winner-under-replaced-root';
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const displacedDir = join(temporaryRoot, 'displaced-before-init');
  const originalRoot = lstatSync(sessionsDir);
  fs.renameSync(sessionsDir, displacedDir);
  fs.mkdirSync(sessionsDir, { mode: 0o700 });
  const filePath = writeStateFile(sessionId, {
    schemaVersion: 1,
    mode: 'off',
    updatedAt: fixedNow().toISOString(),
  });
  fs.chmodSync(filePath, 0o600);
  const winnerContents = readFileSync(filePath);
  const winnerStat = statSync(filePath);

  const outcome = store.initializeIfMissing(sessionId, 'wenyan-full');

  const replacementRoot = lstatSync(sessionsDir);
  assert.notEqual(replacementRoot.ino, originalRoot.ino);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readFileSync(filePath), winnerContents);
  const afterStat = statSync(filePath);
  assert.equal(afterStat.dev, winnerStat.dev);
  assert.equal(afterStat.ino, winnerStat.ino);
  assert.deepEqual(readdirSync(displacedDir), []);
  assertOnlyStateFile(sessionId);
});

test('initialization rejects root replacement after reading an existing record', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'existing-root-race';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const fileName = `${stateKey(sessionId)}.json`;
  const filePath = join(sessionsDir, fileName);
  const displacedDir = join(temporaryRoot, 'displaced-after-init-read');
  const originalRoot = lstatSync(sessionsDir);
  const originalRecord = lstatSync(filePath);
  const originalContents = readFileSync(filePath);
  const originalLstat = fs.lstatSync;
  let canonicalLstats = 0;
  let replaced = false;

  fs.lstatSync = function replaceRootAfterExistingRecordSample(candidate, ...args) {
    const sampled = originalLstat(candidate, ...args);
    if (candidate === filePath) {
      canonicalLstats += 1;
      if (canonicalLstats === 2) {
        replaced = true;
        fs.renameSync(sessionsDir, displacedDir);
        fs.mkdirSync(sessionsDir, { mode: 0o700 });
        fs.renameSync(join(displacedDir, fileName), filePath);
      }
    }
    return sampled;
  };
  let outcome;
  try {
    outcome = store.initializeIfMissing(sessionId, 'wenyan-full');
  } finally {
    fs.lstatSync = originalLstat;
  }

  assert.equal(replaced, true);
  const replacementRoot = lstatSync(sessionsDir);
  const finalRecord = lstatSync(filePath);
  assert.notEqual(replacementRoot.ino, originalRoot.ino);
  assert.equal(finalRecord.dev, originalRecord.dev);
  assert.equal(finalRecord.ino, originalRecord.ino);
  assert.deepEqual(readFileSync(filePath), originalContents);
  assert.deepEqual(outcome, unavailable());
  assert.deepEqual(readdirSync(displacedDir), []);
  assertOnlyStateFile(sessionId);
});

test('initialization revalidates the root after calling its clock', () => {
  const sessionsDir = join(dataDir, 'sessions');
  const store = createStateStore(dataDir, {
    now() {
      rmSync(sessionsDir, { recursive: true });
      symlinkSync(externalDir, sessionsDir);
      return fixedNow();
    },
  });

  assert.deepEqual(
    store.initializeIfMissing('clock-root-race', 'wenyan-full'),
    unavailable(),
  );
  assert.deepEqual(readdirSync(externalDir), []);
});

test('atomically replaces canonical state with a private schema file', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  assert.equal(store.write('session-a', ' WENYAN '), true);

  const filePath = canonicalStatePath('session-a');
  assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), {
    schemaVersion: 1,
    mode: 'wenyan-full',
    updatedAt: fixedNow().toISOString(),
  });
  if (process.platform !== 'win32') {
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
  }

  const replacementTime = new Date(FIXED_TIME + 1_000);
  assert.equal(store.write('session-a', 'full', replacementTime), true);
  assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), {
    schemaVersion: 1,
    mode: 'full',
    updatedAt: replacementTime.toISOString(),
  });
  assert.deepEqual(readdirSync(join(dataDir, 'sessions')), [
    `${stateKey('session-a')}.json`,
  ]);
});

test('write rejects same-path sessions-root replacement before staging', {
  skip: process.platform === 'win32',
}, () => {
  const sessionsDir = join(dataDir, 'sessions');
  const displacedDir = join(temporaryRoot, 'write-displaced-before-stage');
  let originalRoot;
  let replaced = false;
  const store = createStateStore(dataDir, {
    now() {
      originalRoot = lstatSync(sessionsDir);
      fs.renameSync(sessionsDir, displacedDir);
      fs.mkdirSync(sessionsDir, { mode: 0o700 });
      replaced = true;
      return fixedNow();
    },
  });

  const outcome = store.write('write-root-race', 'wenyan-full');

  assert.equal(replaced, true);
  const replacementRoot = lstatSync(sessionsDir);
  assert.notEqual(replacementRoot.ino, originalRoot.ino);
  assert.equal(outcome, false);
  assert.deepEqual(readdirSync(sessionsDir), []);
  assert.deepEqual(readdirSync(displacedDir), []);
});

test('write rejects sessions-root replacement after stable stage reread', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'write-root-race-after-stage-reread';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const displacedDir = join(temporaryRoot, 'write-root-after-stage-reread');
  const canonicalPath = canonicalStatePath(sessionId);
  const fileName = basename(canonicalPath);
  const originalRoot = lstatSync(sessionsDir);
  const originalContents = readFileSync(canonicalPath);
  const originalStat = statSync(canonicalPath);
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let stagePath;
  let stageOpens = 0;
  let rereadFd;
  let replaced = false;

  fs.openSync = function captureStableResetStageReread(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (candidate.includes('.reset-v1.') && candidate.endsWith('.tmp')) {
      stagePath = candidate;
      stageOpens += 1;
      if (stageOpens === 2) rereadFd = fd;
    }
    return fd;
  };
  fs.closeSync = function replaceRootAfterStableStageReread(fd, ...args) {
    const result = originalClose(fd, ...args);
    if (fd === rereadFd && !replaced) {
      replaced = true;
      const stageName = basename(stagePath);
      fs.renameSync(sessionsDir, displacedDir);
      fs.mkdirSync(sessionsDir, { mode: 0o700 });
      fs.renameSync(join(displacedDir, fileName), canonicalPath);
      fs.renameSync(join(displacedDir, stageName), join(sessionsDir, stageName));
    }
    return result;
  };
  let outcome;
  try {
    outcome = store.write(sessionId, 'full');
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
  }

  assert.equal(stageOpens, 2);
  assert.equal(replaced, true);
  const replacementRoot = lstatSync(sessionsDir);
  assert.notEqual(replacementRoot.ino, originalRoot.ino);
  assert.equal(outcome, false);
  assert.deepEqual(readFileSync(canonicalPath), originalContents);
  const finalCanonicalStat = statSync(canonicalPath);
  assert.equal(finalCanonicalStat.dev, originalStat.dev);
  assert.equal(finalCanonicalStat.ino, originalStat.ino);
});

test('write rejects canonical destination replacement before rename', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'write-destination-race';
  assert.equal(store.write(sessionId, 'off'), true);
  const filePath = canonicalStatePath(sessionId);
  const displacedPath = join(temporaryRoot, 'write-displaced-record.json');
  const oldContents = readFileSync(filePath);
  const oldStat = statSync(filePath);
  const concurrentContents = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    mode: 'ultra',
    updatedAt: fixedNow().toISOString(),
  })}\n`);
  const originalOpen = fs.openSync;
  let replaced = false;
  let concurrentStat;

  fs.openSync = function replaceDestinationAfterStageOpen(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (candidate.endsWith('.tmp') && !replaced) {
      replaced = true;
      fs.renameSync(filePath, displacedPath);
      writeFileSync(filePath, concurrentContents, { mode: 0o600 });
      fs.chmodSync(filePath, 0o600);
      concurrentStat = statSync(filePath);
    }
    return fd;
  };
  let outcome;
  try {
    outcome = store.write(sessionId, 'full');
  } finally {
    fs.openSync = originalOpen;
  }

  assert.equal(replaced, true);
  assert.equal(outcome, false);
  assert.deepEqual(readFileSync(filePath), concurrentContents);
  const finalConcurrentStat = statSync(filePath);
  assert.equal(finalConcurrentStat.dev, concurrentStat.dev);
  assert.equal(finalConcurrentStat.ino, concurrentStat.ino);
  assert.deepEqual(readFileSync(displacedPath), oldContents);
  const finalOldStat = statSync(displacedPath);
  assert.equal(finalOldStat.dev, oldStat.dev);
  assert.equal(finalOldStat.ino, oldStat.ino);
  assertOnlyStateFile(sessionId);
});

test('write cleanup never deletes a foreign inode swapped into its stage', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'write-cleanup-foreign-stage';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const displacedPath = join(temporaryRoot, 'write-cleanup-displaced.json');
  const concurrentContents = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    mode: 'ultra',
    updatedAt: fixedNow().toISOString(),
  })}\n`);
  const foreignContents = Buffer.from('foreign reset-stage evidence\n');
  const originalOpen = fs.openSync;
  const originalLstat = fs.lstatSync;
  const originalUnlink = fs.unlinkSync;
  let stagePath;
  let destinationReplaced = false;
  let stageLstats = 0;
  let stageSwapped = false;
  let concurrentStat;
  let foreignStat;

  fs.openSync = function replaceDestinationAfterStageOpen(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (candidate.endsWith('.tmp') && !destinationReplaced) {
      stagePath = candidate;
      destinationReplaced = true;
      fs.renameSync(canonicalPath, displacedPath);
      writeFileSync(canonicalPath, concurrentContents, { mode: 0o600 });
      fs.chmodSync(canonicalPath, 0o600);
      concurrentStat = statSync(canonicalPath);
    }
    return fd;
  };
  fs.lstatSync = function swapStageAfterCleanupCheck(candidate, ...args) {
    const sampled = originalLstat(candidate, ...args);
    if (candidate === stagePath) {
      stageLstats += 1;
      if (stageLstats === 1 && !stageSwapped) {
        stageSwapped = true;
        originalUnlink(stagePath);
        writeFileSync(stagePath, foreignContents, { mode: 0o600 });
        fs.chmodSync(stagePath, 0o600);
        foreignStat = originalLstat(stagePath);
      }
    }
    return sampled;
  };
  let outcome;
  try {
    outcome = store.write(sessionId, 'full');
  } finally {
    fs.openSync = originalOpen;
    fs.lstatSync = originalLstat;
  }

  assert.ok(stagePath);
  assert.equal(destinationReplaced, true);
  assert.equal(stageSwapped, true);
  assert.equal(outcome, false);
  assert.deepEqual(readFileSync(canonicalPath), concurrentContents);
  const finalCanonicalStat = statSync(canonicalPath);
  assert.equal(finalCanonicalStat.dev, concurrentStat.dev);
  assert.equal(finalCanonicalStat.ino, concurrentStat.ino);
  const survivors = [];
  for (const name of readdirSync(sessionsDir)) {
    const candidate = join(sessionsDir, name);
    const candidateStat = lstatSync(candidate);
    if (candidateStat.isDirectory()) {
      for (const child of readdirSync(candidate)) {
        const childPath = join(candidate, child);
        const childStat = statSync(childPath);
        if (
          childStat.dev === foreignStat.dev &&
          childStat.ino === foreignStat.ino
        ) survivors.push(childPath);
      }
    } else if (
      candidateStat.dev === foreignStat.dev &&
      candidateStat.ino === foreignStat.ino
    ) {
      survivors.push(candidate);
    }
  }
  assert.equal(survivors.length, 1);
  assert.deepEqual(readFileSync(survivors[0]), foreignContents);
});

test('write reports failure when closing its durable stage fails', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'write-stage-close-failure';
  assert.equal(store.write(sessionId, 'off'), true);
  const canonicalPath = canonicalStatePath(sessionId);
  const originalContents = readFileSync(canonicalPath);
  const originalStat = statSync(canonicalPath);
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let stageFd;
  let failed = false;

  fs.openSync = function captureResetStage(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (candidate.includes('.reset-v1.') && candidate.endsWith('.tmp')) {
      stageFd = fd;
    }
    return fd;
  };
  fs.closeSync = function failResetStageClose(fd, ...args) {
    const result = originalClose(fd, ...args);
    if (fd === stageFd && !failed) {
      failed = true;
      throw simulatedIoError('simulated reset stage close failure');
    }
    return result;
  };
  let outcome;
  try {
    outcome = store.write(sessionId, 'full');
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
  }

  assert.equal(failed, true);
  assert.equal(outcome, false);
  assert.deepEqual(readFileSync(canonicalPath), originalContents);
  const finalStat = statSync(canonicalPath);
  assert.equal(finalStat.dev, originalStat.dev);
  assert.equal(finalStat.ino, originalStat.ino);
  assertOnlyStateFile(sessionId);
});

test('write preserves partial stage evidence when descriptor writing fails', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'write-stage-partial-write';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const originalContents = readFileSync(canonicalPath);
  const originalStat = statSync(canonicalPath);
  const originalOpen = fs.openSync;
  const originalWrite = fs.writeFileSync;
  let stageFd;
  let partialStat;
  let failed = false;

  fs.openSync = function captureResetStage(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (candidate.includes('.reset-v1.') && candidate.endsWith('.tmp')) {
      stageFd = fd;
    }
    return fd;
  };
  fs.writeFileSync = function failResetStageWrite(target, ...args) {
    if (target === stageFd && !failed) {
      failed = true;
      originalWrite(target, '{', 'utf8');
      partialStat = fs.fstatSync(target);
      throw simulatedIoError('simulated reset stage write failure');
    }
    return originalWrite(target, ...args);
  };
  let outcome;
  try {
    outcome = store.write(sessionId, 'full');
  } finally {
    fs.openSync = originalOpen;
    fs.writeFileSync = originalWrite;
  }

  assert.equal(failed, true);
  assert.equal(outcome, false);
  assert.deepEqual(readFileSync(canonicalPath), originalContents);
  const finalCanonicalStat = statSync(canonicalPath);
  assert.equal(finalCanonicalStat.dev, originalStat.dev);
  assert.equal(finalCanonicalStat.ino, originalStat.ino);
  const quarantineNames = readdirSync(sessionsDir).filter((name) => (
    name.includes('.q.reset-stage.')
  ));
  assert.equal(quarantineNames.length, 1);
  const quarantinePath = join(sessionsDir, quarantineNames[0]);
  const quarantineStat = lstatSync(quarantinePath);
  assert.equal(quarantineStat.isDirectory(), true);
  assert.equal(quarantineStat.mode & 0o777, 0o700);
  if (typeof process.getuid === 'function') {
    assert.equal(quarantineStat.uid, process.getuid());
  }
  assert.deepEqual(readdirSync(quarantinePath), ['entry']);
  const entryPath = join(quarantinePath, 'entry');
  assert.equal(readFileSync(entryPath, 'utf8'), '{');
  const entryStat = statSync(entryPath);
  assert.equal(entryStat.dev, partialStat.dev);
  assert.equal(entryStat.ino, partialStat.ino);
});

test('write rejects identical stage bytes rewritten after file fsync', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'write-identical-stage-rewrite';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const originalContents = readFileSync(canonicalPath);
  const originalStat = statSync(canonicalPath);
  const intendedContents = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    mode: 'full',
    updatedAt: fixedNow().toISOString(),
  })}\n`);
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let stagePath;
  let stageFd;
  let rewritten = false;
  let rewrittenStat;

  fs.openSync = function captureResetStage(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (candidate.includes('.reset-v1.') && candidate.endsWith('.tmp')) {
      stagePath = candidate;
      stageFd = fd;
    }
    return fd;
  };
  fs.closeSync = function rewriteResetStageAfterClose(fd, ...args) {
    const result = originalClose(fd, ...args);
    if (fd === stageFd && !rewritten) {
      rewritten = true;
      writeFileSync(stagePath, intendedContents, { mode: 0o600 });
      fs.chmodSync(stagePath, 0o600);
      rewrittenStat = statSync(stagePath);
    }
    return result;
  };
  let outcome;
  try {
    outcome = store.write(sessionId, 'full');
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
  }

  assert.equal(rewritten, true);
  assert.equal(outcome, false);
  assert.deepEqual(readFileSync(canonicalPath), originalContents);
  const finalCanonicalStat = statSync(canonicalPath);
  assert.equal(finalCanonicalStat.dev, originalStat.dev);
  assert.equal(finalCanonicalStat.ino, originalStat.ino);
  const survivors = [];
  for (const name of readdirSync(sessionsDir)) {
    const candidate = join(sessionsDir, name);
    const candidateStat = lstatSync(candidate);
    if (candidateStat.isDirectory()) {
      for (const child of readdirSync(candidate)) {
        const childPath = join(candidate, child);
        const childStat = statSync(childPath);
        if (
          childStat.dev === rewrittenStat.dev &&
          childStat.ino === rewrittenStat.ino
        ) survivors.push(childPath);
      }
    } else if (
      candidateStat.dev === rewrittenStat.dev &&
      candidateStat.ino === rewrittenStat.ino
    ) {
      survivors.push(candidate);
    }
  }
  assert.equal(survivors.length, 1);
  assert.deepEqual(readFileSync(survivors[0]), intendedContents);
});

test('write reports failure when opening its parent after rename fails', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'write-parent-open-failure';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const originalOpen = fs.openSync;
  let stageOpened = false;
  let failed = false;

  fs.openSync = function failWriteParentOpen(candidate, ...args) {
    if (candidate === sessionsDir && stageOpened && !failed) {
      failed = true;
      throw simulatedIoError('simulated write parent open failure');
    }
    const fd = originalOpen(candidate, ...args);
    if (candidate.includes('.reset-v1.') && candidate.endsWith('.tmp')) {
      stageOpened = true;
    }
    return fd;
  };
  let outcome;
  try {
    outcome = store.write(sessionId, 'full');
  } finally {
    fs.openSync = originalOpen;
  }

  assert.equal(failed, true);
  assert.equal(outcome, false);
  assert.deepEqual(store.read(sessionId), found('full'));
  assert.deepEqual(JSON.parse(readFileSync(canonicalPath, 'utf8')), {
    schemaVersion: 1,
    mode: 'full',
    updatedAt: fixedNow().toISOString(),
  });
  assertOnlyStateFile(sessionId);
});

test('write reports failure when its parent fsync fails after rename', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'write-parent-fsync-failure';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const originalOpen = fs.openSync;
  const originalFsync = fs.fsyncSync;
  let directoryFd;
  let failed = false;

  fs.openSync = function captureWriteParent(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (candidate === sessionsDir && directoryFd === undefined) {
      directoryFd = fd;
    }
    return fd;
  };
  fs.fsyncSync = function failWriteParentFsync(fd, ...args) {
    if (fd === directoryFd && !failed) {
      failed = true;
      throw simulatedIoError('simulated write parent fsync failure');
    }
    return originalFsync(fd, ...args);
  };
  let outcome;
  try {
    outcome = store.write(sessionId, 'full');
  } finally {
    fs.openSync = originalOpen;
    fs.fsyncSync = originalFsync;
  }

  assert.equal(failed, true);
  assert.equal(outcome, false);
  assert.deepEqual(store.read(sessionId), found('full'));
  assert.deepEqual(JSON.parse(readFileSync(canonicalPath, 'utf8')), {
    schemaVersion: 1,
    mode: 'full',
    updatedAt: fixedNow().toISOString(),
  });
  assertOnlyStateFile(sessionId);
});

test('write reports failure when closing its fsynced parent fails', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'write-parent-close-failure';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let stageOpened = false;
  let parentFd;
  let failed = false;

  fs.openSync = function captureWriteParent(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (candidate.includes('.reset-v1.') && candidate.endsWith('.tmp')) {
      stageOpened = true;
    } else if (
      candidate === sessionsDir &&
      stageOpened &&
      parentFd === undefined
    ) {
      parentFd = fd;
    }
    return fd;
  };
  fs.closeSync = function failWriteParentClose(fd, ...args) {
    const result = originalClose(fd, ...args);
    if (fd === parentFd && !failed) {
      failed = true;
      throw simulatedIoError('simulated write parent close failure');
    }
    return result;
  };
  let outcome;
  try {
    outcome = store.write(sessionId, 'full');
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
  }

  assert.equal(failed, true);
  assert.equal(outcome, false);
  assert.deepEqual(store.read(sessionId), found('full'));
  assert.deepEqual(JSON.parse(readFileSync(canonicalPath, 'utf8')), {
    schemaVersion: 1,
    mode: 'full',
    updatedAt: fixedNow().toISOString(),
  });
  assertOnlyStateFile(sessionId);
});

test('write reports failure when reopening its parent after fsync fails', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'write-parent-reopen-failure';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const originalOpen = fs.openSync;
  let stageOpened = false;
  let parentOpens = 0;
  let failed = false;

  fs.openSync = function failWriteParentReopen(candidate, ...args) {
    if (candidate === sessionsDir && stageOpened) {
      parentOpens += 1;
      if (parentOpens === 2 && !failed) {
        failed = true;
        throw simulatedIoError('simulated write parent reopen failure');
      }
    }
    const fd = originalOpen(candidate, ...args);
    if (candidate.includes('.reset-v1.') && candidate.endsWith('.tmp')) {
      stageOpened = true;
    }
    return fd;
  };
  let outcome;
  try {
    outcome = store.write(sessionId, 'full');
  } finally {
    fs.openSync = originalOpen;
  }

  assert.equal(parentOpens, 2);
  assert.equal(failed, true);
  assert.equal(outcome, false);
  assert.deepEqual(store.read(sessionId), found('full'));
  assert.deepEqual(JSON.parse(readFileSync(canonicalPath, 'utf8')), {
    schemaVersion: 1,
    mode: 'full',
    updatedAt: fixedNow().toISOString(),
  });
  assertOnlyStateFile(sessionId);
});

test('write reports failure when closing its reopened parent fails', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'write-parent-reopened-close-failure';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let stageOpened = false;
  let parentOpens = 0;
  let reopenedParentFd;
  let failed = false;

  fs.openSync = function captureReopenedWriteParent(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (candidate.includes('.reset-v1.') && candidate.endsWith('.tmp')) {
      stageOpened = true;
    } else if (candidate === sessionsDir && stageOpened) {
      parentOpens += 1;
      if (parentOpens === 2) reopenedParentFd = fd;
    }
    return fd;
  };
  fs.closeSync = function failReopenedWriteParentClose(fd, ...args) {
    const result = originalClose(fd, ...args);
    if (fd === reopenedParentFd && !failed) {
      failed = true;
      throw simulatedIoError('simulated reopened parent close failure');
    }
    return result;
  };
  let outcome;
  try {
    outcome = store.write(sessionId, 'full');
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
  }

  assert.equal(parentOpens, 2);
  assert.equal(failed, true);
  assert.equal(outcome, false);
  assert.deepEqual(store.read(sessionId), found('full'));
  assert.deepEqual(JSON.parse(readFileSync(canonicalPath, 'utf8')), {
    schemaVersion: 1,
    mode: 'full',
    updatedAt: fixedNow().toISOString(),
  });
  assertOnlyStateFile(sessionId);
});

test('write rejects a valid replacement published after its parent barrier', {
  skip: process.platform === 'win32',
}, () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionId = 'write-replaced-after-parent-barrier';
  assert.equal(store.write(sessionId, 'off'), true);
  const sessionsDir = join(realpathSync(dataDir), 'sessions');
  const canonicalPath = canonicalStatePath(sessionId);
  const replacementPath = join(temporaryRoot, 'write-after-barrier-replacement.json');
  const replacementContents = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    mode: 'ultra',
    updatedAt: fixedNow().toISOString(),
  })}\n`);
  writeFileSync(replacementPath, replacementContents, { mode: 0o600 });
  fs.chmodSync(replacementPath, 0o600);
  const replacementStat = statSync(replacementPath);
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let directoryOpens = 0;
  let barrierReopenFd;
  let replaced = false;

  fs.openSync = function captureWriteBarrierReopen(candidate, ...args) {
    const fd = originalOpen(candidate, ...args);
    if (candidate === sessionsDir) {
      directoryOpens += 1;
      if (directoryOpens === 2) barrierReopenFd = fd;
    }
    return fd;
  };
  fs.closeSync = function replaceWriteAfterBarrier(fd, ...args) {
    const result = originalClose(fd, ...args);
    if (fd === barrierReopenFd && !replaced) {
      replaced = true;
      fs.renameSync(replacementPath, canonicalPath);
    }
    return result;
  };
  let outcome;
  try {
    outcome = store.write(sessionId, 'full');
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
  }

  assert.equal(replaced, true);
  assert.equal(outcome, false);
  assert.deepEqual(store.read(sessionId), found('ultra'));
  assert.deepEqual(readFileSync(canonicalPath), replacementContents);
  const finalStat = statSync(canonicalPath);
  assert.equal(finalStat.dev, replacementStat.dev);
  assert.equal(finalStat.ino, replacementStat.ino);
  assertOnlyStateFile(sessionId);
});

test('rejects unknown modes and symbolic-link state files', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  assert.equal(store.write('session-a', 'commit'), false);

  const filePath = statePath('session-a');
  mkdirSync(dirname(filePath), { recursive: true });
  symlinkSync(externalFile, filePath);
  const externalContents = readFileSync(externalFile, 'utf8');

  assert.deepEqual(store.read('session-a'), unavailable());
  assert.deepEqual(
    store.initializeIfMissing('session-a', 'wenyan-full'),
    unavailable(),
  );
  assert.equal(store.write('session-a', 'lite'), false);
  assert.equal(readFileSync(externalFile, 'utf8'), externalContents);
  assert.equal(lstatSync(filePath).isSymbolicLink(), true);

  const danglingPath = statePath('dangling');
  symlinkSync(join(temporaryRoot, 'missing-target'), danglingPath);
  assert.deepEqual(store.read('dangling'), unavailable());
  assert.deepEqual(
    store.initializeIfMissing('dangling', 'wenyan-full'),
    unavailable(),
  );
  assert.equal(store.write('dangling', 'lite'), false);
  assert.equal(lstatSync(danglingPath).isSymbolicLink(), true);
});

test('rejects nonregular state records', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const filePath = statePath('directory-state');
  mkdirSync(filePath, { recursive: true });

  assert.deepEqual(store.read('directory-state'), unavailable());
  assert.deepEqual(
    store.initializeIfMissing('directory-state', 'wenyan-full'),
    unavailable(),
  );
  assert.equal(store.write('directory-state', 'lite'), false);
  assert.equal(lstatSync(filePath).isDirectory(), true);
});

test('refuses a symbolic-link sessions directory', () => {
  mkdirSync(dataDir);
  symlinkSync(externalDir, join(dataDir, 'sessions'));
  const store = createStateStore(dataDir, { now: fixedNow });

  assert.deepEqual(store.read('session-a'), unavailable());
  assert.deepEqual(
    store.initializeIfMissing('session-a', 'wenyan-full'),
    unavailable(),
  );
  assert.equal(store.write('session-a', 'lite'), false);
  assert.deepEqual(readdirSync(externalDir), []);
});

test('refuses a symbolic-link data directory', () => {
  symlinkSync(externalDir, dataDir);
  const store = createStateStore(dataDir, { now: fixedNow });

  assert.deepEqual(store.read('session-a'), unavailable());
  assert.deepEqual(
    store.initializeIfMissing('session-a', 'wenyan-full'),
    unavailable(),
  );
  assert.equal(store.write('session-a', 'lite'), false);
  assert.deepEqual(readdirSync(externalDir), []);
});

test('refuses a sessions directory replaced by a symbolic link', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  const sessionsDir = join(dataDir, 'sessions');
  rmSync(sessionsDir, { recursive: true });
  symlinkSync(externalDir, sessionsDir);

  assert.deepEqual(store.read('session-a'), unavailable());
  assert.deepEqual(
    store.initializeIfMissing('session-a', 'wenyan-full'),
    unavailable(),
  );
  assert.equal(store.write('session-a', 'lite'), false);
  assert.deepEqual(readdirSync(externalDir), []);
});

test('rejects oversized, noncanonical, and malformed state records', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  mkdirSync(join(dataDir, 'sessions'), { recursive: true });

  writeFileSync(statePath('oversized'), 'x'.repeat(MAX_STATE_BYTES + 1));
  writeFileSync(statePath('bad-json'), '{"schemaVersion":');
  writeStateFile('noncanonical', {
    schemaVersion: 1,
    mode: 'wenyan',
    updatedAt: fixedNow().toISOString(),
  });
  writeStateFile('bad-schema', {
    schemaVersion: 2,
    mode: 'lite',
    updatedAt: fixedNow().toISOString(),
  });
  writeStateFile('bad-date', {
    schemaVersion: 1,
    mode: 'lite',
    updatedAt: 'July 11, 2026',
  });

  for (const sessionId of [
    'oversized',
    'bad-json',
    'noncanonical',
    'bad-schema',
    'bad-date',
  ]) {
    const before = readFileSync(statePath(sessionId));
    assert.deepEqual(store.read(sessionId), unavailable());
    assert.deepEqual(
      store.initializeIfMissing(sessionId, 'wenyan-full'),
      unavailable(),
    );
    assert.deepEqual(readFileSync(statePath(sessionId)), before);
  }
});

test('write file-fsync failure preserves old state and cleans its stage', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  assert.equal(store.write('session-a', 'lite'), true);

  const originalFsync = fs.fsyncSync;
  let failFsync = true;
  fs.fsyncSync = function failingFsync(...args) {
    if (failFsync) {
      failFsync = false;
      throw simulatedIoError('simulated fsync failure');
    }
    return originalFsync(...args);
  };
  try {
    assert.equal(store.write('session-a', 'full'), false);
  } finally {
    fs.fsyncSync = originalFsync;
  }
  assert.deepEqual(store.read('session-a'), found('lite'));
  assertOnlyStateFile('session-a');
});

test('write rename failure preserves old state and cleans its stage', () => {
  const store = createStateStore(dataDir, { now: fixedNow });
  assert.equal(store.write('session-a', 'lite'), true);
  const filePath = canonicalStatePath('session-a');

  const originalRename = fs.renameSync;
  fs.renameSync = function failingRename(source, destination) {
    if (destination === filePath) {
      throw simulatedIoError('simulated rename failure');
    }
    return originalRename(source, destination);
  };
  try {
    assert.equal(store.write('session-a', 'full'), false);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.deepEqual(store.read('session-a'), found('lite'));
  assertOnlyStateFile('session-a');
});

test('fails open when the root or injected clock is unusable', () => {
  const nonDirectory = join(temporaryRoot, 'not-a-directory');
  writeFileSync(nonDirectory, 'blocked');
  const blockedStore = createStateStore(nonDirectory, { now: fixedNow });
  assert.deepEqual(blockedStore.read('session-a'), unavailable());
  assert.equal(blockedStore.write('session-a', 'lite'), false);

  const throwingClockStore = createStateStore(dataDir, {
    now() {
      throw new Error('clock unavailable');
    },
  });
  assert.equal(throwingClockStore.write('session-a', 'lite'), false);
});
