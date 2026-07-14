'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { canonicalizeMode } = require('./modes.cjs');

const SCHEMA_VERSION = 1;
const MAX_STATE_BYTES = 1024;
const RECORD_VALID = 'valid';
const RECORD_MISSING = 'missing';
const RECORD_MALFORMED = 'malformed';
const RECORD_ERROR = 'error';
const RECORD_LINK_MISMATCH = 'link-mismatch';

function stateKey(sessionId) {
  if (
    typeof sessionId !== 'string' ||
    sessionId.length === 0 ||
    sessionId.length > 4096
  ) return null;
  return crypto.createHash('sha256').update(sessionId).digest('hex');
}

function rootIsSafe(root) {
  try {
    if (!root || path.dirname(root.sessionsRoot) !== root.dataRoot) return false;
    const dataStat = fs.lstatSync(root.dataRoot);
    if (!dataStat.isDirectory() || dataStat.isSymbolicLink()) return false;
    if (fs.realpathSync(root.dataRoot) !== root.dataRoot) return false;
    const sessionsStat = fs.lstatSync(root.sessionsRoot);
    if (!sessionsStat.isDirectory() || sessionsStat.isSymbolicLink()) return false;
    return fs.realpathSync(root.sessionsRoot) === root.sessionsRoot;
  } catch {
    return false;
  }
}

function prepareRoot(dataDir) {
  try {
    if (!dataDir) return null;
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    }
    const dataStat = fs.lstatSync(dataDir);
    if (!dataStat.isDirectory() || dataStat.isSymbolicLink()) return null;
    const dataRoot = fs.realpathSync(dataDir);
    const sessions = path.join(dataRoot, 'sessions');
    if (!fs.existsSync(sessions)) {
      fs.mkdirSync(sessions, { mode: 0o700 });
    }
    const sessionsStat = fs.lstatSync(sessions);
    if (!sessionsStat.isDirectory() || sessionsStat.isSymbolicLink()) return null;
    const sessionsRoot = fs.realpathSync(sessions);
    const root = {
      dataRoot,
      sessionsRoot,
      dataIdentity: { dev: dataStat.dev, ino: dataStat.ino },
      sessionsIdentity: { dev: sessionsStat.dev, ino: sessionsStat.ino },
    };
    if (!rootIsSafe(root) || !rootIdentityIsStable(root)) return null;
    if (
      (
        !syncSessionsDirectory(root) ||
        !syncDataDirectory(root)
      )
    ) return null;
    return root;
  } catch {
    return null;
  }
}

function statePath(root, sessionId) {
  const key = stateKey(sessionId);
  if (!root || !key) return null;
  const candidate = path.join(root.sessionsRoot, `${key}.json`);
  return path.dirname(candidate) === root.sessionsRoot ? candidate : null;
}

function sameFile(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

function sameStableRecordStat(first, second) {
  return (
    sameFile(first, second) &&
    first.size === second.size &&
    first.mode === second.mode &&
    first.uid === second.uid &&
    first.gid === second.gid &&
    first.nlink === second.nlink &&
    first.ctimeMs === second.ctimeMs &&
    first.mtimeMs === second.mtimeMs
  );
}

function sameRecordBytes(first, second) {
  return (
    Buffer.isBuffer(first.bytes) &&
    Buffer.isBuffer(second.bytes) &&
    first.bytes.equals(second.bytes)
  );
}

function rootIdentityIsStable(root) {
  try {
    if (!root || !root.dataIdentity || !root.sessionsIdentity) return false;
    const dataStat = fs.lstatSync(root.dataRoot);
    const sessionsStat = fs.lstatSync(root.sessionsRoot);
    return (
      dataStat.isDirectory() &&
      !dataStat.isSymbolicLink() &&
      sameFile(dataStat, root.dataIdentity) &&
      sessionsStat.isDirectory() &&
      !sessionsStat.isSymbolicLink() &&
      sameFile(sessionsStat, root.sessionsIdentity)
    );
  } catch {
    return false;
  }
}

function stableRootIsProven(root) {
  try {
    if (
      !root ||
      !root.dataIdentity ||
      !root.sessionsIdentity ||
      path.dirname(root.sessionsRoot) !== root.dataRoot
    ) return null;
    const dataStat = fs.lstatSync(root.dataRoot);
    const sessionsStat = fs.lstatSync(root.sessionsRoot);
    if (
      !dataStat.isDirectory() ||
      dataStat.isSymbolicLink() ||
      !sameFile(dataStat, root.dataIdentity) ||
      fs.realpathSync(root.dataRoot) !== root.dataRoot ||
      !sessionsStat.isDirectory() ||
      sessionsStat.isSymbolicLink() ||
      !sameFile(sessionsStat, root.sessionsIdentity) ||
      fs.realpathSync(root.sessionsRoot) !== root.sessionsRoot
    ) return null;
    return true;
  } catch {
    return null;
  }
}

function recordError() {
  return { kind: RECORD_ERROR };
}

function missingRecord() {
  return { kind: RECORD_MISSING };
}

function malformedRecord(stat) {
  return { kind: RECORD_MALFORMED, stat };
}

function readRecord(filePath, expectedLinks = 1, observeLinkMismatch) {
  if (expectedLinks !== 1 && expectedLinks !== 2) return recordError();
  let fd;
  let closeFailed = false;
  let opened;
  let raw;
  let bytes;
  let beforeOpen;
  let linkMismatch;
  try {
    beforeOpen = fs.lstatSync(filePath);
  } catch (error) {
    return error && error.code === 'ENOENT' ? missingRecord() : recordError();
  }

  try {
    if (
      !beforeOpen.isFile() ||
      beforeOpen.isSymbolicLink()
    ) return recordError();

    const noFollow = fs.constants.O_NOFOLLOW || 0;
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    opened = fs.fstatSync(fd);
    if (
      !opened.isFile() ||
      !sameFile(beforeOpen, opened) ||
      (opened.mode & 0o7777) !== 0o600 ||
      typeof process.getuid !== 'function' ||
      opened.uid !== process.getuid()
    ) return recordError();
    if (opened.nlink !== expectedLinks) {
      if (
        expectedLinks === 1 &&
        opened.nlink === 2 &&
        typeof observeLinkMismatch === 'function'
      ) {
        let hadRecoverableAlias;
        try {
          hadRecoverableAlias = observeLinkMismatch(opened);
        } catch {
          return recordError();
        }
        if (typeof hadRecoverableAlias !== 'boolean') return recordError();
        linkMismatch = {
          kind: RECORD_LINK_MISMATCH,
          hadRecoverableAlias,
        };
        throw linkMismatch;
      }
      return recordError();
    }
    if (opened.size > MAX_STATE_BYTES) return malformedRecord(opened);

    const buffer = Buffer.allocUnsafe(MAX_STATE_BYTES + 1);
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
      length !== opened.size ||
      !sameStableRecordStat(opened, afterRead)
    ) return recordError();
    const afterPath = fs.lstatSync(filePath);
    if (
      !afterPath.isFile() ||
      afterPath.isSymbolicLink() ||
      !sameStableRecordStat(afterRead, afterPath)
    ) return recordError();
    opened = afterRead;
    if (length > MAX_STATE_BYTES) return malformedRecord(opened);
    bytes = Buffer.from(buffer.subarray(0, length));
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    if (error !== linkMismatch) return recordError();
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { closeFailed = true; }
    }
  }

  if (closeFailed) return recordError();
  if (linkMismatch) return linkMismatch;

  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return malformedRecord(opened);
  }
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return malformedRecord(opened);
    }
    const mode = canonicalizeMode(value.mode);
    if (typeof value.updatedAt !== 'string') return malformedRecord(opened);
    const updatedAt = new Date(value.updatedAt);
    if (
      value.schemaVersion !== SCHEMA_VERSION ||
      !mode ||
      mode !== value.mode ||
      Number.isNaN(updatedAt.getTime()) ||
      updatedAt.toISOString() !== value.updatedAt
    ) return malformedRecord(opened);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    return {
      kind: RECORD_VALID,
      mode,
      updatedAt,
      stat: opened,
      bytes,
      digest,
    };
  } catch {
    return malformedRecord(opened);
  }
}

