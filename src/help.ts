/**
 * Usage text: the global overview and one page per command.
 *
 * `--help` / `-h` anywhere before a literal `--` prints help and exits 0
 * without running the command (cli.ts checks before dispatching), so
 * `git-rewind undo --help` is always safe.
 */

export const COMMANDS = {
  snapshot: "Capture the current worktree into refs/rewind/store (the hook's call)",
  list: "List recent turn snapshots (newest first)",
  show: "Show metadata + changed-file summary for one snapshot",
  diff: "Diff worktree (or --from <sel>) against a snapshot",
  restore: "Restore worktree/paths to a snapshot (writes an undo point first)",
  undo: "Restore the pre-last-restore state (refs/rewind/undo)",
  prune: "Trim retention (keep-last / max-age, pin labeled)",
  status: "Show store head, snapshot count, effective config",
  install: "Write/patch an agent's turn-end hook config (claude|codex|gemini)",
  uninstall: "Remove git-rewind's hook from an agent's config",
} as const;

export type Command = keyof typeof COMMANDS;

export function isCommand(name: string): name is Command {
  return Object.hasOwn(COMMANDS, name);
}

/** True when `--help` or `-h` appears before a literal `--` (after it, they're paths). */
export function wantsHelp(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === "--help" || arg === "-h") return true;
  }
  return false;
}

const GLOBAL_FLAGS = [
  "  --repo <path>   Override repo resolution (default: cwd's toplevel)",
  "  --json          Machine-readable output (for agents)",
  "  --quiet         Suppress non-error output",
  "  --help, -h      Show help (never runs the command)",
];

const SELECTORS = [
  "SELECTORS",
  "  latest | HEAD | 0   most recent snapshot",
  "  1, 2, …             N snapshots back",
  "  @{turn:-N}          same as N",
  "  <sha>               a commit on the chain (full or abbreviated)",
  "  label:<name>        most recent snapshot with that label",
  "  undo                the undo point the last restore wrote",
];

export function usage(): string {
  const rows = Object.entries(COMMANDS)
    .map(([name, desc]) => `  ${name.padEnd(10)} ${desc}`)
    .join("\n");
  return [
    "git-rewind — per-turn git worktree snapshots for AI agents",
    "",
    "USAGE",
    "  git-rewind <command> [options]",
    "  git-rewind <command> --help",
    "",
    "COMMANDS",
    rows,
    "",
    "GLOBAL FLAGS",
    ...GLOBAL_FLAGS,
    "",
    "See DESIGN.md for the full reference.",
  ].join("\n");
}

interface Page {
  usage: string;
  about: string[];
  options?: string[];
  extra?: string[];
  implemented?: boolean;
  /** Settings-file commands: no repo involved, no JSON output. */
  noRepo?: boolean;
}

const PAGES: Record<Command, Page> = {
  snapshot: {
    usage: "git-rewind snapshot [options]",
    about: [
      "Capture the exact worktree (tracked + untracked, honoring .gitignore) onto",
      "refs/rewind/store. This is what agent hooks run. It never touches your index,",
      "HEAD, branches or stash, and always exits 0 so a hook can't fail a turn.",
    ],
    options: [
      "  --async, --no-async        Capture in a detached child and return at once (default: on)",
      "  --if-dirty, --no-if-dirty  Skip when the worktree matches HEAD (default: on)",
      "  --agent <name>             Agent that took it: claude, codex, gemini, … (default: shell)",
      "  --session <id>             Agent session id to record",
      "  --stdin-session            Read the session id from the hook's JSON on stdin",
      "  --label <name>             Name it, to select later with label:<name>",
      "  --boundary <b>             turn-end (default) | pre-prompt | manual",
      "  --verbose                  Report the result on stderr",
    ],
  },
  list: {
    usage: "git-rewind list [--limit N]",
    about: ["List snapshots newest first: index, sha, time, files changed, agent and label."],
    options: ["  --limit N    How many to show (default: 20; 0 = all)"],
  },
  show: {
    usage: "git-rewind show [<selector>]",
    about: ["Show one snapshot's metadata and changed-file summary (default: latest)."],
    extra: SELECTORS,
  },
  diff: {
    usage: "git-rewind diff <selector> [--from <selector>] [-- <paths>]",
    about: ["Diff the worktree (or another snapshot, with --from) against a snapshot."],
    extra: SELECTORS,
    implemented: false,
  },
  restore: {
    usage: "git-rewind restore <selector> [-- <paths>]",
    about: [
      "Make the worktree (or just <paths>) match a snapshot exactly: files are",
      "rewritten, and files the snapshot doesn't have are removed (ignored files are",
      "left alone). It writes an undo point first, so `git-rewind undo` reverses it.",
      "It never stages anything.",
    ],
    options: ["  --verbose    Report more detail"],
    extra: SELECTORS,
  },
  undo: {
    usage: "git-rewind undo",
    about: [
      "Reverse the last restore by restoring the undo point it wrote. Undo writes",
      "its own undo point, so running it again redoes the restore.",
    ],
  },
  prune: {
    usage: "git-rewind prune [--keep-last N] [--max-age-days D] [--gc]",
    about: ["Trim old snapshots, keeping labeled ones."],
    implemented: false,
  },
  status: {
    usage: "git-rewind status",
    about: ["Show the store head, snapshot count and the config in effect."],
  },
  install: {
    usage: "git-rewind install <claude|codex|gemini> [options]",
    about: [
      "claude: add a Stop hook running `git-rewind snapshot` to Claude Code's",
      "settings, next to any hooks already there. Running it again changes nothing.",
      "codex, gemini: print the command to add to that agent's turn-end hook.",
    ],
    options: [
      "  --settings <path>        Settings file (default: ~/.claude/settings.json)",
      "  --boundary pre-prompt    Also add a UserPromptSubmit hook (a pre-turn baseline)",
      "  --command <cmd>          Hook command to write instead of the default",
      "  --dry-run                Print the resulting settings without writing them",
    ],
    noRepo: true,
  },
  uninstall: {
    usage: "git-rewind uninstall <claude|codex|gemini> [options]",
    about: [
      "claude: remove git-rewind's Stop and UserPromptSubmit hooks, leaving",
      "every other hook and setting alone. Snapshots in refs/rewind/* are kept.",
    ],
    options: [
      "  --settings <path>    Settings file (default: ~/.claude/settings.json)",
      "  --dry-run            Print the resulting settings without writing them",
    ],
    noRepo: true,
  },
};

export function commandHelp(cmd: Command): string {
  const page = PAGES[cmd];
  const lines = [`git-rewind ${cmd} — ${COMMANDS[cmd]}`];
  if (page.implemented === false) lines.push("", "(Not implemented yet: see DESIGN.md.)");
  lines.push("", "USAGE", `  ${page.usage}`, "", ...page.about);
  if (page.options) lines.push("", "OPTIONS", ...page.options);
  if (page.extra) lines.push("", ...page.extra);
  const globals = page.noRepo
    ? GLOBAL_FLAGS.filter((f) => !f.includes("--repo") && !f.includes("--json"))
    : GLOBAL_FLAGS;
  lines.push("", "GLOBAL FLAGS", ...globals);
  return lines.join("\n");
}
