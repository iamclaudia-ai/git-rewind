#!/usr/bin/env node
/**
 * git-rewind — agent-agnostic, git-native per-turn worktree snapshots.
 *
 * Core invariant every command must uphold (DESIGN.md §2):
 *   A snapshot NEVER mutates the user's real git state — not the index, not HEAD,
 *   not any branch, not the stash, not the worktree. Only objects + refs/rewind/*.
 */
import { parseArgs } from "./args.ts";
import { installCommand, uninstallCommand } from "./commands/install.ts";
import { listCommand, showCommand } from "./commands/list.ts";
import { restoreCommand, undoCommand } from "./commands/restore.ts";
import { snapshotCommand } from "./commands/snapshot.ts";
import { statusCommand } from "./commands/status.ts";
import { DEFAULTS } from "./config.ts";
import { type Command, commandHelp, isCommand, usage, wantsHelp } from "./help.ts";

/** Commands wired to real handlers; the rest are scaffolded stubs (exit 0). */
const IMPLEMENTED = new Set<Command>([
  "snapshot",
  "list",
  "show",
  "status",
  "restore",
  "undo",
  "install",
  "uninstall",
]);

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

  // `git-rewind help [<command>]`
  if (first === "help") {
    const topic = args[1];
    console.log(topic && isCommand(topic) ? commandHelp(topic) : usage());
    process.exit(0);
  }

  if (!isCommand(first)) {
    console.error(`git-rewind: unknown command '${first}'\n`);
    console.error(usage());
    process.exit(1);
  }

  const cmd = first;
  // Help must never run the command: `undo --help` used to perform an undo (#7).
  if (wantsHelp(args.slice(1))) {
    console.log(commandHelp(cmd));
    process.exit(0);
  }
  // `snapshot` treats --async/--if-dirty as booleans that default from config
  // (and support --no-*). Other commands take the usual value flags.
  const booleans = [
    "json",
    "quiet",
    "verbose",
    "async",
    "if-dirty",
    "gc",
    "stdin-session",
    "dry-run",
  ];
  const { positionals, flags, rest } = parseArgs(args.slice(1), booleans);

  try {
    switch (cmd) {
      case "snapshot":
        process.exit(snapshotCommand(flags, { async: DEFAULTS.async, ifDirty: DEFAULTS.ifDirty }));
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
      case "restore":
        process.exit(restoreCommand(positionals, flags, rest));
        break;
      case "undo":
        process.exit(undoCommand(flags));
        break;
      case "install":
        process.exit(installCommand(positionals, flags));
        break;
      case "uninstall":
        process.exit(uninstallCommand(positionals, flags));
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