function normalizeDate(value) {
  try {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    date.toISOString();
    return date;
  } catch {
    return null;
  }
}

function inspectDestination(filePath) {
  try {
    const destination = fs.lstatSync(filePath);
    if (!destination.isFile() || destination.isSymbolicLink()) return null;
    return { kind: 'present', stat: destination };
  } catch (error) {
    return error && error.code === 'ENOENT' ? { kind: 'missing' } : null;
  }
}

function destinationIsStable(filePath, expected) {
  const current = inspectDestination(filePath);
  if (!current || !expected || current.kind !== expected.kind) return false;
  return current.kind === 'missing' || sameFile(current.stat, expected.stat);
}

function fsyncDirectory(root) {
  let fd;
  try {
    if (!rootIsSafe(root)) return;
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const directory = fs.constants.O_DIRECTORY || 0;
    fd = fs.openSync(root.sessionsRoot, fs.constants.O_RDONLY | noFollow | directory);
    fs.fsyncSync(fd);
  } catch {
    // Directory fsync is unavailable on some hosts.
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function syncSessionsDirectory(root) {
  let fd;
  try {
    if (!rootIsSafe(root) || !rootIdentityIsStable(root)) return false;
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const directory = fs.constants.O_DIRECTORY || 0;
    fd = fs.openSync(
      root.sessionsRoot,
      fs.constants.O_RDONLY | noFollow | directory,
    );
    const opened = fs.fstatSync(fd);
    if (
      !opened.isDirectory() ||
      !sameFile(opened, root.sessionsIdentity)
    ) return false;
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    if (!rootIsSafe(root) || !rootIdentityIsStable(root)) return false;
    fd = fs.openSync(
      root.sessionsRoot,
      fs.constants.O_RDONLY | noFollow | directory,
    );
    const reopened = fs.fstatSync(fd);
    if (
      !reopened.isDirectory() ||
      !sameFile(opened, reopened) ||
      !sameFile(reopened, root.sessionsIdentity)
    ) return false;
    fs.closeSync(fd);
    fd = undefined;
    return rootIsSafe(root) && rootIdentityIsStable(root);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort after failure */ }
    }
  }
}

function syncDataDirectory(root) {
  let fd;
  try {
    if (!rootIsSafe(root) || !rootIdentityIsStable(root)) return false;
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const directory = fs.constants.O_DIRECTORY || 0;
    const flags = fs.constants.O_RDONLY | noFollow | directory;
    fd = fs.openSync(root.dataRoot, flags);
    const opened = fs.fstatSync(fd);
    if (
      !opened.isDirectory() ||
      !sameFile(opened, root.dataIdentity)
    ) return false;
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    if (!rootIsSafe(root) || !rootIdentityIsStable(root)) return false;
    fd = fs.openSync(root.dataRoot, flags);
    const reopened = fs.fstatSync(fd);
    if (
      !reopened.isDirectory() ||
      !sameFile(opened, reopened) ||
      !sameFile(reopened, root.dataIdentity)
    ) return false;
    fs.closeSync(fd);
    fd = undefined;
    return rootIsSafe(root) && rootIdentityIsStable(root);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort after failure */ }
    }
  }
}

