# git-rewind — Design & Spec

> Agent-agnostic, git-native per-turn worktree snapshots.
> A bun CLI any AI coding agent can call from its turn-end hook.

## 1. Motivation

AI agents edit files autonomously. Most of the time that's fine; occasionally an
agent (or a bad variable expansion in a subagent) clobbers work between backup
windows. We already run layered nets — a 15-min APFS local-snapshot LaunchAgent,
Time Machine, `dcg` blocking destructive commands, and git commit-often. This
fills the one remaining gap: **precise, per-turn, per-file recovery of the
working tree, diffable and scoped to exactly the files the agent touched** —
finer than a 15-min disk snapshot, and independent of whether anything was
committed.

The model is lifted from the Pi agent's `pi-rewind-hook` (snapshots as commits
reachable through a single hidden ref, dedup on tree SHA, ignored files
excluded). That extension is **Pi-only**. `git-rewind` reimplements the *storage
model* as a standalone CLI so **any** agent — Claude Code (`Stop` hook), Codex,
Gemini CLI, Cursor, a plain shell — can drive it. The agent integration is just
"run this command at turn end."

### Non-goals
- Not a replacement for git history, Time Machine, or the APFS snapshot job — a
  complementary layer.
- Not a per-*tool*/per-*save* recorder (that's noise). Per **turn** boundary only.
- No fancy restore TUI in v1 — restore is a CLI command; agent-native `/tree`-style
  UI is out of scope (that was Pi-specific).

## 2. Core invariant (the promise this tool makes)

> **A snapshot NEVER mutates the user's real git state.**
> Not the index, not `HEAD`, not any branch, not the stash, not the working tree.
> It only writes objects and moves its own ref under `refs/rewind/`.

If we ever violate that, the tool is worse than the problem it solves. Every
design choice below serves this invariant. The nightmare scenario: an agent's
turn-end hook silently stages files, or resets a branch, mid-session — corrupting
the very work it's meant to protect. That must be impossible by construction,
which is why capture uses a throwaway `GIT_INDEX_FILE` and only ever touches
`refs/rewind/*`.

## 3. Storage model

- **One ref per repo:** `refs/rewind/store`. Each snapshot is a commit whose tree
  is the exact worktree state; its parent is the previous snapshot commit — a
  linear chain. `git log refs/rewind/store` reads as a clean turn-by-turn history,
  invisible to `git log`, `git branch`, `git status`.
- **Objects live in the repo's own object store.** No sibling repo, no external DB.
  Reachable only via `refs/rewind/store` (+ `refs/rewind/undo`), so ordinary git
  ignores them but `git gc` won't reclaim them until pruned.
- **Metadata rides in the commit message** (git-native, portable across agents —
  there is no shared cross-agent session ledger, so the commit is authoritative):
  ```
  rewind: turn snapshot

  Rewind-Version: 1
  Rewind-Agent: claude          # claude | codex | gemini | shell | ...
  Rewind-Session: <session-id>  # if the hook can supply one
  Rewind-Boundary: turn-end     # turn-end | pre-prompt | manual
  Rewind-Time: 2026-07-15T11:12:39-04:00
  Rewind-Label: <optional>      # user/agent label for pinning
  ```
  `list --json` parses these trailers. Author/committer are set to a fixed
  `git-rewind <noreply@…>` identity so the user's `user.name`/`user.email` and
  signing config are never invoked.

### Why a single linear chain (not one-ref-per-snapshot, not reflog-only)
- **vs. one ref per snapshot** (`refs/rewind/snaps/<ts>`): trivial to prune (delete
  refs) but explodes the ref namespace (thousands of refs slow git). Rejected.
- **vs. reflog-only** (move `refs/rewind/store`, rely on its reflog for history):
  elegant and prunes via `reflog expire`, but reflog entries are fragile
  (`git gc`/tooling can drop them) and `@{n}` addressing is arcane. Kept as a
  possible alt, not the default.
- **Linear chain** mirrors `pi-rewind`, gives a real commit history to `log`/`diff`,
  and dedups naturally against the parent's tree. Pruning needs a re-root step
  (§7) — the one downside, and an acceptable one.

## 4. Snapshot algorithm (`git-rewind snapshot`)

The whole capture, with the core invariant enforced by construction:

```sh
REPO=$(git -C "$cwd" rev-parse --show-toplevel)          # bail if not a repo
GIT_DIR=$(git -C "$REPO" rev-parse --git-dir)
TMP_INDEX=$(mktemp "${TMPDIR:-/tmp}/git-rewind.idx.XXXXXX")
export GIT_INDEX_FILE="$TMP_INDEX"                         # throwaway; real index untouched

# Empty temp index + add -A => the tree is EXACTLY the current worktree,
# tracked + untracked, with .gitignore / .git/info/exclude / global excludes
# honored for free (ignored files excluded — no node_modules/dist/.env).
git -C "$REPO" add -A
TREE=$(git -C "$REPO" write-tree)
rm -f "$TMP_INDEX"

# Dedup: identical worktree tree as last snapshot => no-op.
PARENT=$(git -C "$REPO" rev-parse -q --verify refs/rewind/store || true)
if [ -n "$PARENT" ] && [ "$(git -C "$REPO" rev-parse "$PARENT^{tree}")" = "$TREE" ]; then
  exit 0
fi

COMMIT=$(printf '%s' "$MSG" | \
  GIT_AUTHOR_NAME=git-rewind  GIT_AUTHOR_EMAIL=noreply@git-rewind \
  GIT_COMMITTER_NAME=git-rewind GIT_COMMITTER_EMAIL=noreply@git-rewind \
  git -C "$REPO" commit-tree "$TREE" ${PARENT:+-p "$PARENT"})
git -C "$REPO" update-ref refs/rewind/store "$COMMIT" ${PARENT:+"$PARENT"}   # CAS on old value
```

Notes:
- **Deletions are captured correctly.** With a fresh empty index, a tracked file
  that was deleted in the worktree simply isn't added → absent from the tree →
  the snapshot reflects the true current state.
- **`update-ref` is compare-and-swap** (passes the expected old value) so two
  concurrent turn-end hooks can't lose a snapshot.
- **No `read-tree HEAD` needed** — empty index + `add -A` already yields the full
  worktree tree. Simpler and avoids depending on HEAD existing (works on an
  unborn branch / fresh repo too).
- Everything is plumbing (`add`/`write-tree`/`commit-tree`/`update-ref`) — no
  porcelain that could touch the real index/HEAD.

### Performance & the `--async` / dirty-gate story
Turn-end hooks should return fast (target < ~300 ms). On a big repo (beehiiv:
thousands of files) `git add -A` scans the worktree.
- **`--async`:** the CLI double-forks a detached child (own process group, stdio
  to a log) so the parent returns immediately; the agent can't kill it on turn
  completion. This is the recommended hook mode.
- **Dirty-gate (`--if-dirty`, default on):** a fast `git status --porcelain
  --untracked-files=normal` short-circuits to a no-op when nothing changed, so
  quiet turns cost ~one `status`.
- **fsmonitor:** if the repo has `core.fsmonitor` enabled, both `status` and
  `add -A` get near-instant; document as an opt-in speedup, don't require it.
- **Concurrency lock:** a per-repo lock (`$GIT_DIR/rewind.lock`, flock-style) so
  overlapping async snapshots serialize instead of racing.

## 5. Restore (`git-rewind restore <selector> [-- <paths…>]`)

Exact restore for the domain we own (tracked + untracked-non-ignored). Mirrors
`pi-rewind`'s delete-then-restore so the worktree matches the snapshot *exactly*,
without staging.

1. **Snapshot the current state first** as the undo point → write it and move
   `refs/rewind/undo` to it. (`git-rewind undo` restores this.)
2. Resolve `<selector>` → a snapshot commit (see §6 addressing).
3. **Full restore (no paths):**
   - Delete worktree paths present in the *current* snapshot but absent in the
     target (so removed-since files come back and added-since files go away).
   - Materialize the target tree into the worktree via a temp index:
     `GIT_INDEX_FILE=tmp git read-tree <target>` then `git checkout-index -a -f`.
   - Real index is never read or written.
4. **Path-scoped restore (`-- <paths>`):** only those paths are checked out from
   the target tree; deletions handled within the path set. Everything else
   untouched. This is the "undo just this file" path.

Restore explicitly does **not** cover: ignored files, empty directories, and it
does not attempt to restore the *staged index* (by design — staging is user state).

## 6. Snapshot addressing / selectors

`list` numbers snapshots newest-first; selectors accepted by `restore`/`diff`/`show`:
- `HEAD` / `0` / `latest` — most recent snapshot
- `1`, `2`, … — N snapshots back (walk `refs/rewind/store` parents)
- `@{turn:-3}` — sugar for 3 turns back
- a commit SHA (full/abbrev) on the rewind chain
- `label:<name>` — most recent snapshot whose `Rewind-Label` matches
- `undo` — the `refs/rewind/undo` point

## 7. Retention (`git-rewind prune`)

The chain is fully reachable → never auto-GC'd, so it grows unbounded (pi-rewind
flags the same). `prune` trims it:
- `--keep-last N` (default from config, recommend **200**) and/or
  `--max-age-days D` (recommend **30**).
