---
name: gitnexus-exploring
description: "Use when the user asks how code works, wants to understand architecture, trace execution flows, or explore unfamiliar parts of the codebase. Examples: \"How does X work?\", \"What calls this function?\", \"Show me the auth flow\""
---

# Exploring Codebases with GitNexus

> **Project binding:** pass `repo: "caveman"` on every repo-scoped MCP call.
> For `detect_changes`, also pass
> `worktree: "<absolute current worktree>"`, replacing the placeholder with the
> current `pwd -P` result.

## When to Use

- "How does authentication work?"
- "What's the project structure?"
- "Show me the main components"
- "Where is the database logic?"
- Understanding code you haven't seen before

## Workflow

```
1. READ gitnexus://repos                          → Discover indexed repos
2. READ gitnexus://repo/caveman/context                   → Overview and staleness
3. query({repo: "caveman", query: "<what to understand>"}) → Find related flows
4. context({repo: "caveman", name: "<symbol>"})             → Deep symbol view
5. READ gitnexus://repo/caveman/process/{name}             → Trace full flow
```

> If step 2 says "Index is stale" → run `node .gitnexus/run.cjs analyze --index-only` in
> terminal. If the runner would download/install anything, stop for explicit
> authorization and follow `gitnexus-cli`.

## Checklist

```
- [ ] READ gitnexus://repo/caveman/context
- [ ] query for the concept you want to understand
- [ ] Review returned processes (execution flows)
- [ ] context on key symbols for callers/callees
- [ ] READ process resource for full execution traces
- [ ] Read source files for implementation details
```

## Resources

| Resource                                | What you get                                            |
| --------------------------------------- | ------------------------------------------------------- |
| `gitnexus://repo/caveman/context`        | Stats, staleness warning (~150 tokens)                  |
| `gitnexus://repo/caveman/clusters`       | All functional areas with cohesion scores (~300 tokens) |
| `gitnexus://repo/caveman/cluster/{name}` | Area members with file paths (~500 tokens)              |
| `gitnexus://repo/caveman/process/{name}` | Step-by-step execution trace (~200 tokens)              |

## Tools

**query** — find execution flows related to a concept:

```
query({repo: "caveman", query: "payment processing"})
→ Processes: CheckoutFlow, RefundFlow, WebhookHandler
→ Symbols grouped by flow with file locations
```

**context** — 360-degree view of a symbol:

```
context({repo: "caveman", name: "validateUser"})
→ Incoming calls: loginHandler, apiMiddleware
→ Outgoing calls: checkToken, getUserById
→ Processes: LoginFlow (step 2/5), TokenRefresh (step 1/3)
```

## Example: "How does payment processing work?"

```
1. READ gitnexus://repo/caveman/context       → current symbols and processes
2. query({repo: "caveman", query: "payment processing"})
   → CheckoutFlow: processPayment → validateCard → chargeStripe
   → RefundFlow: initiateRefund → calculateRefund → processRefund
3. context({repo: "caveman", name: "processPayment"})
   → Incoming: checkoutHandler, webhookHandler
   → Outgoing: validateCard, chargeStripe, saveTransaction
4. Read src/payments/processor.ts for implementation details
```
