# Codex Caveman 0.1 Core Plugin Design

Date: 2026-07-11
Revision: 16
Status: Implemented and verified at `412738e`

## 1. Objective

Caveman 0.1 is a self-contained Codex plugin that keeps one response style
active throughout a session. It activates at session start, recognizes explicit
mode changes in user prompts, renders only the selected rules, and persists the
mode independently for each Codex session.

The built-in default is `wenyan-full`. Configuration may select another mode,
including `off`.

## 2. Core Scope

The 0.1 core consists only of:

- the native plugin manifest;
- `SessionStart` and `UserPromptSubmit` command hooks;
- canonical mode handling and prompt intent parsing;
- mode-specific rule rendering from the bundled skill;
- per-session state and concurrency-safe persistence;
- environment, repository, and user default-mode configuration;
- bounded hook I/O and fixed fail-safe output;
- the bundled `caveman` skill and automated core tests.

One-shot statistics, status-line output, and unrelated response workflows are
outside this version.

## 3. Package Layout

```text
.
├── .codex-plugin/
│   └── plugin.json
├── hooks/
│   ├── hooks.json
│   ├── session-start.cjs
│   └── user-prompt-submit.cjs
├── lib/
│   ├── config.cjs
│   ├── hook-io.cjs
│   ├── modes.cjs
│   ├── prompt-parser.cjs
│   ├── rules.cjs
│   └── state-store.cjs
├── skills/
│   └── caveman/
│       └── SKILL.md
├── tests/
│   ├── config.test.cjs
│   ├── hook-subprocess.test.cjs
│   ├── modes.test.cjs
│   ├── prompt-parser.test.cjs
│   ├── rules.test.cjs
│   ├── session-start.test.cjs
│   ├── state-store.test.cjs
│   └── user-prompt-submit.test.cjs
├── package.json
└── LICENSE
```

Codex discovers the canonical hook registry at `hooks/hooks.json`; the manifest
therefore does not need a separate hook path. Runtime commands use
`PLUGIN_ROOT`, while writable session data uses `PLUGIN_DATA`.

## 4. Modes

Stored modes form one closed set:

```text
off
lite
full
ultra
wenyan-lite
wenyan-full
wenyan-ultra
```

`wenyan` is an input alias for `wenyan-full`; it is never stored separately.
Unknown and non-string values are invalid. Every public mode consumer
canonicalizes input before use.

`off` is an authoritative mode, not missing state. Its reminder explicitly
overrides older active context so a prior `SessionStart` injection cannot
silently reactivate the style.

## 5. Default-Mode Configuration

Default resolution uses the first valid value in this order:

1. `CAVEMAN_DEFAULT_MODE`.
2. From the event working directory toward the filesystem root, first
   `.caveman/config.json`, then `.caveman.json` at each level.
3. `~/.config/caveman/config.json`.
4. Built-in `wenyan-full`.

Configuration files contain:

```json
{
  "defaultMode": "wenyan-full"
}
```

Each candidate is at most 4096 bytes. The reader requires one regular,
non-symbolic-link inode throughout `lstat`, no-follow open, bounded descriptor
read, post-read `fstat`, close, and final `lstat`. Identity, size, mode, link
count, modification time, and status-change time must remain stable. UTF-8 is
decoded fatally. Any malformed value, race, growth, replacement, or I/O fault
invalidates only that candidate and resolution continues safely.

Repository traversal is bounded to 64 parent levels. Configuration affects
only the default; an existing session record remains authoritative where the
hook source requires restoration.

## 6. Hook Registry and I/O Contract

`hooks/hooks.json` registers:

- `SessionStart` with matcher `startup|resume|clear|compact`;
- `UserPromptSubmit` without a matcher.

Both commands execute a CommonJS entry point with Node. A hook accepts at most
1 MiB of stdin, requires fatal UTF-8 JSON decoding, and accepts only a JSON
object. Invalid, oversized, or unsupported events produce no output and exit
successfully.

