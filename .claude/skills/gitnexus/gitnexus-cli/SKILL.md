---
name: gitnexus-cli
description: "Use when the user needs to run GitNexus CLI commands like analyze/index a repo, check status, clean the index, generate a wiki, or list indexed repos. Examples: \"Index this repo\", \"Reanalyze the codebase\", \"Generate a wiki\""
---

# GitNexus CLI Commands

> **Project binding:** repo-scoped MCP follow-ups must pass
> `repo: "caveman"`; `detect_changes` must also pass the absolute current
> worktree obtained from `pwd -P`.

Commands below use `node .gitnexus/run.cjs <command>` — the project-local
runner `gitnexus analyze` drops next to the index. It selects an available
runner at call time (global `gitnexus`, else package-manager fallback). A
fallback can require a network download, so command authorization never implies
download or installation authorization.

> **Missing runner or dependency?** Stop and ask for explicit user approval
> before any network access, package download, lifecycle build, or installation.
> After approval, use a reviewed, pinned GitNexus version and state its scope;
> never silently select `latest` or install globally. npm 11 failure context is
> tracked in [GitNexus #1939](https://github.com/abhigyanpatwari/GitNexus/issues/1939),
> but a workaround still requires a fresh approval.

`status` and `list` are read-only. `analyze` writes the ignored local index and
project guidance. In this project, routine refreshes must use `--index-only`:
plain `analyze` replaces the generated AGENTS/CLAUDE block and all six standard
GitNexus skills, destroying reviewed project-specific constraints. Run plain
`analyze` only on an explicit guidance-regeneration request followed by a full
guidance review. `clean` is destructive. `wiki` can make paid/networked LLM
calls, handle secrets, and optionally publish externally. Apply the command-
specific authorization rules below; never infer broader authority from a
request for another command.

## Commands

### analyze — Build or refresh the index

```bash
node .gitnexus/run.cjs analyze --index-only
```

Run from the project root. This parses source files, refreshes the graph in
`.gitnexus/`, and preserves the reviewed tracked guidance. Without
`--index-only`, GitNexus also regenerates CLAUDE.md / AGENTS.md and the six
standard skill files.

| Flag           | Effect                                                           |
| -------------- | ---------------------------------------------------------------- |
| `--force`      | Force full re-index even if up to date                           |
| `--index-only` | Refresh only the index; preserve reviewed project guidance       |
| `--skip-agents-md` | Preserve AGENTS/CLAUDE generated blocks                      |
| `--skip-skills` | Preserve installed standard skill files                         |
| `--embeddings` | Enable embedding generation for semantic search (off by default) |
| `--drop-embeddings` | Drop existing embeddings on rebuild. By default, an `analyze` without `--embeddings` preserves them. |

**When to run:** First time in a project, after major code changes, or when
`gitnexus://repo/caveman/context` reports the index is stale. Prefer the single
`--index-only` guard; if it is unavailable, both `--skip-agents-md` and
`--skip-skills` are required to preserve all eight reviewed files. In Claude
Code, a PostToolUse hook detects staleness after `git commit` and `git merge`
and notifies the agent to run `analyze` — the hook does not run analyze itself,
to avoid blocking the agent for up to 120s and risking KuzuDB corruption on
timeout.

### status — Check index freshness

```bash
node .gitnexus/run.cjs status
```

Shows whether the current repo has a GitNexus index, when it was last updated, and symbol/relationship counts. Use this to check if re-indexing is needed.

### clean — Delete the index

```bash
node .gitnexus/run.cjs clean
```

Deletes the `.gitnexus/` directory and unregisters the repo from the global registry. Use before re-indexing if the index is corrupt or after removing GitNexus from a project.

Run `clean` only when the user explicitly authorizes deletion of this repo's
index. `--force` requires consent to bypass confirmation. `--all` requires a
separate, explicit registry-wide deletion request after listing the affected
repos; permission to clean one repo never authorizes it.

| Flag      | Effect                                            |
| --------- | ------------------------------------------------- |
| `--force` | Skip confirmation prompt                          |
| `--all`   | Clean all indexed repos, not just the current one |

### wiki — Generate documentation from the graph

```bash
node .gitnexus/run.cjs wiki
```

Generates repository documentation from the knowledge graph using an LLM. Requires an API key (saved to `~/.gitnexus/config.json` on first use).

Run `wiki` only on an explicit request that authorizes its external LLM calls
and possible cost. Never place a literal API key in chat, logs, a committed
file, or a command line visible in shell history/process listings; use an
approved secret channel and redact all output. `--gist` publishes publicly and
requires a distinct confirmation immediately before publication after a secret
and sensitive-content review.

| Flag                | Effect                                    |
| ------------------- | ----------------------------------------- |
| `--force`           | Force full regeneration                   |
| `--model <model>`   | LLM model (default: minimax/minimax-m2.5) |
| `--base-url <url>`  | LLM API base URL                          |
| `--api-key <key>`   | LLM API key; use only through an approved secret-safe channel |
| `--concurrency <n>` | Parallel LLM calls (default: 3)           |
| `--gist`            | Publish wiki as a public GitHub Gist; separately confirm first |

### list — Show all indexed repos

```bash
node .gitnexus/run.cjs list
```

Lists all repositories registered in `~/.gitnexus/registry.json`. The MCP `list_repos` tool provides the same information.

## After Indexing

1. **Read `gitnexus://repo/caveman/context`** to verify the index loaded
2. Use the other GitNexus skills (`exploring`, `debugging`, `impact-analysis`, `refactoring`) for your task

## Troubleshooting

- **"Not inside a git repository"**: Run from a directory inside a git repo
- **Index is stale after re-analyzing**: Restart Claude Code to reload the MCP server
- **Embeddings slow**: Omit `--embeddings` (it's off by default), or use an approved secret channel for `OPENAI_API_KEY`; never print or commit it