function initializationPairIsSafe(root, stagePath, finalPath, identity) {
  let stageFd;
  let finalFd;
  try {
    if (
      !identity ||
      path.dirname(stagePath) !== root.sessionsRoot ||
      path.dirname(finalPath) !== root.sessionsRoot ||
      !rootIsSafe(root) ||
      !rootIdentityIsStable(root)
    ) return false;

    const stageBefore = fs.lstatSync(stagePath);
    const finalBefore = fs.lstatSync(finalPath);
    if (
      !stageBefore.isFile() ||
      stageBefore.isSymbolicLink() ||
      !finalBefore.isFile() ||
      finalBefore.isSymbolicLink() ||
      !sameFile(stageBefore, identity) ||
      !sameFile(stageBefore, finalBefore) ||
      stageBefore.size !== finalBefore.size ||
      stageBefore.mode !== finalBefore.mode ||
      (stageBefore.mode & 0o7777) !== 0o600 ||
      typeof process.getuid !== 'function' ||
      stageBefore.uid !== process.getuid() ||
      stageBefore.uid !== finalBefore.uid ||
      stageBefore.gid !== finalBefore.gid ||
      stageBefore.nlink !== 2 ||
      finalBefore.nlink !== 2 ||
      stageBefore.ctimeMs !== finalBefore.ctimeMs ||
      stageBefore.mtimeMs !== finalBefore.mtimeMs
    ) return false;

    const noFollow = fs.constants.O_NOFOLLOW || 0;
    stageFd = fs.openSync(stagePath, fs.constants.O_RDONLY | noFollow);
    finalFd = fs.openSync(finalPath, fs.constants.O_RDONLY | noFollow);
    const stageOpened = fs.fstatSync(stageFd);
    const finalOpened = fs.fstatSync(finalFd);
    if (
      !stageOpened.isFile() ||
      !finalOpened.isFile() ||
      !sameFile(stageBefore, stageOpened) ||
      !sameFile(finalBefore, finalOpened) ||
      !sameFile(stageOpened, finalOpened) ||
      stageOpened.size !== finalOpened.size ||
      stageOpened.mode !== finalOpened.mode ||
      stageOpened.uid !== finalOpened.uid ||
      stageOpened.gid !== finalOpened.gid ||
      stageOpened.nlink !== 2 ||
      finalOpened.nlink !== 2 ||
      stageOpened.ctimeMs !== finalOpened.ctimeMs ||
      stageOpened.mtimeMs !== finalOpened.mtimeMs ||
      stageBefore.size !== stageOpened.size ||
      stageBefore.mode !== stageOpened.mode ||
      stageBefore.uid !== stageOpened.uid ||
      stageBefore.gid !== stageOpened.gid ||
      stageBefore.nlink !== stageOpened.nlink ||
      stageBefore.ctimeMs !== stageOpened.ctimeMs ||
      stageBefore.mtimeMs !== stageOpened.mtimeMs
    ) return false;

    fs.closeSync(stageFd);
    stageFd = undefined;
    fs.closeSync(finalFd);
    finalFd = undefined;

    const stageAfter = fs.lstatSync(stagePath);
    const finalAfter = fs.lstatSync(finalPath);
    return (
      stageAfter.isFile() &&
      !stageAfter.isSymbolicLink() &&
      finalAfter.isFile() &&
      !finalAfter.isSymbolicLink() &&
      sameFile(stageOpened, stageAfter) &&
      sameFile(finalOpened, finalAfter) &&
      sameFile(stageAfter, finalAfter) &&
      stageOpened.size === stageAfter.size &&
      stageOpened.mode === stageAfter.mode &&
      stageOpened.uid === stageAfter.uid &&
      stageOpened.gid === stageAfter.gid &&
      stageOpened.nlink === stageAfter.nlink &&
      stageOpened.ctimeMs === stageAfter.ctimeMs &&
      stageOpened.mtimeMs === stageAfter.mtimeMs &&
      finalOpened.size === finalAfter.size &&
      finalOpened.mode === finalAfter.mode &&
      finalOpened.uid === finalAfter.uid &&
      finalOpened.gid === finalAfter.gid &&
      finalOpened.nlink === finalAfter.nlink &&
      finalOpened.ctimeMs === finalAfter.ctimeMs &&
      finalOpened.mtimeMs === finalAfter.mtimeMs &&
      rootIsSafe(root) &&
      rootIdentityIsStable(root)
    );
  } catch {
    return false;
  } finally {
    if (stageFd !== undefined) {
      try { fs.closeSync(stageFd); } catch { /* best effort after failure */ }
    }
    if (finalFd !== undefined) {
      try { fs.closeSync(finalFd); } catch { /* best effort after failure */ }
    }
  }
}

function parseInitializationAlias(finalPath, name) {
  const finalName = path.basename(finalPath);
  const prefix = `.${finalName}.`;
  const suffix = '.tmp';
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return null;
  const tokens = name.slice(prefix.length, -suffix.length).split('.');
  if (
    tokens.length !== 4 ||
    tokens[0] !== 'init-v1' ||
    !/^[1-9][0-9]{0,9}$/.test(tokens[1]) ||
    !/^[0-9a-f]{16}$/.test(tokens[2]) ||
    !/^[0-9a-f]{64}$/.test(tokens[3])
  ) return null;
  return {
    name,
    pid: tokens[1],
    nonce: tokens[2],
    digest: tokens[3],
  };
}

function parseResetStage(finalPath, name) {
  const finalName = path.basename(finalPath);
  const prefix = `.${finalName}.`;
  const suffix = '.tmp';
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return null;
  const tokens = name.slice(prefix.length, -suffix.length).split('.');
  if (
    tokens.length !== 4 ||
    tokens[0] !== 'reset-v1' ||
    !/^[1-9][0-9]{0,9}$/.test(tokens[1]) ||
    !/^[0-9a-f]{16}$/.test(tokens[2]) ||
    !/^[0-9a-f]{64}$/.test(tokens[3])
  ) return null;
  return {
    name,
    pid: tokens[1],
    nonce: tokens[2],
    digest: tokens[3],
  };
}

function parseInitializationQuarantine(finalPath, name) {
  const prefix = `.${path.basename(finalPath)}.q.`;
  if (!name.startsWith(prefix)) return null;
  const tokens = name.slice(prefix.length).split('.');
  if (
    tokens.length !== 4 ||
    !['owned-stage', 'publication-alias', 'reset-stage'].includes(tokens[0]) ||
    !/^[0-9a-f]{64}$/.test(tokens[1]) ||
    !/^[0-9a-f]{16}$/.test(tokens[2]) ||
    !/^[0-9a-f]{16}$/.test(tokens[3])
  ) return null;
  return {
    name,
    role: tokens[0],
    digest: tokens[1],
    nonce: tokens[2],
    cleanupNonce: tokens[3],
  };
}

function initializationAliasEvidence(root, finalPath) {
  if (path.dirname(finalPath) !== root.sessionsRoot) {
    throw new Error('final state is outside the sessions root');
  }
  const finalName = path.basename(finalPath);
  const prefix = `.${finalName}.`;
  const related = fs.readdirSync(root.sessionsRoot)
    .filter((name) => name.startsWith(prefix));
  const strict = related.filter((name) => (
    parseInitializationAlias(finalPath, name) !== null
  ));
  return { related, strict };
}

