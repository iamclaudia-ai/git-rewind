# git-rewind

**Agent-agnostic, git-native per-turn worktree snapshots.**

`git-rewind` captures your repository's working-tree state into a hidden git ref
(`refs/rewind/store`) at every agent turn — tracked _and_ untracked files,
ignored files excluded — without ever touching your index, `HEAD`, branches, or
stash. When an AI agent (or a stray `rm`) clobbers your work, you restore any
turn, whole or per-file.

It's a single **bun CLI**, so _any_ coding agent that can run a shell command at
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
npm install -g git-rewind        # or: bun add -g git-rewind
# or from source:
git clone https://github.com/iamclaudia-ai/git-rewind && cd git-rewind && bun install && bun link
```

## Quick start

```bash
git-rewind install claude        # wire the Claude Code Stop hook
# …work with your agent as usual; every turn is snapshotted…

git-rewind list                  # see recent turn snapshots
git-rewind show 1                # what changed in the snapshot 1 turn ago
git-rewind restore 3 -- src/foo.ts   # undo just this file to 3 turns back
git-rewind undo                  # oops — revert that restore
```

## How it works (30 seconds)

- Each turn, the hook runs `git-rewind snapshot`. Using a **throwaway index**, it
  builds a tree of the exact worktree (`git add -A` honors `.gitignore`), and if
  that tree differs from the last snapshot, commits it onto `refs/rewind/store`
  with the previous snapshot as parent.
- The result is a clean, dedup'd, turn-by-turn history you can `list`, `show`, and
  `restore` — living entirely inside your repo, invisible to normal git.
- Restore writes an **undo point** first, then materializes the target tree into
  the worktree (delete-then-restore for an exact match), still never staging.

## Wiring into agents

**Claude Code** (`~/.claude/settings.json`):

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "git-rewind snapshot --async --agent claude --stdin-session"
          }
        ]
      }
    ]
  }
}
```

`git-rewind install claude` writes exactly this for you, alongside any hooks you
already have. `--stdin-session` reads the session id from the JSON Claude Code
pipes to the hook, so each snapshot records which session made it.

**Codex / Gemini / others:** point the agent's turn-end hook at
`git-rewind snapshot --async --agent <name>`. `git-rewind install codex` (or
`gemini`) prints the exact command to point it at; it doesn't edit those agents'
config files yet.

Snapshots are `--async` (return instantly) and skip clean turns, so hooks stay
cheap even on large repos.

## Commands

`snapshot` · `list` · `show` · `diff` · `restore` · `undo` · `prune` · `status`
· `install` · `uninstall`. `git-rewind --help` lists them, and `git-rewind <cmd>
--help` (or `git-rewind help <cmd>`) shows a command's flags without running it.
Full reference in [DESIGN.md](./DESIGN.md).

## Status

🌿 **Usable end-to-end.** `snapshot` (sync + `--async`, `--if-dirty`, tree-SHA
dedup, fixed identity, CAS ref update, session-from-stdin), `list`, `show`,
`status`, `restore` (full + path-scoped, undo-point-first, delete-then-restore),
`undo` (toggles redo), and `install`/`uninstall` (idempotent Claude `Stop`-hook
wiring) are implemented and covered by a test suite proving the invariants —
the real index/HEAD/branch and ignored files are provably untouched, and full
restore reproduces the target worktree tree exactly. `diff` and `prune` are the
remaining pieces. The spec in [DESIGN.md](./DESIGN.md) remains the source of truth.

## Turn it on (Claude Code)

```bash
git-rewind install claude        # idempotently adds the Stop hook
# every dirty turn is now snapshotted, hands-free
git-rewind uninstall claude      # remove it
```

## License

MIT © iamclaudia-ai
