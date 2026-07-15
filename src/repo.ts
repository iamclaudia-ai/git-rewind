/**
 * Repo resolution + allow/deny scoping.
 *
 * One global hook covers every repo: we resolve the toplevel from the hook's cwd
 * (or an explicit --repo) so there's no per-repo watcher to start. Scoping lets a
 * user opt specific repos in/out without touching the hook.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { gitTry } from "./git.ts";

export interface Repo {
  /** Worktree toplevel (absolute). */
  root: string;
  /** Absolute .git dir (handles linked worktrees / submodules). */
  gitDir: string;
}

/** Resolve the repo containing `startDir`, or null if it isn't a git worktree. */
export function resolveRepo(startDir: string): Repo | null {
  const root = gitTry(["rev-parse", "--show-toplevel"], { cwd: startDir });
  if (!root) return null;
  const gitDir = gitTry(["rev-parse", "--absolute-git-dir"], { cwd: startDir });
  if (!gitDir) return null;
  return { root, gitDir };
}

/** Expand a leading `~` and normalize a configured path pattern to absolute-ish. */
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

/**
 * Glob match supporting `*` (within a path segment) and `**` (across segments),
 * anchored to the whole string. Deliberately small — enough for repo path allow/
 * deny lists like `~/Projects/beehiiv/*` or `~/Projects/iamclaudia-ai/**`.
 */
function globMatch(pattern: string, value: string): boolean {
  const pat = expandHome(pattern);
  let re = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === undefined) break;
    if (c === "*") {
      if (pat[i + 1] === "*") {
        re += ".*"; // ** — any depth
        i++;
        if (pat[i + 1] === "/") i++; // swallow the slash after ** so `a/**/b` ~ `a/b`
      } else {
        re += "[^/]*"; // * — within one segment
      }
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`).test(value);
}

/**
 * Decide whether `repoRoot` is in scope. Deny wins over allow. An empty allow
 * list means "all repos" (capture-everywhere default — errs toward protecting
 * data); a non-empty allow list is an opt-in allowlist.
 */
export function isRepoAllowed(
  repoRoot: string,
  allow: string[],
  deny: string[],
): boolean {
  if (deny.some((p) => globMatch(p, repoRoot))) return false;
  if (allow.length === 0) return true;
  return allow.some((p) => globMatch(p, repoRoot));
}