function sameInodeInitializationEntries(root, finalPath, finalStat) {
  const evidence = initializationAliasEvidence(root, finalPath);
  const entries = [];
  for (const name of evidence.related) {
    try {
      const candidatePath = path.join(root.sessionsRoot, name);
      const stat = fs.lstatSync(candidatePath);
      if (sameFile(stat, finalStat)) {
        entries.push({
          kind: 'stage',
          name,
          parsed: parseInitializationAlias(finalPath, name),
          role: 'publication-alias',
          sourcePath: candidatePath,
          stat,
        });
        continue;
      }

      const parsedQuarantine = parseInitializationQuarantine(finalPath, name);
      if (
        !parsedQuarantine ||
        !['owned-stage', 'publication-alias'].includes(
          parsedQuarantine.role,
        ) ||
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (stat.mode & 0o7777) !== 0o700 ||
        typeof process.getuid !== 'function' ||
        stat.uid !== process.getuid() ||
        fs.readdirSync(candidatePath).length !== 1
      ) continue;
      const sourcePath = path.join(candidatePath, 'entry');
      const entryStat = fs.lstatSync(sourcePath);
      if (
        entryStat.isFile() &&
        !entryStat.isSymbolicLink() &&
        sameFile(entryStat, finalStat)
      ) {
        entries.push({
          kind: 'quarantine',
          name,
          parsed: parsedQuarantine,
          role: parsedQuarantine.role,
          sourcePath,
          stat: entryStat,
          quarantine: { directoryPath: candidatePath, identity: stat },
        });
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
  return entries;
}

function hasSameInodeInitializationEntry(root, finalPath, finalStat) {
  return sameInodeInitializationEntries(root, finalPath, finalStat).length !== 0;
}

function emptyInitializationQuarantineSnapshot(root, finalPath) {
  try {
    if (
      !rootIsSafe(root) ||
      !rootIdentityIsStable(root)
    ) return null;
    const evidence = initializationAliasEvidence(root, finalPath);
    const entries = [];
    for (const name of evidence.related) {
      const parsed = parseInitializationQuarantine(finalPath, name);
      if (
        !parsed ||
        !['owned-stage', 'publication-alias'].includes(parsed.role)
      ) continue;
      const directoryPath = path.join(root.sessionsRoot, name);
      const identity = fs.lstatSync(directoryPath);
      if (
        !identity.isDirectory() ||
        identity.isSymbolicLink() ||
        (identity.mode & 0o7777) !== 0o700 ||
        typeof process.getuid !== 'function' ||
        identity.uid !== process.getuid()
      ) continue;
      if (!privateDirectoryIsSafe(root, directoryPath, identity)) return null;
      if (fs.readdirSync(directoryPath).length !== 0) continue;
      entries.push({ name, directoryPath, identity });
    }
    if (
      !rootIsSafe(root) ||
      !rootIdentityIsStable(root)
    ) return null;
    return entries.sort((first, second) => (
      first.name.localeCompare(second.name)
    ));
  } catch {
    return null;
  }
}

function sameEmptyInitializationQuarantineSnapshot(first, second) {
  return (
    Array.isArray(first) &&
    Array.isArray(second) &&
    first.length === second.length &&
    first.every((entry, index) => (
      entry.name === second[index].name &&
      sameStableRecordStat(entry.identity, second[index].identity)
    ))
  );
}

function hasOneStrictSameInodeInitializationAlias(root, finalPath) {
  try {
    if (stableRootIsProven(root) !== true) return null;
    const finalStat = fs.lstatSync(finalPath);
    const finalIsStrictPair = (
      finalStat.isFile() &&
      !finalStat.isSymbolicLink() &&
      (finalStat.mode & 0o7777) === 0o600 &&
      typeof process.getuid === 'function' &&
      finalStat.uid === process.getuid() &&
      finalStat.nlink === 2
    );
    const aliases = finalIsStrictPair
      ? sameInodeInitializationEntries(root, finalPath, finalStat)
      : [];
    const hasStrictAlias = (
      finalIsStrictPair &&
      aliases.length === 1 &&
      aliases[0].parsed !== null
    );
    if (stableRootIsProven(root) !== true) return null;
    return hasStrictAlias;
  } catch {
    return null;
  }
}

function readFinalOnlyAfterBarrier(root, finalPath) {
  try {
    if (
      !rootIsSafe(root) ||
      !rootIdentityIsStable(root)
    ) return recordError();
    const observed = readRecord(finalPath);
    if (observed.kind !== RECORD_VALID) return recordError();
    if (
      hasSameInodeInitializationEntry(root, finalPath, observed.stat) ||
      !rootIsSafe(root) ||
      !rootIdentityIsStable(root)
    ) return recordError();
    const emptyQuarantines = emptyInitializationQuarantineSnapshot(
      root,
      finalPath,
    );
    if (!emptyQuarantines) return recordError();
    for (const quarantine of emptyQuarantines) {
      if (
        !syncPrivateDirectory(
          root,
          quarantine.directoryPath,
          quarantine.identity,
        )
      ) return recordError();
    }
    if (!syncSessionsDirectory(root)) return recordError();
    const finalized = readRecord(finalPath);
    const finalizedEmptyQuarantines = emptyInitializationQuarantineSnapshot(
      root,
      finalPath,
    );
    if (
      finalized.kind !== RECORD_VALID ||
      !sameStableRecordStat(observed.stat, finalized.stat) ||
      !sameRecordBytes(observed, finalized) ||
      !sameEmptyInitializationQuarantineSnapshot(
        emptyQuarantines,
        finalizedEmptyQuarantines,
      )
    ) return recordError();
    if (
      hasSameInodeInitializationEntry(root, finalPath, finalized.stat) ||
      !rootIsSafe(root) ||
      !rootIdentityIsStable(root)
    ) return recordError();
    return finalized;
  } catch {
    return recordError();
  }
}

function readFinalOnlyAfterAliasRace(root, finalPath, aliasPath) {
  try {
    fs.lstatSync(aliasPath);
    return recordError();
  } catch (error) {
    if (!error || error.code !== 'ENOENT') return recordError();
  }
  return readFinalOnlyAfterBarrier(root, finalPath);
}

function privateDirectoryIsSafe(root, directoryPath, identity) {
  try {
    if (
      !identity ||
      path.dirname(directoryPath) !== root.sessionsRoot ||
      !rootIsSafe(root) ||
      !rootIdentityIsStable(root)
    ) return false;
    const stat = fs.lstatSync(directoryPath);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      sameFile(stat, identity) &&
      (stat.mode & 0o7777) === 0o700 &&
      typeof process.getuid === 'function' &&
      stat.uid === process.getuid()
    );
  } catch {
    return false;
  }
}

function syncPrivateDirectory(root, directoryPath, identity) {
  let fd;
  try {
    if (!privateDirectoryIsSafe(root, directoryPath, identity)) return false;
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const directory = fs.constants.O_DIRECTORY || 0;
    const flags = fs.constants.O_RDONLY | noFollow | directory;
    fd = fs.openSync(directoryPath, flags);
    const opened = fs.fstatSync(fd);
    if (
      !opened.isDirectory() ||
      !sameFile(opened, identity) ||
      (opened.mode & 0o7777) !== 0o700 ||
      opened.uid !== process.getuid()
    ) return false;
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    if (!privateDirectoryIsSafe(root, directoryPath, identity)) return false;
    fd = fs.openSync(directoryPath, flags);
    const reopened = fs.fstatSync(fd);
    if (
      !reopened.isDirectory() ||
      !sameFile(opened, reopened) ||
      !sameFile(reopened, identity) ||
      (reopened.mode & 0o7777) !== 0o700 ||
      reopened.uid !== process.getuid()
    ) return false;
    fs.closeSync(fd);
    fd = undefined;
    return privateDirectoryIsSafe(root, directoryPath, identity);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort after failure */ }
    }
  }
}

