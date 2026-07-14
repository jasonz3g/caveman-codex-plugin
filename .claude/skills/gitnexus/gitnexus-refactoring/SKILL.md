---
name: gitnexus-refactoring
description: "Use when the user wants to rename, extract, split, move, or restructure code safely. Examples: \"Rename this function\", \"Extract this into a module\", \"Refactor this class\", \"Move this to a separate file\""
---

# Refactoring with GitNexus

> **Project binding:** pass `repo: "caveman"` on every repo-scoped MCP call.
> For `detect_changes`, also pass
> `worktree: "<absolute current worktree>"`, replacing the placeholder with the
> current `pwd -P` result.

## When to Use

- "Rename this function safely"
- "Extract this into a module"
- "Split this service"
- "Move this to a new file"
- Any task involving renaming, extracting, splitting, or restructuring code

## Workflow

```
1. impact({repo: "caveman", target: "X", direction: "upstream"}) → Map dependents
2. query({repo: "caveman", query: "X"})                          → Find execution flows
3. context({repo: "caveman", name: "X"})                         → See all refs
4. Select one vertical behavior slice and run/write its focused test first
5. Genuine missing behavior: RED → minimum interface/implementation/one-caller GREEN
6. Already-green behavior: record characterization; never fabricate RED
7. Refactor and rerun focused tests before advancing to the next slice
```

> If "Index is stale" → run `node .gitnexus/run.cjs analyze --index-only` in terminal. If
> the runner would download/install anything, stop for explicit authorization
> and follow `gitnexus-cli`.

## Checklists

### Rename Symbol

A pure behavior-preserving rename normally starts from existing green
characterization; do not manufacture a failing assertion. If the rename also
changes behavior, split that behavior into a separate RED/GREEN slice first.

```
- [ ] Run the smallest existing characterization test for the public seam
- [ ] rename({repo: "caveman", symbol_name: "oldName", new_name: "newName", dry_run: true}) — preview all edits
- [ ] Review graph edits (high confidence) and text_search edits (review carefully)
- [ ] If satisfied: rename({repo: "caveman", ..., dry_run: false}) — apply edits
- [ ] detect_changes({repo: "caveman", worktree: "<absolute current worktree>", scope: "all"}) — verify only expected files changed
- [ ] Run tests for affected processes
```

### Extract Module

```
- [ ] Choose one public behavior/caller as the vertical slice
- [ ] Run or write its focused test first: genuine gap must fail RED; existing coverage is recorded green characterization
- [ ] context({repo: "caveman", name: target}) — see all incoming/outgoing refs
- [ ] impact({repo: "caveman", target, direction: "upstream"}) — find all external callers
- [ ] Add only the interface, implementation, and one caller needed for minimum GREEN
- [ ] Rerun the focused test; then advance one caller/slice at a time
- [ ] detect_changes({repo: "caveman", worktree: "<absolute current worktree>", scope: "all"}) — verify affected scope
- [ ] Run tests for affected processes
```

### Split Function/Service

```
- [ ] Choose one public behavior/caller as the vertical slice
- [ ] Run or write its focused test first: genuine gap must fail RED; existing coverage is recorded green characterization
- [ ] context({repo: "caveman", name: target}) — understand all callees
- [ ] Group callees by responsibility
- [ ] impact({repo: "caveman", target, direction: "upstream"}) — map callers to update
- [ ] Create only the function/service and one caller needed for minimum GREEN
- [ ] Rerun the focused test; then advance one caller/slice at a time
- [ ] detect_changes({repo: "caveman", worktree: "<absolute current worktree>", scope: "all"}) — verify affected scope
- [ ] Run tests for affected processes
```

## Tools

**rename** — automated multi-file rename:

```
rename({repo: "caveman", symbol_name: "validateUser", new_name: "authenticateUser", dry_run: true})
→ 12 edits across 8 files
→ 10 graph edits (high confidence), 2 text_search edits (review)
→ Changes: [{file_path, edits: [{line, old_text, new_text, confidence}]}]
```

**impact** — map all dependents first:

```
impact({repo: "caveman", target: "validateUser", direction: "upstream"})
→ d=1: loginHandler, apiMiddleware, testUtils
→ Affected Processes: LoginFlow, TokenRefresh
```

**detect_changes** — verify your changes after refactoring:

```
detect_changes({repo: "caveman", worktree: "<absolute current worktree>", scope: "all"})
→ Changed: 8 files, 12 symbols
→ Affected processes: LoginFlow, TokenRefresh
→ Risk: MEDIUM
```

**cypher** — custom reference queries:

```cypher
MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(f:Function {name: "validateUser"})
RETURN caller.name, caller.filePath ORDER BY caller.filePath
```

## Risk Rules

| Risk Factor         | Mitigation                                |
| ------------------- | ----------------------------------------- |
| Many callers (>5)   | Use rename for automated updates |
| Cross-area refs     | Use detect_changes after to verify scope  |
| String/dynamic refs | query to find them               |
| External/public API | Version and deprecate properly            |

## Example: Rename `validateUser` to `authenticateUser`

```
1. rename({repo: "caveman", symbol_name: "validateUser", new_name: "authenticateUser", dry_run: true})
   → 12 edits: 10 graph (safe), 2 text_search (review)
   → Files: validator.ts, login.ts, middleware.ts, config.json...

2. Review text_search edits (config.json: dynamic reference!)

3. rename({repo: "caveman", symbol_name: "validateUser", new_name: "authenticateUser", dry_run: false})
   → Applied 12 edits across 8 files

4. detect_changes({repo: "caveman", worktree: "<absolute current worktree>", scope: "all"})
   → Affected: LoginFlow, TokenRefresh
   → Risk: MEDIUM — run tests for these flows
```
