---
name: gitnexus-impact-analysis
description: "Use when the user wants to know what will break if they change something, or needs safety analysis before editing code. Examples: \"Is it safe to change X?\", \"What depends on this?\", \"What will break?\""
---

# Impact Analysis with GitNexus

> **Project binding:** pass `repo: "caveman"` on every repo-scoped MCP call.
> For `detect_changes`, also pass
> `worktree: "<absolute current worktree>"`, replacing the placeholder with the
> current `pwd -P` result.

## When to Use

- "Is it safe to change this function?"
- "What will break if I modify X?"
- "Show me the blast radius"
- "Who uses this code?"
- Before making non-trivial code changes
- Before committing — to understand what your changes affect

## Workflow

```
1. impact({repo: "caveman", target: "X", direction: "upstream"})  → What depends on this
2. READ gitnexus://repo/caveman/processes                   → Check affected execution flows
3. detect_changes({repo: "caveman", worktree: "<absolute current worktree>", scope: "all"}) → Map current changes
4. Assess risk and report to user
```

> If "Index is stale" → run `node .gitnexus/run.cjs analyze --index-only` in terminal. If
> the runner would download/install anything, stop for explicit authorization
> and follow `gitnexus-cli`.

## Checklist

```
- [ ] impact({repo: "caveman", target, direction: "upstream"}) to find dependents
- [ ] Review d=1 items first; treat the tool's WILL BREAK label as structural triage, then verify the proposed edit
- [ ] Check high-confidence (>=0.8) dependencies
- [ ] READ processes to check affected execution flows
- [ ] detect_changes({repo: "caveman", worktree: "<absolute current worktree>", scope: "staged"}) for pre-commit check
- [ ] Assess risk level and report to user
```

## Understanding Output

| Depth | Tool triage label | Structural meaning |
| ----- | ----------------- | ------------------ |
| d=1   | WILL BREAK        | Direct callers/importers; inspect first |
| d=2   | LIKELY AFFECTED   | Indirect dependencies |
| d=3   | MAY NEED TESTING  | Transitive dependencies |

Depth and edge confidence describe graph distance and resolution confidence,
not the semantic safety of a particular edit. A compatible change may not
break a direct caller; a dynamic dependency may be absent from the graph.

## Risk Assessment

Use the `risk` returned by the current `impact` or `detect_changes` response as
the authoritative GitNexus classification. Report it verbatim with direct
callers and affected processes. Do not recalculate risk from a local symbol-
count threshold; domain criticality is a separate human assessment and must be
reported separately.

## Tools

**impact** — the primary tool for symbol blast radius:

```
impact({
  repo: "caveman",
  target: "validateUser",
  direction: "upstream",
  minConfidence: 0.8,
  maxDepth: 3
})

→ d=1 (WILL BREAK):
  - loginHandler (src/auth/login.ts:42) [CALLS, 100%]
  - apiMiddleware (src/api/middleware.ts:15) [CALLS, 100%]

→ d=2 (LIKELY AFFECTED):
  - authRouter (src/routes/auth.ts:22) [CALLS, 95%]
```

**detect_changes** — git-diff based impact analysis:

```
detect_changes({repo: "caveman", worktree: "<absolute current worktree>", scope: "staged"})

→ Changed: 5 symbols in 3 files
→ Affected: LoginFlow, TokenRefresh, APIMiddlewarePipeline
→ Risk: MEDIUM
```

## Example: "What breaks if I change validateUser?"

```
1. impact({repo: "caveman", target: "validateUser", direction: "upstream"})
   → d=1: loginHandler, apiMiddleware (WILL BREAK)
   → d=2: authRouter, sessionManager (LIKELY AFFECTED)

2. READ gitnexus://repo/caveman/processes
   → LoginFlow and TokenRefresh touch validateUser

3. Report the exact tool-returned risk plus 2 direct callers and 2 processes;
   do not derive a replacement risk from those counts
```
