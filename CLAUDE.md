# CLAUDE.md — git-rewind

Agent-agnostic, git-native per-turn worktree snapshots. A single **bun CLI** any
AI coding agent (Claude Code, Codex, Gemini CLI, Cursor, plain shell) drives from
its turn-end hook. **[DESIGN.md](./DESIGN.md) is the source of truth** for the
spec — read it before implementing any command.

## The one invariant (never violate)

> A snapshot **never** mutates the user's real git state — not the index, not
> `HEAD`, not any branch, not the stash, not the worktree. It only writes objects
> and moves its own `refs/rewind/*` ref.

Every command must uphold this. Capture uses a throwaway `GIT_INDEX_FILE` and only
ever touches `refs/rewind/store` (+ `refs/rewind/undo`). If a change could stage
files, move a branch, or reset `HEAD`, it's wrong by construction. See DESIGN.md §2.

## Storage model (DESIGN.md §3)

- One ref per repo: `refs/rewind/store` — a linear chain of commits, each tree is
  the exact worktree state, parent is the prior snapshot. Invisible to normal git.
- Objects live in the repo's own object store; reachable only via `refs/rewind/*`.
- Metadata rides in `Rewind-*` commit-message trailers (git-native, portable —
  the commit is authoritative; there's no cross-agent session ledger).
- Author/committer are a fixed `git-rewind <noreply@…>` identity so the user's
  `user.name`/`user.email` and signing config are never invoked.

## Tech stack

- **Runtime:** bun (`>=1.1.0`). TypeScript, ESM (`"type": "module"`).
- Entry/bin: `src/cli.ts` (currently scaffold-only — dispatch + usage).
- Tooling: `bun test`, `tsc --noEmit` (typecheck), `biome check` (lint),
  `bun build --compile` (single-binary build).

## Code layout (target — see the TODO map in `src/cli.ts`)

```
src/cli.ts              # arg parse + dispatch (scaffolded)
src/git.ts              # git plumbing wrappers (add/write-tree/commit-tree/update-ref)
src/config.ts           # ~/.config/git-rewind/config.toml + git config rewind.* overrides
src/repo.ts             # resolve toplevel + allow/deny repo scoping
src/meta.ts             # Rewind-* commit trailers (write/parse)
src/commands/*.ts       # one file per command: snapshot, list, diff, restore, undo, prune, status, install
```

## Command surface

`snapshot` · `list` · `show` · `diff` · `restore` · `undo` · `prune` · `status`
· `install` · `uninstall`. Full flags/semantics in DESIGN.md §9.

- Capture path (`snapshot`): throwaway index → `add -A` → `write-tree` →
  tree-SHA dedup vs parent → `commit-tree` → **CAS** `update-ref`. Flags
  `--async` (double-fork, detached) and `--if-dirty` (default on) keep hooks
  cheap. Prune opportunistically when over budget.
- Restore writes an **undo point** first, then delete-then-restore via a temp
  index for an exact match — never stages.

## Conventions

- **Exit codes:** `0` = ok / no-op, non-zero **only** on genuine error. A hook
  must never fail the agent's turn — scaffolded stubs exit 0 deliberately.
- **`--json`** on every command for machine/agent consumption.
- Prefer git **plumbing** (`add`/`write-tree`/`commit-tree`/`update-ref`/
  `read-tree`/`checkout-index`) over porcelain that could touch the real index/HEAD.
- Package manager is **bun**; don't introduce npm/pnpm lockfiles (see `.gitignore`).
- Conventional-commits for messages. Commit locally and often. Never push to
  remote without explicit request.

## Testing (DESIGN.md §12)

Table-driven bun tests over throwaway temp repos. The non-negotiable assertion:
after any `snapshot`/`restore`, the real index / `HEAD` / current branch / stash
are byte-for-byte unchanged. Also cover: tree-SHA dedup, deletion capture,
ignored-file exclusion, path-scoped restore, and prune re-rooting.

## Status

🚧 Design complete; implementation in progress. `src/cli.ts` is scaffolded, real
handlers land per the TODO map. Publishing to npm as `git-rewind`.
