# Codex Caveman 0.1 Core Implementation Plan

Date: 2026-07-11
Status: Complete at `412738e`

## Goal

Deliver a dependency-free Codex plugin whose two hooks activate, switch,
render, and persist Caveman response modes safely for each session.

This plan is authoritative only for the 0.1 core package:

- plugin manifest and hook registry;
- `SessionStart` and `UserPromptSubmit`;
- mode intent and canonicalization;
- bundled rule rendering;
- session state;
- default-mode configuration;
- bundled skill and core tests.

## Implementation Rules

1. Work one observable invariant at a time.
2. Add a public-behavior RED before changing production code.
3. Make the smallest GREEN change.
4. Retain each passing test before starting the next slice.
5. Keep hook output bounded, deterministic, silent, and fail-safe.
6. Do not add runtime dependencies.
7. Run impact analysis before editing an existing indexed symbol.
8. Run the full core suite and review the complete diff before each commit.

## Core File Map

| Area | Production files | Test files |
| --- | --- | --- |
| Package | `.codex-plugin/plugin.json`, `hooks/hooks.json`, `package.json`, `LICENSE` | `tests/hook-subprocess.test.cjs` |
| Modes | `lib/modes.cjs` | `tests/modes.test.cjs` |
| Configuration | `lib/config.cjs` | `tests/config.test.cjs` |
| Session state | `lib/state-store.cjs` | `tests/state-store.test.cjs` |
| Intent | `lib/prompt-parser.cjs` | `tests/prompt-parser.test.cjs` |
| Rules | `lib/rules.cjs`, `skills/caveman/SKILL.md` | `tests/rules.test.cjs` |
| Hook I/O | `lib/hook-io.cjs` | `tests/hook-subprocess.test.cjs` |
| Session start | `hooks/session-start.cjs` | `tests/session-start.test.cjs`, `tests/hook-subprocess.test.cjs` |
| Prompt submit | `hooks/user-prompt-submit.cjs` | `tests/user-prompt-submit.test.cjs`, `tests/hook-subprocess.test.cjs` |

## Task 1: Package Scaffold

**Invariant:** A clean checkout contains a valid native plugin whose commands
and bundled skill resolve only through package-relative paths.

- [x] Create `.codex-plugin/plugin.json` with version `0.1.0`, skill path
  `./skills/`, metadata, attribution, and no redundant hook field.
- [x] Create `hooks/hooks.json` with exact command paths based on
  `PLUGIN_ROOT`.
- [x] Register `SessionStart` for `startup|clear`; exclude `resume` and
  `compact` so repeated host lifecycle events cannot republish full context.
- [x] Register `UserPromptSubmit` without a matcher.
- [x] Add dependency-free `package.json`, Node `>=18`, MIT license, and the
  core test command.
- [x] Verify every declared file exists and both JSON documents parse.

Primary commits: `e9128e5`, `bae4140`, `965522f`.

## Task 2: Canonical Modes

**Invariant:** Every component shares one closed mode vocabulary.

- [x] Add canonical modes `off`, `lite`, `full`, `ultra`, `wenyan-lite`,
  `wenyan-full`, and `wenyan-ultra`.
- [x] Normalize case and surrounding whitespace.
- [x] Map alias `wenyan` to stored value `wenyan-full`.
- [x] Reject unknown and non-string values.
- [x] Cover every canonical value and alias in public tests.

Primary commit: `cf5908c`.

## Task 3: Resolve the Default Mode

**Invariant:** The first valid configured mode wins; unsafe or malformed
candidates never become hook context.

- [x] Resolve `CAVEMAN_DEFAULT_MODE` first.
- [x] Walk repository parents in bounded order, checking
  `.caveman/config.json` before `.caveman.json` at each level.
- [x] Check `~/.config/caveman/config.json` after repository configuration.
- [x] Fall back to `wenyan-full`.
- [x] Bound candidate files to 4096 bytes and traversal to 64 levels.
- [x] Read through one no-follow descriptor with fatal UTF-8 decoding.
- [x] Reject symbolic links, replacements, growth, truncation, metadata drift,
  short reads, invalid JSON, invalid modes, and close failures.
- [x] Preserve environment, repository, user, and fallback precedence under
  every failure case.

Primary commits: `30548ba`, `412738e`.

## Task 4: Store Per-Session State

**Invariant:** A hook either observes one validated session record, confirms it
is initially missing, or reports it unavailable without destructive guessing.

- [x] Derive a bounded filename from `sha256(session_id)`.
- [x] Store schema version, canonical mode, and normalized timestamp as bounded
  private JSON.
- [x] Expose only `read`, `initializeIfMissing`, and explicit `write`.
- [x] Distinguish `found`, confirmed `missing`, and `unavailable`.
- [x] Treat only initial canonical `ENOENT` as missing.
- [x] Validate safe roots, regular files, ownership, private mode, link count,
  stable descriptor/path identity, exact byte count, and fatal UTF-8.
- [x] Publish missing state without replacing a concurrent winner.
- [x] Use a separate atomic replacement path for explicit transitions.
- [x] Complete file and parent durability barriers before reporting success.
- [x] Preserve foreign or ambiguous temporary evidence.
- [x] Remove implicit expiry and age-based canonical record deletion.
- [x] Prove session isolation, concurrent initialization, race classification,
  cleanup ownership, and failure boundaries through public behavior.

Primary commits: `e5c242a`, `be3f708`, `1c95de2`.

## Task 5: Parse Explicit Mode Intent

**Invariant:** Exact commands and bounded imperatives change mode; questions,
negations, unknown modes, and incidental phrases do not.