function removeEmptyPrivateDirectory(root, directoryPath, identity) {
  try {
    if (
      !syncPrivateDirectory(root, directoryPath, identity) ||
      fs.readdirSync(directoryPath).length !== 0 ||
      !privateDirectoryIsSafe(root, directoryPath, identity)
    ) return false;
    fs.rmdirSync(directoryPath);
    return syncSessionsDirectory(root);
  } catch {
    return false;
  }
}

function reserveInitializationQuarantine(root, finalPath, parsedAlias, role) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    try {
      if (
        !rootIsSafe(root) ||
        !rootIdentityIsStable(root)
      ) return null;
      const cleanupNonce = crypto.randomBytes(8).toString('hex');
      const directoryPath = path.join(
        root.sessionsRoot,
        `.${path.basename(finalPath)}.q.${role}.${parsedAlias.digest}.${parsedAlias.nonce}.${cleanupNonce}`,
      );
      fs.mkdirSync(directoryPath, { mode: 0o700 });
      const identity = fs.lstatSync(directoryPath);
      if (
        !privateDirectoryIsSafe(root, directoryPath, identity) ||
        !syncPrivateDirectory(root, directoryPath, identity) ||
        !syncSessionsDirectory(root)
      ) return null;
      return { directoryPath, identity };
    } catch (error) {
      if (error && error.code === 'EEXIST') continue;
      return null;
    }
  }
  return null;
}

function recordsMatch(first, second) {
  return (
    first.kind === RECORD_VALID &&
    second.kind === RECORD_VALID &&
    sameStableRecordStat(first.stat, second.stat) &&
    sameRecordBytes(first, second)
  );
}

function quarantineAndRemoveInitializationEntry(root, evidence) {
  const preserved = 'preserved';
  try {
    if (
      !evidence ||
      (
        !evidence.quarantine &&
        path.dirname(evidence.sourcePath) !== root.sessionsRoot
      ) ||
      (
        evidence.quarantine &&
        (
          path.dirname(evidence.sourcePath) !==
            evidence.quarantine.directoryPath ||
          path.dirname(evidence.quarantine.directoryPath) !== root.sessionsRoot ||
          path.basename(evidence.sourcePath) !== 'entry'
        )
      ) ||
      path.dirname(evidence.finalPath) !== root.sessionsRoot ||
      !evidence.identity ||
      !evidence.parsedAlias ||
      ![1, 2].includes(evidence.expectedLinks) ||
      !['owned-stage', 'publication-alias', 'reset-stage'].includes(
        evidence.role,
      ) ||
      !rootIsSafe(root) ||
      !rootIdentityIsStable(root)
    ) return preserved;

    let sourceBefore;
    try {
      sourceBefore = fs.lstatSync(evidence.sourcePath);
    } catch (error) {
      if (
        error &&
        error.code === 'ENOENT' &&
        evidence.quarantine &&
        removeEmptyPrivateDirectory(
          root,
          evidence.quarantine.directoryPath,
          evidence.quarantine.identity,
        )
      ) return 'absent';
      return error && error.code === 'ENOENT' && !evidence.quarantine
        ? 'absent'
        : preserved;
    }
    if (
      !sourceBefore.isFile() ||
      sourceBefore.isSymbolicLink() ||
      !sameStableRecordStat(sourceBefore, evidence.identity) ||
      sourceBefore.nlink !== evidence.expectedLinks ||
      evidence.identity.nlink !== evidence.expectedLinks
    ) return preserved;

    let quarantine = evidence.quarantine;
    let entryPath;
    if (quarantine) {
      entryPath = path.join(quarantine.directoryPath, 'entry');
      if (
        evidence.sourcePath !== entryPath ||
        !syncPrivateDirectory(
          root,
          quarantine.directoryPath,
          quarantine.identity,
        ) ||
        !syncSessionsDirectory(root)
      ) return preserved;
    } else {
      quarantine = reserveInitializationQuarantine(
        root,
        evidence.finalPath,
        evidence.parsedAlias,
        evidence.role,
      );
      if (!quarantine) return preserved;
      entryPath = path.join(quarantine.directoryPath, 'entry');
      try {
        fs.renameSync(evidence.sourcePath, entryPath);
      } catch (error) {
        if (
          error &&
          error.code === 'ENOENT' &&
          removeEmptyPrivateDirectory(
            root,
            quarantine.directoryPath,
            quarantine.identity,
          )
        ) return 'absent';
        return preserved;
      }

      if (
        !syncPrivateDirectory(
          root,
          quarantine.directoryPath,
          quarantine.identity,
        ) ||
        !syncSessionsDirectory(root)
      ) return preserved;
    }

    const quarantined = readRecord(entryPath, evidence.expectedLinks);
    if (
      quarantined.kind !== RECORD_VALID ||
      !sameFile(quarantined.stat, evidence.identity) ||
      quarantined.digest !== evidence.parsedAlias.digest
    ) return preserved;

    let canonical;
    if (evidence.expectedLinks === 2) {
      canonical = readRecord(evidence.finalPath, 2);
      if (
        canonical.kind !== RECORD_VALID ||
        !sameFile(quarantined.stat, canonical.stat) ||
        !sameRecordBytes(quarantined, canonical)
      ) return preserved;
    }

    const verifiedEntry = readRecord(entryPath, evidence.expectedLinks);
    if (
      !recordsMatch(quarantined, verifiedEntry) ||
      !privateDirectoryIsSafe(
        root,
        quarantine.directoryPath,
        quarantine.identity,
      )
    ) return preserved;
    if (evidence.expectedLinks === 2) {
      const verifiedCanonical = readRecord(evidence.finalPath, 2);
      if (
        !recordsMatch(canonical, verifiedCanonical) ||
        !sameFile(verifiedEntry.stat, verifiedCanonical.stat) ||
        !sameRecordBytes(verifiedEntry, verifiedCanonical)
      ) return preserved;
    }

    fs.unlinkSync(entryPath);
    return removeEmptyPrivateDirectory(
      root,
      quarantine.directoryPath,
      quarantine.identity,
    ) ? 'removed' : preserved;
  } catch {
    return preserved;
  }
}