- Mechanism: walk the chain, find the cutoff commit, **re-root** — rebuild the
  retained suffix so the oldest kept snapshot becomes parentless (re-`commit-tree`
  its tree with no parent, re-chain descendants), then `update-ref` the store to
  the new head and drop the old objects via `git gc` (the tool only expires its
  own ref; it never runs a destructive repo-wide gc without `--gc`).
- **Pinning:** snapshots with a `Rewind-Label` are exempt from age/count pruning
  when `pin_labeled = true` (config), so bookmarked points survive.
- Prune can run opportunistically (every Nth snapshot) or via a separate periodic
  invocation; default: piggyback a cheap count check on `snapshot` and prune when
  over budget.

## 8. Configuration

Global `~/.config/git-rewind/config.toml`, overridable per-repo via
`git config rewind.*` keys or a repo-local `.git-rewind.toml`:

```toml
ref            = "refs/rewind/store"   # ref namespace
async          = true                  # default snapshot mode for hooks
if_dirty       = true                  # skip when worktree clean
[retention]
keep_last      = 200
max_age_days   = 30
pin_labeled    = true
[repos]
# Opt-in model: only snapshot repos matching an allow entry. Empty allow = all.
allow          = []                    # e.g. ["~/Projects/beehiiv/*", "~/Projects/iamclaudia-ai/*"]
deny           = []                    # takes precedence over allow
max_worktree_files = 200000            # safety valve: skip absurdly large trees
```