- [x] Accept exact `/caveman` and `$caveman` commands with optional mode.
- [x] Map empty command arguments to the resolved default.
- [x] Accept exact off forms and finite English and Chinese activation forms.
- [x] Normalize all accepted values through the canonical mode module.
- [x] Bound inspected prompt bytes to 64 KiB.
- [x] Reject questions before imperative matching.
- [x] Reject negated requests before imperative matching.
- [x] Require the whole normalized prompt to match a supported grammar.
- [x] Prove unrelated uses of “normal mode” and descriptive caveman questions
  preserve state.

Primary commits: `d3c3aa6`, `939269f`.

## Task 6: Bundle and Render Rules

**Invariant:** Active context comes from the bundled skill and contains only the
selected intensity; invalid skill bytes never enter hook output.

- [x] Bundle `skills/caveman/SKILL.md` with six active intensities and
  auto-clarity rules.
- [x] Bound the skill to 128 KiB and frontmatter to 16 KiB.
- [x] Open without following symbolic links and prove stable regular-file
  identity around the descriptor read.
- [x] Decode UTF-8 fatally, normalize CRLF, and reject lone carriage returns.
- [x] Accept only exact `name: caveman` plus one nonempty `description` in a
  narrow frontmatter grammar.
- [x] Remove frontmatter before rendering.
- [x] Retain shared rules while filtering intensity rows and examples to the
  canonical active mode.
- [x] Emit a bounded built-in fallback if the skill cannot be validated.
- [x] Render `off` as an authoritative normal-prose reminder without active
  rules.
- [x] Provide full context for activation and first missing-state restoration,
  then short reminders for ordinary turns with validated state.

Primary commits: `173adba`, `2946f9e`, `d2dc82d`, `a4f041a`, `c346365`,
`4c90fe3`, `41679b1`.

## Task 7: Implement SessionStart

**Invariant:** Every supported start source selects the correct effective mode
without overwriting unavailable state or unrelated sessions.

- [x] Validate event object, exact hook name, bounded nonempty session ID,
  nonempty working directory, and supported source.
- [x] On `startup` and `clear`, select the configured default and explicitly
  replace only the addressed session record.
- [x] On `resume` and `compact`, restore validated state.
- [x] Initialize only confirmed missing state and honor a concurrent winner.
- [x] Fail unavailable passive state closed to `off` without writing.
- [x] Keep the selected default for the current turn when an explicit reset
  cannot persist.
- [x] Emit only fixed warnings for state failure.
- [x] Inject full active rules or the authoritative off reminder.
- [x] Preserve old unrelated record inode and bytes for all four sources.
- [x] Prove malformed and unsupported events are silent no-ops.

Primary commits: `84b61d3`, `aafadf4`, `eba55c4`.

## Task 8: Implement UserPromptSubmit

**Invariant:** Explicit mode changes persist atomically; ordinary prompts
reinforce current mode without accidental transitions or state clobbering.

- [x] Validate event object, exact hook name, bounded session ID, working
  directory, and prompt type.
- [x] Resolve default mode and parse intent through the shared modules.
- [x] Persist recognized transitions directly without relying on an old read.
- [x] Inject full rules and a one-line acknowledgement instruction after a
  transition.
- [x] On write failure, apply the explicit transition only to the current turn
  and emit the fixed warning.
- [x] For ordinary prompts, restore found state or initialize only confirmed
  missing state, injecting full active context or the authoritative `off`
  reminder once after that initialization.
- [x] Honor concurrent initialization winners, including `off`.
- [x] On unavailable passive state, render `off`, warn, and perform no write.
- [x] Reinforce active and off modes without rewriting valid state.
- [x] Prove active-to-off-to-active persistence across subprocess invocations.
- [x] Prove handlers never return prompt text, session ID, paths, state bytes,
  or exception details.

Primary commit: `5131028`.

## Hook I/O Completion

**Invariant:** Both executable hooks share one bounded and silent host boundary.

- [x] Read at most 1 MiB from stdin.
- [x] Reconstruct chunked UTF-8 and reject malformed or non-object JSON.
- [x] Serialize compact JSON only when a handler returns a result.
- [x] Exit zero with no output for invalid or unsupported input.
- [x] Contain handler and output-stream failures.
- [x] Keep stderr silent unless `CAVEMAN_DEBUG=1`, then emit only one fixed
  diagnostic line.
- [x] Use fixed `systemMessage` warnings with no user-controlled interpolation.

## Final Verification

Run from a clean checkout:

```bash
npm test
for file in hooks/*.cjs lib/*.cjs tests/*.test.cjs; do
  node --check "$file"
done
node -e "JSON.parse(require('node:fs').readFileSync('.codex-plugin/plugin.json')); JSON.parse(require('node:fs').readFileSync('hooks/hooks.json'))"
git diff --check
```

Required result:

- [x] 323 tests pass; zero failures, skips, or todos.
- [x] Every runtime and test CommonJS file passes syntax checking.
- [x] Manifest, hook registry, package paths, and bundled skill validate.
- [x] Actual packaged hook smoke covers startup, active transition, passive
  persistence, and off transition.
- [x] Markdown fences pair and Git whitespace checks pass.
- [x] Standards review: HIGH 0, MEDIUM 0, LOW 0.
- [x] Spec review: HIGH 0, MEDIUM 0, LOW 0.
- [x] Node `>=18` is sufficient for all core syntax and APIs.

## Completion State

All eight vertical slices and their hardening corrections are complete at
`412738e`. Caveman 0.1 has no pending core implementation task. Future changes
must begin with a new public-behavior invariant rather than reopening completed
historical RED/GREEN cycles.