function recoverInitializationAlias(root, finalPath, allowFinalOnlyRace = false) {
  try {
    if (
      !rootIsSafe(root) ||
      !rootIdentityIsStable(root)
    ) return recordError();

    const namespaceEvidence = initializationAliasEvidence(root, finalPath);
    if (namespaceEvidence.related.length === 0) {
      return allowFinalOnlyRace
        ? readFinalOnlyAfterBarrier(root, finalPath)
        : recordError();
    }
    const finalIdentity = fs.lstatSync(finalPath);
    const aliases = sameInodeInitializationEntries(
      root,
      finalPath,
      finalIdentity,
    );
    if (aliases.length === 0) {
      return allowFinalOnlyRace
        ? readFinalOnlyAfterBarrier(root, finalPath)
        : recordError();
    }
    if (
      aliases.length !== 1 ||
      aliases[0].parsed === null
    ) return recordError();

    const candidate = aliases[0];
    const parsedAlias = candidate.parsed;
    const observedAlias = candidate.stat;
    if (
      !finalIdentity.isFile() ||
      finalIdentity.isSymbolicLink() ||
      !observedAlias.isFile() ||
      observedAlias.isSymbolicLink() ||
      !sameStableRecordStat(finalIdentity, observedAlias) ||
      finalIdentity.nlink !== 2 ||
      observedAlias.nlink !== 2
    ) return recordError();
    const aliasPath = candidate.sourcePath;
    if (
      candidate.kind === 'quarantine' &&
      !syncPrivateDirectory(
        root,
        candidate.quarantine.directoryPath,
        candidate.quarantine.identity,
      )
    ) return recordError();
    if (!syncSessionsDirectory(root)) return recordError();
    const linked = readRecord(finalPath, 2);
    if (
      linked.kind !== RECORD_VALID ||
      !sameStableRecordStat(linked.stat, finalIdentity) ||
      linked.digest !== parsedAlias.digest
    ) return recordError();
    let aliasIdentity;
    try {
      aliasIdentity = fs.lstatSync(aliasPath);
    } catch (error) {
      return error && error.code === 'ENOENT'
        ? readFinalOnlyAfterAliasRace(root, finalPath, aliasPath)
        : recordError();
    }
    if (
      !sameStableRecordStat(aliasIdentity, observedAlias) ||
      !sameFile(aliasIdentity, linked.stat) ||
      !sameFile(aliasIdentity, finalIdentity)
    ) return recordError();
    if (
      candidate.kind === 'stage' &&
      !initializationPairIsSafe(
        root,
        aliasPath,
        finalPath,
        aliasIdentity,
      )
    ) return readFinalOnlyAfterAliasRace(root, finalPath, aliasPath);

    const cleanup = quarantineAndRemoveInitializationEntry(root, {
      sourcePath: aliasPath,
      finalPath,
      identity: aliasIdentity,
      parsedAlias,
      expectedLinks: 2,
      role: candidate.role,
      quarantine: candidate.quarantine,
    });
    if (cleanup === 'absent') {
      return readFinalOnlyAfterBarrier(root, finalPath);
    }
    if (cleanup !== 'removed') return recordError();
    return readFinalOnlyAfterBarrier(root, finalPath);
  } catch {
    return recordError();
  }
}

function tempIsSafe(root, tempPath, identity) {
  try {
    if (
      !tempPath ||
      !identity ||
      !rootIsSafe(root) ||
      path.dirname(tempPath) !== root.sessionsRoot
    ) return false;
    const stat = fs.lstatSync(tempPath);
    return stat.isFile() && !stat.isSymbolicLink() && sameFile(stat, identity);
  } catch {
    return false;
  }
}

