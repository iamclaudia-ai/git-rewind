# git-rewind

**Agent-agnostic, git-native per-turn worktree snapshots.**

`git-rewind` captures your repository's working-tree state into a hidden git ref
(`refs/rewind/store`) at every agent turn — tracked *and* untracked files,
ignored files excluded — without ever touching your index, `HEAD`, branches, or
stash. When an AI agent (or a stray `rm`) clobbers your work, you restore any
turn, whole or per-file.

It's a single **bun CLI**, so *any* coding agent that can run a shell command at
turn end can use it — Claude Code, Codex, Gemini CLI, Cursor, or a plain shell.

> Inspired by the Pi agent's `pi-rewind-hook`, which is Pi-only. This reimplements
> its storage model (single ref, tree-SHA dedup, ignored-file exclusion) as a
> portable CLI. See [DESIGN.md](./DESIGN.md) for the full spec.

## The one promise

> A snapshot **never** mutates your real git state — not the index, not `HEAD`,
> not any branch, not the stash, not the worktree. It only writes objects and
> moves its own `refs/rewind/*` ref.

## Install

```bash
bun install -g git-rewind        # (once published)
# or from source:
git clone … && cd git-rewind && bun link
```

## Quick start

```bash
git-rewind install claude        # wire the Claude Code Stop hook
# …work with your agent as usual; every turn is snapshotted…

git-rewind list                  # see recent turn snapshots
git-rewind diff 1                # what changed since 1 turn ago
git-rewind restore 3 -- src/foo.ts   # undo just this file to 3 turns back
git-rewind undo                  # oops — revert that restore
```

## How it works (30 seconds)

- Each turn, the hook runs `git-rewind snapshot`. Using a **throwaway index**, it
  builds a tree of the exact worktree (`git add -A` honors `.gitignore`), and if
  that tree differs from the last snapshot, commits it onto `refs/rewind/store`
  with the previous snapshot as parent.
- The result is a clean, dedup'd, turn-by-turn history you can `log`, `diff`, and
  `restore` — living entirely inside your repo, invisible to normal git.
- Restore writes an **undo point** first, then materializes the target tree into
  the worktree (delete-then-restore for an exact match), still never staging.

## Wiring into agents

**Claude Code** (`~/.claude/settings.json`):
```json
{ "hooks": { "Stop": [ { "matcher": "", "hooks": [
  { "type": "command", "command": "git-rewind snapshot --async --agent claude" }
] } ] } }
```

**Codex / others:** point the agent's turn-end hook at
`git-rewind snapshot --async --agent <name>`. `git-rewind install <agent>` writes
the config for you.

Snapshots are `--async` (return instantly) and skip clean turns, so hooks stay
cheap even on large repos.

## Commands

`snapshot` · `list` · `show` · `diff` · `restore` · `undo` · `prune` · `status`
· `install` · `uninstall`. Run `git-rewind <cmd> --help`. Full reference in
[DESIGN.md](./DESIGN.md).

## Status

🌿 **Capture, inspect, and recover are live.** `snapshot` (sync + `--async`,
`--if-dirty`, tree-SHA dedup, fixed identity, CAS ref update), `list`, `show`,
`status`, `restore` (full + path-scoped, undo-point-first, delete-then-restore),
and `undo` (toggles redo) are implemented and covered by a 19-case suite proving
the invariants — the real index/HEAD/branch and ignored files are provably
untouched, and full restore reproduces the target worktree tree exactly.
`diff` · `prune` · `install` are next. The spec in [DESIGN.md](./DESIGN.md)
remains the source of truth.

## License

MIT © iamclaudia-ai
