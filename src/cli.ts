#!/usr/bin/env bun
/**
 * git-rewind — agent-agnostic, git-native per-turn worktree snapshots.
 *
 * SCAFFOLD ONLY. This file defines the command surface and dispatch; the actual
 * git plumbing lives in the modules referenced by TODOs and is implemented in
 * the build session. See ../DESIGN.md for the full spec.
 *
 * Core invariant every command must uphold (DESIGN.md §2):
 *   A snapshot NEVER mutates the user's real git state — not the index, not HEAD,
 *   not any branch, not the stash, not the worktree. Only objects + refs/rewind/*.
 */

const COMMANDS = {
  snapshot: "Capture the current worktree into refs/rewind/store (the hook's call)",
  list: "List recent turn snapshots (newest first)",
  show: "Show metadata + changed-file summary for one snapshot",
  diff: "Diff worktree (or --from <sel>) against a snapshot",
  restore: "Restore worktree/paths to a snapshot (writes an undo point first)",
  undo: "Restore the pre-last-restore state (refs/rewind/undo)",
  prune: "Trim retention (keep-last / max-age, pin labeled)",
  status: "Show store head, snapshot count, effective config",
  install: "Write/patch an agent's turn-end hook config (claude|codex|gemini)",
  uninstall: "Remove an agent's hook config (and optionally refs/rewind/*)",
} as const;

type Command = keyof typeof COMMANDS;

function usage(): string {
  const rows = Object.entries(COMMANDS)
    .map(([name, desc]) => `  ${name.padEnd(10)} ${desc}`)
    .join("\n");
  return [
    "git-rewind — per-turn git worktree snapshots for AI agents",
    "",
    "USAGE",
    "  git-rewind <command> [options]",
    "",
    "COMMANDS",
    rows,
    "",
    "GLOBAL FLAGS",
    "  --repo <path>   Override repo resolution (default: cwd's toplevel)",
    "  --json          Machine-readable output (for agents)",
    "  --quiet         Suppress non-error output",
    "  --help          Show help",
    "",
    "See DESIGN.md for the full reference.",
  ].join("\n");
}

function notImplemented(cmd: Command): never {
  // Exit 0 so a hook NEVER fails the agent's turn (DESIGN.md §9). Real
  // implementations return non-zero only on genuine error.
  console.error(`git-rewind: '${cmd}' is scaffolded but not yet implemented — see DESIGN.md`);
  process.exit(0);
}

// TODO(build): replace notImplemented stubs with the real handlers.
//   snapshot  -> src/commands/snapshot.ts   (throwaway GIT_INDEX_FILE, add -A, write-tree,
//                                             tree-SHA dedup, commit-tree, CAS update-ref; --async, --if-dirty)
//   list/show -> src/commands/list.ts        (walk refs/rewind/store, parse Rewind-* trailers)
//   diff      -> src/commands/diff.ts
//   restore   -> src/commands/restore.ts     (undo point first; delete-then-restore via temp index; never stage)
//   undo      -> src/commands/undo.ts
//   prune     -> src/commands/prune.ts       (re-root chain to keep-last/max-age; pin labeled)
//   status    -> src/commands/status.ts
//   install   -> src/commands/install.ts     (idempotent hook-config patch per agent)
//   Shared:   src/git.ts (plumbing wrappers), src/config.ts (~/.config/git-rewind/config.toml),
//             src/repo.ts (resolve toplevel + allow/deny scoping), src/meta.ts (commit trailers).

function main(argv: string[]): void {
  const args = argv.slice(2);
  const first = args[0];

  if (!first || first === "--help" || first === "-h") {
    console.log(usage());
    process.exit(first ? 0 : 1);
  }

  if (!(first in COMMANDS)) {
    console.error(`git-rewind: unknown command '${first}'\n`);
    console.error(usage());
    process.exit(1);
  }

  notImplemented(first as Command);
}

main(process.argv);
