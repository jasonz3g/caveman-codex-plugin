# Codex Caveman 0.1 Core Progress

Updated: 2026-07-15
Branch: `main`
Worktree: `/Users/jason/home/Github/caveman-codex-plugin`
Core baseline: `412738e`
Status: Complete

## Delivered Scope

Caveman 0.1 contains the complete core plugin:

- native manifest and hook registry;
- registered `SessionStart` for `startup` and `clear`, with `resume` and
  `compact` intentionally excluded to prevent repeated host publication;
- `UserPromptSubmit` mode switching and per-turn reinforcement;
- canonical `off`, `lite`, `full`, `ultra`, `wenyan-lite`, `wenyan-full`, and
  `wenyan-ultra` modes, with `wenyan` as an alias;
- bounded English and Chinese mode-intent parsing;
- bundled mode-aware skill rendering and safe fallback rules;
- isolated, concurrency-safe session state;
- environment, repository, and user default-mode configuration;
- bounded, silent, fail-safe hook I/O;
- dependency-free CommonJS runtime and core automated tests.

There is no pending 0.1 core feature slice.

## Completed Invariants

| Invariant | Commit(s) |
| --- | --- |
| Package scaffold and hook registry | `e9128e5`, `bae4140`, `965522f` |
| Canonical modes | `cf5908c` |
| Default-mode resolution | `30548ba` |
| Session-state baseline and outcome semantics | `e5c242a`, `be3f708` |
| Prompt intent and false-positive safety | `d3c3aa6`, `939269f` |
| Bundled rule rendering and metadata hardening | `173adba`, `2946f9e`, `d2dc82d`, `a4f041a`, `c346365`, `4c90fe3`, `41679b1` |
| SessionStart behavior and unavailable-state handling | `84b61d3`, `aafadf4`, `eba55c4` |
| UserPromptSubmit persistence | `5131028` |
| Session-state publication and durability | `1c95de2` |
| Stable configuration reads | `412738e` |

## Core Behavior Evidence

### SessionStart

- `startup` and `clear` reset only the addressed session to the configured
  default.
- The bounded `resume` and `compact` handler paths remain for compatibility but
  are not registered because their host events may be repeated without a safe
  event identity for deduplication.
- The first `UserPromptSubmit` after resume or compaction reasserts the stored
  mode without republishing full `SessionStart` context.
- Confirmed missing state is initialized without replacing a concurrent
  winner.
- Unavailable state fails closed to `off`, warns, and is not overwritten.
- Missing persistence applies a selected reset only to the current turn.
- Unrelated canonical session records are never age-pruned.

### UserPromptSubmit

- Exact slash, dollar, English, and Chinese commands persist canonical modes.
- The first ordinary prompt for confirmed missing state initializes it and
  injects full active context or the authoritative `off` reminder once; later
  prompts reinforce active or off state with a short reminder and without
  rewriting it.
- Questions, negations, unknown modes, oversized input, and incidental text do
  not change mode.
- Explicit write failure applies only to the current turn with a fixed warning.
- Passive unavailable state renders `off` without mutation.

### Rules and Skill

- The packaged skill supplies all six active intensities.
- Active rendering removes frontmatter and filters mode-specific rows and
  examples.
- Invalid, unsafe, oversized, or unavailable skill bytes produce bounded
  fallback rules.
- `off` always emits an authoritative normal-prose reminder.

### Session State

- Session IDs are represented by bounded SHA-256 filenames.
- Reads distinguish `found`, confirmed `missing`, and `unavailable`.
- Missing-state publication is no-replace; explicit transitions replace only
  the addressed record.
- Stable identity, exact bytes, private metadata, file durability, parent
  barriers, concurrent winners, and failure outcomes are covered by public
  tests.
- Ambiguous or foreign evidence is preserved rather than guessed or deleted.

### Configuration

- Precedence is environment, nearest repository candidate, user candidate,
  then built-in `wenyan-full`.
- Candidates use bounded no-follow descriptor reads, stable metadata checks,
  fatal UTF-8, and canonical mode validation.
- Invalid or raced candidates are ignored without changing the selected mode.

## Verification Record

Verification was rerun for the current source tree on 2026-07-15:

| Check | Result |
| --- | --- |
| Core test suite | 324 passed, 0 failed, 0 skipped, 0 todo |
| CommonJS syntax | All `hooks/*.cjs`, `lib/*.cjs`, and `tests/*.test.cjs` passed |
| Manifest and hook registry | Valid JSON, schema and packaged paths confirmed |
| Packaged hook smoke | Startup, lite transition, passive persistence, and off transition passed |
| Git whitespace | Passed |
| Markdown fences | Passed |
| Standards review | HIGH 0, MEDIUM 0, LOW 0 |
| Spec review | HIGH 0, MEDIUM 0, LOW 0 |

Pre-change GitNexus upstream impact for `hooks/hooks.json` was UNKNOWN because
the JSON registry is not indexed as a code symbol; no existing runtime symbol
changed. Current `detect_changes` classifies the six-file registry, test, and
documentation diff as low risk with no affected execution process. The public
registry RED/GREEN and existing `UserPromptSubmit` restoration tests cover the
changed contract.

## Runtime Baseline

`package.json` correctly declares Node `>=18`. The core uses CommonJS,
`node:test`, `TextDecoder`, and built-in filesystem, path, OS, and cryptographic
APIs available in that baseline. No core dependency requires a newer Node
version.

## Maintenance Rule

Treat `412738e` as the completed 0.1 core baseline. For a future core defect or
feature:

1. state one observable invariant;
2. run upstream impact for an existing symbol;
3. add one public RED;
4. make the minimum GREEN change;
5. run focused and full core tests;
6. review Standards and Spec independently;
7. commit that invariant alone.

Do not repeat completed RED/GREEN cycles merely because the implementation plan
retains their verification record.