A successful response has this shape:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "..."
  },
  "systemMessage": "optional fixed warning"
}
```

Handlers never echo prompts, session identifiers, paths, stored bytes, or
exception details. Errors are contained. Normal operation is silent on stderr;
`CAVEMAN_DEBUG=1` permits only the fixed line
`[caveman] hook failed open`.

## 7. SessionStart

Valid events require:

- `hook_event_name: "SessionStart"`;
- a nonempty `session_id` no longer than 4096 characters;
- a nonempty `cwd`;
- one supported source.

Behavior by source:

| Source | State decision |
| --- | --- |
| `startup` | Select configured default and explicitly replace this session record. |
| `clear` | Select configured default and explicitly replace this session record. |
| `resume` | Restore validated state; initialize only confirmed missing state. |
| `compact` | Restore validated state; initialize only confirmed missing state, then reinject authoritative context. |

For `startup` and `clear`, a failed write still applies the selected default to
the current turn and emits the fixed non-persistence warning. For `resume` and
`compact`, unavailable state fails closed to `off`, emits the fixed unavailable
warning, and is never overwritten.

No hook path performs age-based pruning or deletes unrelated canonical session
records.

## 8. UserPromptSubmit

Valid events require:

- `hook_event_name: "UserPromptSubmit"`;
- the same bounded `session_id` and nonempty `cwd` requirements;
- a string `prompt` no larger than 64 KiB for intent recognition.

Exact command forms include:

```text
/caveman
/caveman lite
/caveman wenyan
/caveman off
$caveman ultra
stop caveman
normal mode
启用 caveman 文言
关闭 caveman
恢复正常模式
```

Recognized transitions write the canonical mode directly; they do not depend
on reading old state. Successful writes inject full context for the new mode.
A failed or unavailable store applies that explicit choice only to the current
turn and emits the fixed non-persistence warning.

An ordinary prompt restores validated state, initializes only confirmed
missing state without replacing a concurrent winner, and emits a short current
mode reminder. Unavailable state yields `off` plus the fixed warning and no
write.

Questions, negated requests, unknown mode names, oversized prompts, and longer
unrelated phrases never change state. Intent recognition is bounded by exact
commands and finite English and Chinese imperative grammars rather than a broad
keyword search.

## 9. Rule Rendering

The authoritative skill is bundled at `skills/caveman/SKILL.md`. Active mode
context contains:

1. an explicit current-mode header;
2. the shared skill rules without YAML frontmatter;
3. only the table row and examples for the active intensity;
4. a final statement overriding earlier caveman context.

The loader accepts at most 128 KiB, opens the final path without following a
symbolic link, verifies a stable regular descriptor, decodes UTF-8 fatally,
normalizes CRLF, rejects lone carriage returns, and accepts only a narrow
frontmatter schema containing exact `name: caveman` and one nonempty
`description`.

If the skill cannot be validated, active modes receive a small built-in
fallback that preserves technical accuracy and auto-clarity. `off` never loads
active rules; it emits only the authoritative normal-prose reminder.

Full context is emitted on session activation and explicit transitions. Short
reminders are emitted on ordinary prompts to prevent style drift without
repeating the whole skill.

## 10. Session State

State is stored at:

```text
$PLUGIN_DATA/sessions/<sha256(session_id)>.json
```

Record schema:

```json
{
  "schemaVersion": 1,
  "mode": "wenyan-full",
  "updatedAt": "2026-07-11T10:00:00.000Z"
}
```

Hashing prevents path traversal and bounds the filename. Each session receives
one independent record.

The public store exposes three operations:

- `read(sessionId)` returns `found(mode)`, `missing`, or `unavailable`;
- `initializeIfMissing(sessionId, mode, at?)` publishes without replacing an
  existing winner;
- `write(sessionId, mode, at?)` explicitly replaces only the addressed
  session record.

Only the initial canonical-path `ENOENT` is `missing`. Malformed data, unsafe
roots, symbolic links, nonregular records, wrong permissions or ownership,
unexpected links, unstable metadata, invalid UTF-8, close failures, and later
I/O races are `unavailable`.

Records are bounded to 1024 bytes and require canonical modes, schema version
1, current ownership, exact private permissions where supported, and stable
descriptor/path identity. Successful reads retain and validate the exact bytes
that were opened.

Missing-state initialization uses a unique same-directory private stage and a
no-replace publication. Explicit transitions use a distinct private stage and
atomic rename of only the addressed record. Both paths require file durability,
directory barriers, stable root identity, exact-byte verification, and safe
cleanup of only evidence owned by that operation. Concurrent initialization
adopts the validated winner rather than overwriting it.

Temporary evidence is role-separated so incomplete initialization cannot be
mistaken for an explicit replacement. Ambiguous or foreign evidence is
preserved and reported unavailable. These guarantees assume cooperative plugin
writers; no claim is made against arbitrary malicious same-UID namespace
mutation.

If `PLUGIN_DATA` is absent, hooks remain usable for the current turn but cannot
promise persistence.

## 11. Failure Semantics

The plugin is fail-safe at every external boundary:

- malformed hook input: no output, exit zero;
- invalid configuration: ignore that candidate;
- missing or invalid skill: use bounded fallback rules;
- unavailable passive session state: select `off`, warn, do not overwrite;
- explicit transition write failure: apply only this turn and warn;
- output or debug stream failure: contain the error;
- unexpected handler exception: no sensitive details and no blocked prompt.

Warnings are fixed strings. They do not interpolate user-controlled data.

## 12. Runtime and Dependencies

Runtime is dependency-free CommonJS and uses only Node built-ins. The minimum
supported engine is Node `>=18`; no core syntax or API requires a later
version.

The package is private and licensed under MIT. The plugin manifest and bundled
skill carry the Caveman attribution.

## 13. Verification

The automated suite covers:

- manifest and hook registry contracts;
- mode canonicalization and aliases;
- configuration precedence and filesystem races;
- prompt intent, false-positive, negation, and size boundaries;
- skill metadata, rule filtering, fallback, and off behavior;
- all four `SessionStart` sources;
- persistent and stateless `UserPromptSubmit` sequences;
- session isolation, concurrent initialization, unavailable state, stable
  reads, atomic writes, and durability failures;
- subprocess JSON, silence, exit status, and privacy behavior.

Acceptance requires:

- `npm test` passes from a clean checkout;
- all runtime and test `.cjs` files pass `node --check`;
- manifest and hook JSON parse and reference packaged paths;
- Markdown fences pair;
- `git diff --check` passes;
- Standards and Spec review contain no unresolved HIGH or MEDIUM finding.

At `412738e`, the clean core suite passes 323 of 323 tests and both independent
review axes report zero HIGH, MEDIUM, and LOW findings.

## 14. Authoritative References

- Codex plugin structure: <https://developers.openai.com/codex/plugins/build>
- Codex hooks: <https://developers.openai.com/codex/hooks>
- Node.js API: <https://nodejs.org/api/>
- Upstream Caveman project: <https://github.com/JuliusBrussee/caveman>
