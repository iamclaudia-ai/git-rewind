/**
 * `git-rewind install <agent>` / `uninstall <agent>` — wire (or remove) an
 * agent's turn-end hook so snapshots happen hands-free (DESIGN.md §10).
 *
 * Claude Code is fully automated: we idempotently merge a `Stop` hook into
 * ~/.claude/settings.json without disturbing any other settings or hooks. Other
 * agents print the exact command to wire manually (their hook surfaces are still
 * settling; we won't write config we can't guarantee).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { bool, str } from "../args.ts";
import type { Boundary } from "../meta.ts";

/** Substring that identifies a hook entry as ours. */
const MARKER = "git-rewind snapshot";

interface HookCmd {
  type?: string;
  command?: string;
}
interface HookEntry {
  matcher?: string;
  hooks?: HookCmd[];
}
type Settings = Record<string, unknown> & {
  hooks?: Record<string, HookEntry[]>;
};

interface ClaudeAgent {
  kind: "claude";
  defaultSettings: string;
}
interface ManualAgent {
  kind: "manual";
  note: string;
}
type AgentSpec = ClaudeAgent | ManualAgent;

function agentSpec(agent: string): AgentSpec | null {
  switch (agent) {
    case "claude":
      return { kind: "claude", defaultSettings: join(homedir(), ".claude", "settings.json") };
    case "codex":
      return {
        kind: "manual",
        note: "Codex CLI: point your turn-end/notify hook at the command below.",
      };
    case "gemini":
      return { kind: "manual", note: "Gemini CLI: point your turn-end hook at the command below." };
    default:
      return null;
  }
}

function snapshotCommandLine(agent: string, boundary: Boundary): string {
  const parts = ["git-rewind", "snapshot", "--async", "--agent", agent, "--stdin-session"];
  if (boundary !== "turn-end") parts.push("--boundary", boundary);
  return parts.join(" ");
}

/** Read + parse a JSON settings file; {} if missing. Throws on malformed JSON. */
function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as Settings;
  } catch (err) {
    throw new Error(`refusing to edit malformed JSON at ${path}: ${(err as Error).message}`);
  }
}

function writeSettings(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

function entryIsOurs(entry: HookEntry): boolean {
  return (entry.hooks ?? []).some(
    (h) => typeof h.command === "string" && h.command.includes(MARKER),
  );
}

/** Add or update our hook for `event`; returns "added" | "updated" | "unchanged". */
function upsertHook(
  settings: Settings,
  event: string,
  command: string,
): "added" | "updated" | "unchanged" {
  settings.hooks ??= {};
  const list = (settings.hooks[event] ??= []);
  const existing = list.find(entryIsOurs);
  if (existing) {
    const cmd = existing.hooks?.find(
      (h) => typeof h.command === "string" && h.command.includes(MARKER),
    );
    if (cmd && cmd.command === command) return "unchanged";
    if (cmd) {
      cmd.command = command;
      return "updated";
    }
  }
  list.push({ matcher: "", hooks: [{ type: "command", command }] });
  return "added";
}

/** Remove our hook entries for `event`; returns count removed. Prunes empties. */
function removeHook(settings: Settings, event: string): number {
  const list = settings.hooks?.[event];
  if (!list) return 0;
  const before = list.length;
  const kept = list.filter((e) => !entryIsOurs(e));
  const removed = before - kept.length;
  if (kept.length > 0) {
    settings.hooks![event] = kept;
  } else {
    delete settings.hooks![event];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return removed;
}

export function installCommand(
  positionals: string[],
  flags: Record<string, string | boolean>,
): number {
  const agent = positionals[0];
  if (!agent) {
    process.stderr.write("git-rewind: install requires an agent (claude|codex|gemini)\n");
    return 1;
  }
  const spec = agentSpec(agent);
  if (!spec) {
    process.stderr.write(`git-rewind: unknown agent '${agent}' (expected claude|codex|gemini)\n`);
    return 1;
  }
  const quiet = bool(flags, "quiet", false);
  const out = (s: string) => {
    if (!quiet) process.stdout.write(s);
  };

  // The Stop hook always captures at turn-end (after edits — the risky moment).
  // `--boundary pre-prompt` is opt-in extra: it ALSO wires a UserPromptSubmit
  // hook for a pre-turn baseline; it does not change the Stop hook.
  const wantPrePrompt = str(flags, "boundary") === "pre-prompt";
  const command = str(flags, "command") ?? snapshotCommandLine(agent, "turn-end");

  if (spec.kind === "manual") {
    out(
      `${spec.note}\n\n  ${command}\n\n` +
        "(Automated install for this agent isn't wired yet — add the command above to its turn-end hook.)\n",
    );
    return 0;
  }

  const settingsPath = str(flags, "settings") ?? spec.defaultSettings;
  const dryRun = bool(flags, "dry-run", false);

  const settings = readSettings(settingsPath);
  const result = upsertHook(settings, "Stop", command);
  // Optional pre-turn baseline (separate command, pre-prompt boundary).
  let preResult: string | null = null;
  if (wantPrePrompt) {
    preResult = upsertHook(settings, "UserPromptSubmit", snapshotCommandLine(agent, "pre-prompt"));
  }

  if (dryRun) {
    process.stdout.write(`${JSON.stringify(settings, null, 2)}\n`);
    process.stdout.write(`\n(dry-run) would write ${settingsPath} — Stop: ${result}\n`);
    return 0;
  }

  writeSettings(settingsPath, settings);
  out(
    `git-rewind: ${result === "unchanged" ? "already installed" : result} Claude Stop hook in ${settingsPath}\n` +
      (preResult ? `  + UserPromptSubmit (pre-prompt): ${preResult}\n` : "") +
      `  command: ${command}\n`,
  );
  return 0;
}

export function uninstallCommand(
  positionals: string[],
  flags: Record<string, string | boolean>,
): number {
  const agent = positionals[0];
  if (!agent) {
    process.stderr.write("git-rewind: uninstall requires an agent (claude|codex|gemini)\n");
    return 1;
  }
  const quiet = bool(flags, "quiet", false);
  const out = (s: string) => {
    if (!quiet) process.stdout.write(s);
  };
  const spec = agentSpec(agent);
  if (!spec || spec.kind !== "claude") {
    out(
      `git-rewind: nothing automated to remove for '${agent}' — remove the snapshot command from its hook config manually.\n`,
    );
    return 0;
  }

  const settingsPath = str(flags, "settings") ?? spec.defaultSettings;
  if (!existsSync(settingsPath)) {
    out(`git-rewind: no settings at ${settingsPath} — nothing to remove\n`);
    return 0;
  }
  const settings = readSettings(settingsPath);
  const removed = removeHook(settings, "Stop") + removeHook(settings, "UserPromptSubmit");
  if (bool(flags, "dry-run", false)) {
    process.stdout.write(`${JSON.stringify(settings, null, 2)}\n`);
    return 0;
  }
  writeSettings(settingsPath, settings);
  out(
    removed > 0
      ? `git-rewind: removed ${removed} hook entr${removed === 1 ? "y" : "ies"} from ${settingsPath}\n`
      : `git-rewind: no git-rewind hooks found in ${settingsPath}\n`,
  );
  return 0;
}
