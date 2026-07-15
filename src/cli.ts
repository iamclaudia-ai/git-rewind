#!/usr/bin/env node
/**
 * git-rewind — agent-agnostic, git-native per-turn worktree snapshots.
 *
 * Core invariant every command must uphold (DESIGN.md §2):
 *   A snapshot NEVER mutates the user's real git state — not the index, not HEAD,
 *   not any branch, not the stash, not the worktree. Only objects + refs/rewind/*.
 */
import { parseArgs } from "./args.ts";
import { DEFAULTS } from "./config.ts";
import { listCommand, showCommand } from "./commands/list.ts";
import { snapshotCommand } from "./commands/snapshot.ts";
import { statusCommand } from "./commands/status.ts";

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

/** Commands wired to real handlers; the rest are scaffolded stubs (exit 0). */
const IMPLEMENTED = new Set<Command>(["snapshot", "list", "show", "status"]);

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
  // Exit 0 so a hook NEVER fails the agent's turn (DESIGN.md §9).
  console.error(`git-rewind: '${cmd}' is scaffolded but not yet implemented — see DESIGN.md`);
  process.exit(0);
}

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

  const cmd = first as Command;
  // `snapshot` treats --async/--if-dirty as booleans that default from config
  // (and support --no-*). Other commands take the usual value flags.
  const booleans = ["json", "quiet", "verbose", "async", "if-dirty", "gc"];
  const { positionals, flags } = parseArgs(args.slice(1), booleans);

  try {
    switch (cmd) {
      case "snapshot":
        process.exit(
          snapshotCommand(flags, { async: DEFAULTS.async, ifDirty: DEFAULTS.ifDirty }),
        );
        break;
      case "list":
        process.exit(listCommand(flags));
        break;
      case "show":
        process.exit(showCommand(positionals, flags));
        break;
      case "status":
        process.exit(statusCommand(flags));
        break;
      default:
        if (!IMPLEMENTED.has(cmd)) notImplemented(cmd);
    }
  } catch (err) {
    // snapshot must never fail a turn; other commands may surface real errors.
    const msg = err instanceof Error ? err.message : String(err);
    if (cmd === "snapshot") {
      console.error(`git-rewind: snapshot error (non-fatal): ${msg}`);
      process.exit(0);
    }
    console.error(`git-rewind: ${msg}`);
    process.exit(1);
  }
}

main(process.argv);
