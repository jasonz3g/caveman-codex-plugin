# Codex Caveman 0.1 Core Progress

Updated: 2026-07-14
Branch: `main`
Worktree: `/Users/jason/plugins/caveman`
Core release head: `412738e`
Status: Complete

## Delivered Scope

Caveman 0.1 contains the complete core plugin:

- native manifest and hook registry;
- `SessionStart` for `startup`, `resume`, `clear`, and `compact`;
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
- `resume` and `compact` restore validated active or off state.
- Confirmed missing state is initialized without replacing a concurrent
  winner.
- Unavailable state fails closed to `off`, warns, and is not overwritten.
- Missing persistence applies a selected reset only to the current turn.
- Unrelated canonical session records are never age-pruned.

### UserPromptSubmit

- Exact slash, dollar, English, and Chinese commands persist canonical modes.
- Ordinary prompts reinforce active or off state without rewriting it.
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

Verification was rerun from clean committed bytes and again after integration
to `main`:

| Check | Result |
| --- | --- |
| Core test suite | 323 passed, 0 failed, 0 skipped, 0 todo |
| CommonJS syntax | All `hooks/*.cjs`, `lib/*.cjs`, and `tests/*.test.cjs` passed |
| Manifest and hook registry | Valid JSON, schema and packaged paths confirmed |
| Packaged hook smoke | Startup, lite transition, passive persistence, and off transition passed |
| Git whitespace | Passed |
| Markdown fences | Passed |
| Standards review | HIGH 0, MEDIUM 0, LOW 0 |
| Spec review | HIGH 0, MEDIUM 0, LOW 0 |

GitNexus comparison against the pre-integration `main` reported LOW risk and no
affected execution process. Core integration fast-forwarded both `main` and
`feat/codex-caveman-hooks` to `412738e`; later documentation-only commits do not
change that core release head.

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