Repo scoping resolves from `git rev-parse --show-toplevel` of the hook's cwd, so
one global hook covers every repo — no per-repo watcher to start (fixing the
gitwatch "one folder at a time" problem).

## 9. Command surface

| Command | Purpose |
|---|---|
| `git-rewind snapshot [--async] [--if-dirty] [--agent <a>] [--session <id>] [--label <l>] [--repo <path>] [--boundary turn-end\|pre-prompt\|manual]` | Capture the worktree (the hook's call) |
| `git-rewind list [--repo <path>] [--limit N] [--json]` | Recent snapshots: index, time, agent, session, label, #changed vs prev |
| `git-rewind show <selector>` | Metadata + changed-file summary for one snapshot |
| `git-rewind diff <selector> [-- <paths>]` | Diff worktree (or `--from <sel>`) against a snapshot |
| `git-rewind restore <selector> [-- <paths>]` | Restore worktree/paths (writes an undo point first) |
| `git-rewind undo` | Restore the pre-last-restore state (`refs/rewind/undo`) |
| `git-rewind prune [--keep-last N] [--max-age-days D] [--gc]` | Trim retention |
| `git-rewind status [--repo <path>]` | Store head, count, config in effect |
| `git-rewind install <claude\|codex\|gemini> [--boundary …]` | Write/patch that agent's hook config |
| `git-rewind uninstall <agent>` | Remove the hook config + optionally `refs/rewind/*` |

Global flags: `--json` (machine output for agents), `--quiet`, `--verbose`,
`--repo <path>` (override cwd resolution). Exit codes: `0` ok / no-op, non-zero
only on real error — a hook must never fail the turn.

## 10. Agent hook integration

Because it's a CLI, integration is "run at turn end." Two we care about:

### Claude Code — `Stop` hook (`~/.claude/settings.json`)
```json
{
  "hooks": {
    "Stop": [
      { "matcher": "", "hooks": [
        { "type": "command", "command": "git-rewind snapshot --async --agent claude" }
      ]}
    ]
  }
}
```
The hook runs with cwd = project dir and receives JSON on stdin (session_id, cwd,
etc.); `git-rewind` can read `--session` from that stdin payload when present.
Optionally add a `UserPromptSubmit` hook with `--boundary pre-prompt` for a
pre-turn baseline.

### Codex CLI
Wire the equivalent turn-end/notify hook to `git-rewind snapshot --async --agent
codex`. (Confirm Codex's current hook/notify surface during the build — it has
evolved; the CLI itself needs nothing Codex-specific.)

`git-rewind install claude` / `install codex` automate writing these blocks
idempotently.

## 11. Recommended defaults (confirm at build kickoff)

These encode my earlier recommendation; they're the starting posture, easy to flip:
1. **Boundary:** `Stop` / turn-end only to start (capture *after* edits — the risky
   moment). Add `pre-prompt` later if wanted.
2. **Mode:** `--async` + `--if-dirty` on, so hooks are ~free on quiet/big-repo turns.
3. **Scope:** opt-in `repos.allow` (start with beehiiv + iamclaudia-ai), not all-repos.
4. **Retention:** keep-last 200, max-age 30d, pin labeled. Manual git-based restore
   for v1; a `/rewind` helper skill can come later.

## 12. Open questions for the build session
- Session-id extraction: parse the agent's hook stdin JSON generically, or per-agent
  adapters? (Lean generic with best-effort keys.)
- Async detachment on macOS: double-fork vs `Bun.spawn({ … , detached })` — verify the
  child truly survives the agent reaping the hook process group.
- Prune re-root vs. switching to a reflog model — decide once we measure ref/gc behavior
  on a large repo with thousands of snapshots.
- Big-repo `add -A` latency budget on beehiiv — measure; consider `--untracked-files=no`
  fast path or fsmonitor requirement for huge repos.
- Test strategy: table-driven bun tests over throwaway temp repos exercising the core
  invariant (real index/HEAD/branch unchanged after snapshot/restore), dedup, deletion
  capture, ignored-file exclusion, path-scoped restore, and prune.
