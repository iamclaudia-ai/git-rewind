/**
 * Effective configuration.
 *
 * v1 sources, lowest→highest precedence:
 *   1. built-in defaults (below)
 *   2. per-repo `git config rewind.*` keys
 *
 * A global `~/.config/git-rewind/config.toml` (incl. repos.allow/deny) is
 * specced in DESIGN.md §8 and lands in a later commit; the shape here already
 * carries allow/deny so scoping wires through unchanged when it arrives.
 */
import { gitTry } from "./git.ts";
import type { Repo } from "./repo.ts";

export interface Config {
  ref: string;
  async: boolean;
  ifDirty: boolean;
  keepLast: number;
  maxAgeDays: number;
  pinLabeled: boolean;
  maxWorktreeFiles: number;
  allow: string[];
  deny: string[];
}

export const DEFAULTS: Config = {
  ref: "refs/rewind/store",
  async: true,
  ifDirty: true,
  keepLast: 200,
  maxAgeDays: 30,
  pinLabeled: true,
  maxWorktreeFiles: 200_000,
  allow: [],
  deny: [],
};

function cfgStr(root: string, key: string): string | null {
  return gitTry(["config", "--get", key], { cwd: root });
}

function cfgBool(root: string, key: string, fallback: boolean): boolean {
  const raw = gitTry(["config", "--bool", "--get", key], { cwd: root });
  if (raw === null) return fallback;
  return raw === "true";
}

function cfgInt(root: string, key: string, fallback: number): number {
  const raw = cfgStr(root, key);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Resolve effective config for a repo. */
export function loadConfig(repo: Repo): Config {
  const r = repo.root;
  return {
    ref: cfgStr(r, "rewind.ref") ?? DEFAULTS.ref,
    async: cfgBool(r, "rewind.async", DEFAULTS.async),
    ifDirty: cfgBool(r, "rewind.ifDirty", DEFAULTS.ifDirty),
    keepLast: cfgInt(r, "rewind.keepLast", DEFAULTS.keepLast),
    maxAgeDays: cfgInt(r, "rewind.maxAgeDays", DEFAULTS.maxAgeDays),
    pinLabeled: cfgBool(r, "rewind.pinLabeled", DEFAULTS.pinLabeled),
    maxWorktreeFiles: cfgInt(r, "rewind.maxWorktreeFiles", DEFAULTS.maxWorktreeFiles),
    allow: DEFAULTS.allow,
    deny: DEFAULTS.deny,
  };
}