function createStateStore(dataDir, options = {}) {
  const clock = options && typeof options.now === 'function'
    ? options.now
    : () => new Date();
  const root = prepareRoot(dataDir);

  function currentDate() {
    try {
      return normalizeDate(clock());
    } catch {
      return null;
    }
  }

  function read(sessionId) {
    if (
      !rootIsSafe(root) ||
      !rootIdentityIsStable(root)
    ) return { kind: 'unavailable' };
    const filePath = statePath(root, sessionId);
    if (!filePath) return { kind: 'unavailable' };
    const record = readRecord(filePath, 1, () => (
      hasOneStrictSameInodeInitializationAlias(root, filePath)
    ));
    if (
      !rootIsSafe(root) ||
      !rootIdentityIsStable(root)
    ) return { kind: 'unavailable' };
    if (record.kind === RECORD_VALID) {
      const finalized = readFinalOnlyAfterBarrier(root, filePath);
      if (
        !rootIsSafe(root) ||
        !rootIdentityIsStable(root) ||
        finalized.kind !== RECORD_VALID ||
        !sameStableRecordStat(record.stat, finalized.stat) ||
        !sameRecordBytes(record, finalized)
      ) return { kind: 'unavailable' };
      return { kind: 'found', mode: finalized.mode };
    }
    if (record.kind === RECORD_MISSING) return { kind: 'missing' };
    if (record.kind !== RECORD_LINK_MISMATCH) {
      return { kind: 'unavailable' };
    }
    const recovered = record.hadRecoverableAlias
      ? recoverInitializationAlias(root, filePath, true)
      : readFinalOnlyAfterBarrier(root, filePath);
    if (recovered.kind === RECORD_VALID) {
      return { kind: 'found', mode: recovered.mode };
    }
    return { kind: 'unavailable' };
  }

  function initializeIfMissing(sessionId, value, at) {
    const filePath = statePath(root, sessionId);
    if (
      !filePath ||
      !rootIsSafe(root) ||
      !rootIdentityIsStable(root)
    ) return { kind: 'unavailable' };

    const existing = readRecord(filePath, 1, () => (
      hasOneStrictSameInodeInitializationAlias(root, filePath)
    ));
    if (
      !rootIsSafe(root) ||
      !rootIdentityIsStable(root)
    ) return { kind: 'unavailable' };
    if (existing.kind === RECORD_VALID) {
      const finalized = readFinalOnlyAfterBarrier(root, filePath);
      if (
        !rootIsSafe(root) ||
        !rootIdentityIsStable(root) ||
        finalized.kind !== RECORD_VALID ||
        !sameStableRecordStat(existing.stat, finalized.stat) ||
        !sameRecordBytes(existing, finalized)
      ) return { kind: 'unavailable' };
      return { kind: 'found', mode: finalized.mode };
    }
    if (existing.kind !== RECORD_MISSING) {
      if (existing.kind !== RECORD_LINK_MISMATCH) {
        return { kind: 'unavailable' };
      }
      const recovered = existing.hadRecoverableAlias
        ? recoverInitializationAlias(root, filePath, true)
        : readFinalOnlyAfterBarrier(root, filePath);
      return recovered.kind === RECORD_VALID
        ? { kind: 'found', mode: recovered.mode }
        : { kind: 'unavailable' };
    }

    const mode = canonicalizeMode(value);
    const date = at === undefined ? currentDate() : normalizeDate(at);
    if (
      !mode ||
      !date ||
      !rootIsSafe(root) ||
      !rootIdentityIsStable(root)
    ) return { kind: 'unavailable' };

    let tempPath;
    let tempIdentity;
    let syncedIdentity;
    let cleanupIdentity;
    let parsedStage;
    let bodyDigest;
    let fd;
    try {
      const body = `${JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        mode,
        updatedAt: date.toISOString(),
      })}\n`;
      const bodyBytes = Buffer.from(body, 'utf8');
      bodyDigest = crypto.createHash('sha256').update(bodyBytes).digest('hex');
      tempPath = path.join(
        root.sessionsRoot,
        `.${path.basename(filePath)}.init-v1.${process.pid}.${crypto.randomBytes(8).toString('hex')}.${bodyDigest}.tmp`,
      );
      parsedStage = parseInitializationAlias(
        filePath,
        path.basename(tempPath),
      );
      if (!parsedStage || parsedStage.digest !== bodyDigest) {
        throw new Error('temporary state name does not bind its contents');
      }
      const noFollow = fs.constants.O_NOFOLLOW || 0;
      fd = fs.openSync(
        tempPath,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          noFollow,
        0o600,
      );
      tempIdentity = fs.fstatSync(fd);
      if (
        !tempIdentity.isFile() ||
        (tempIdentity.mode & 0o7777) !== 0o600 ||
        typeof process.getuid !== 'function' ||
        tempIdentity.uid !== process.getuid() ||
        tempIdentity.nlink !== 1
      ) throw new Error('temporary state is unsafe');
      fs.writeFileSync(fd, bodyBytes);
      try { fs.fchmodSync(fd, 0o600); } catch { /* best effort on non-Unix hosts */ }
      const preparedIdentity = fs.fstatSync(fd);
      if (
        !preparedIdentity.isFile() ||
        !sameFile(tempIdentity, preparedIdentity) ||
        preparedIdentity.size !== bodyBytes.length ||
        (preparedIdentity.mode & 0o7777) !== 0o600 ||
        preparedIdentity.uid !== process.getuid() ||
        preparedIdentity.nlink !== 1
      ) throw new Error('prepared temporary state is unsafe');
      cleanupIdentity = preparedIdentity;
      fs.fsyncSync(fd);
      syncedIdentity = fs.fstatSync(fd);
      if (
        syncedIdentity.isFile() &&
        sameFile(preparedIdentity, syncedIdentity) &&
        (syncedIdentity.mode & 0o7777) === 0o600 &&
        syncedIdentity.uid === process.getuid() &&
        syncedIdentity.nlink === 1
      ) cleanupIdentity = syncedIdentity;
      if (
        !syncedIdentity.isFile() ||
        !sameStableRecordStat(preparedIdentity, syncedIdentity)
      ) throw new Error('synced temporary state is unsafe');
      fs.closeSync(fd);
      fd = undefined;

      const staged = readRecord(tempPath);
      if (
        staged.kind === RECORD_VALID &&
        sameFile(syncedIdentity, staged.stat)
      ) cleanupIdentity = staged.stat;
      if (
        staged.kind !== RECORD_VALID ||
        !staged.bytes.equals(bodyBytes) ||
        staged.mode !== mode ||
        staged.updatedAt.getTime() !== date.getTime() ||
        !sameStableRecordStat(syncedIdentity, staged.stat)
      ) throw new Error('temporary state changed after fsync');

      const preLinkRootIsStable = (
        rootIsSafe(root) && rootIdentityIsStable(root)
      );
      const preLinkTempIsSafe = (
        preLinkRootIsStable && tempIsSafe(root, tempPath, tempIdentity)
      );
      const postValidationRootIsStable = (
        rootIsSafe(root) && rootIdentityIsStable(root)
      );
      if (!preLinkTempIsSafe || !postValidationRootIsStable) {
        if (postValidationRootIsStable) {
          quarantineAndRemoveInitializationEntry(root, {
            sourcePath: tempPath,
            finalPath: filePath,
            identity: staged.stat,
            parsedAlias: parsedStage,
            expectedLinks: 1,
            role: 'owned-stage',
          });
        }
        return { kind: 'unavailable' };
      }

      try {
        fs.linkSync(tempPath, filePath);
      } catch (error) {
        const tempCleanup = quarantineAndRemoveInitializationEntry(root, {
          sourcePath: tempPath,
          finalPath: filePath,
          identity: staged.stat,
          parsedAlias: parsedStage,
          expectedLinks: 1,
          role: 'owned-stage',
        });
        if (!error || error.code !== 'EEXIST') {
          fsyncDirectory(root);
          return { kind: 'unavailable' };
        }
        if (tempCleanup !== 'removed') return { kind: 'unavailable' };
        if (!syncSessionsDirectory(root)) return { kind: 'unavailable' };
        const winner = readRecord(filePath, 1, () => (
          hasOneStrictSameInodeInitializationAlias(root, filePath)
        ));
        if (
          !rootIsSafe(root) ||
          !rootIdentityIsStable(root)
        ) return { kind: 'unavailable' };
        if (winner.kind === RECORD_VALID) {
          const finalized = readFinalOnlyAfterBarrier(root, filePath);
          return finalized.kind === RECORD_VALID
            ? { kind: 'found', mode: finalized.mode }
            : { kind: 'unavailable' };
        }
        if (winner.kind !== RECORD_LINK_MISMATCH) {
          return { kind: 'unavailable' };
        }
        const recovered = winner.hadRecoverableAlias
          ? recoverInitializationAlias(root, filePath, true)
          : readFinalOnlyAfterBarrier(root, filePath);
        return recovered.kind === RECORD_VALID
          ? { kind: 'found', mode: recovered.mode }
          : { kind: 'unavailable' };
      }

      if (!syncSessionsDirectory(root)) return { kind: 'unavailable' };
      if (
        !initializationPairIsSafe(root, tempPath, filePath, tempIdentity)
      ) return { kind: 'unavailable' };
      const linkedStage = readRecord(tempPath, 2);
      const linkedFinal = readRecord(filePath, 2);
      if (
        linkedStage.kind !== RECORD_VALID ||
        linkedFinal.kind !== RECORD_VALID ||
        !linkedStage.bytes.equals(bodyBytes) ||
        !linkedFinal.bytes.equals(bodyBytes) ||
        linkedStage.mode !== mode ||
        linkedFinal.mode !== mode ||
        linkedStage.updatedAt.getTime() !== date.getTime() ||
        linkedFinal.updatedAt.getTime() !== date.getTime() ||
        !sameStableRecordStat(linkedStage.stat, linkedFinal.stat) ||
        !sameFile(staged.stat, linkedStage.stat) ||
        staged.stat.size !== linkedStage.stat.size ||
        staged.stat.mode !== linkedStage.stat.mode ||
        staged.stat.uid !== linkedStage.stat.uid ||
        staged.stat.gid !== linkedStage.stat.gid ||
        staged.stat.mtimeMs !== linkedStage.stat.mtimeMs
      ) return { kind: 'unavailable' };
      const cleanup = quarantineAndRemoveInitializationEntry(root, {
        sourcePath: tempPath,
        finalPath: filePath,
        identity: linkedStage.stat,
        parsedAlias: parsedStage,
        expectedLinks: 2,
        role: 'publication-alias',
      });
      if (cleanup !== 'removed' && cleanup !== 'absent') {
        return { kind: 'unavailable' };
      }
      tempPath = undefined;
      const published = readFinalOnlyAfterBarrier(root, filePath);
      return published.kind === RECORD_VALID
        ? { kind: 'found', mode: published.mode }
        : { kind: 'unavailable' };
    } catch {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* best effort */ }
      }
      if (cleanupIdentity && parsedStage) {
        quarantineAndRemoveInitializationEntry(root, {
          sourcePath: tempPath,
          finalPath: filePath,
          identity: cleanupIdentity,
          parsedAlias: parsedStage,
          expectedLinks: 1,
          role: 'owned-stage',
        });
      }
      fsyncDirectory(root);
      return { kind: 'unavailable' };
    }
  }

  function write(sessionId, value, at) {
    const mode = canonicalizeMode(value);
    const filePath = statePath(root, sessionId);
    const date = at === undefined ? currentDate() : normalizeDate(at);
    if (
      !mode ||
      !filePath ||
      !date ||
      !rootIsSafe(root) ||
      !rootIdentityIsStable(root)
    ) return false;
    const destination = inspectDestination(filePath);
    if (!destination) return false;

    const body = `${JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      mode,
      updatedAt: date.toISOString(),
    })}\n`;
    const bodyBytes = Buffer.from(body, 'utf8');
    const digest = crypto.createHash('sha256').update(bodyBytes).digest('hex');

    let tempPath;
    let tempIdentity;
    let cleanupIdentity;
    let parsedStage;
    let fd;

    function quarantineResetStage(identity) {
      if (!tempPath || !identity || !parsedStage) return 'preserved';
      return quarantineAndRemoveInitializationEntry(root, {
        sourcePath: tempPath,
        finalPath: filePath,
        identity,
        parsedAlias: parsedStage,
        expectedLinks: 1,
        role: 'reset-stage',
      });
    }

    try {
      const nonce = crypto.randomBytes(8).toString('hex');
      tempPath = path.join(
        root.sessionsRoot,
        `.${path.basename(filePath)}.reset-v1.${process.pid}.${nonce}.${digest}.tmp`,
      );
      parsedStage = parseResetStage(filePath, path.basename(tempPath));
      if (!parsedStage) throw new Error('invalid reset stage name');
      const noFollow = fs.constants.O_NOFOLLOW || 0;
      fd = fs.openSync(
        tempPath,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          noFollow,
        0o600,
      );
      tempIdentity = fs.fstatSync(fd);
      if (
        !tempIdentity.isFile() ||
        tempIdentity.nlink !== 1 ||
        typeof process.getuid !== 'function' ||
        tempIdentity.uid !== process.getuid()
      ) throw new Error('temporary state is not a private file');
      fs.writeFileSync(fd, bodyBytes);
      try { fs.fchmodSync(fd, 0o600); } catch { /* best effort on non-Unix hosts */ }
      fs.fsyncSync(fd);
      cleanupIdentity = fs.fstatSync(fd);
      if (
        !cleanupIdentity.isFile() ||
        !sameFile(cleanupIdentity, tempIdentity) ||
        cleanupIdentity.size !== bodyBytes.length ||
        (cleanupIdentity.mode & 0o7777) !== 0o600 ||
        cleanupIdentity.uid !== process.getuid() ||
        cleanupIdentity.nlink !== 1
      ) throw new Error('reset stage changed while writing');
      fs.closeSync(fd);
      fd = undefined;
      if (
        !rootIsSafe(root) ||
        !destinationIsStable(filePath, destination)
      ) {
        quarantineResetStage(cleanupIdentity);
        return false;
      }

      const staged = readRecord(tempPath);
      if (
        staged.kind !== RECORD_VALID ||
        !sameStableRecordStat(staged.stat, cleanupIdentity) ||
        !staged.bytes.equals(bodyBytes) ||
        staged.digest !== digest ||
        staged.mode !== mode ||
        staged.updatedAt.getTime() !== date.getTime()
      ) {
        quarantineResetStage(cleanupIdentity);
        return false;
      }
      cleanupIdentity = staged.stat;
      if (
        !rootIsSafe(root) ||
        !rootIdentityIsStable(root) ||
        !destinationIsStable(filePath, destination) ||
        !tempIsSafe(root, tempPath, cleanupIdentity)
      ) {
        quarantineResetStage(cleanupIdentity);
        return false;
      }
      fs.renameSync(tempPath, filePath);
      tempPath = undefined;
      if (!syncSessionsDirectory(root)) return false;
      const published = readFinalOnlyAfterBarrier(root, filePath);
      return (
        published.kind === RECORD_VALID &&
        sameFile(published.stat, cleanupIdentity) &&
        published.bytes.equals(bodyBytes) &&
        published.mode === mode &&
        published.updatedAt.getTime() === date.getTime()
      );
    } catch {
      if (fd !== undefined) {
        try {
          const observed = fs.fstatSync(fd);
          if (
            tempIdentity &&
            observed.isFile() &&
            sameFile(observed, tempIdentity) &&
            observed.nlink === 1 &&
            typeof process.getuid === 'function' &&
            observed.uid === process.getuid()
          ) cleanupIdentity = observed;
        } catch { /* preserve unverified stage */ }
        try { fs.closeSync(fd); } catch { /* best effort */ }
      }
      quarantineResetStage(cleanupIdentity);
      return false;
    }
  }

  return { read, initializeIfMissing, write };
}

module.exports = {
  SCHEMA_VERSION,
  MAX_STATE_BYTES,
  stateKey,
  createStateStore,
};
