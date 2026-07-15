/**
 * Thin, synchronous git plumbing wrappers.
 *
 * Uses execFileSync (no shell) so arguments are never word-split or glob-expanded
 * and we can hand git a precise, isolated environment (GIT_INDEX_FILE,
 * GIT_AUTHOR_*, …). Node- and bun-compatible: no Bun.* APIs.
 */
import { execFileSync } from "node:child_process";

export interface GitOptions {
  /** Working directory for the git process. */
  cwd?: string;
  /** Extra environment on top of process.env (merged, not replaced). */
  env?: Record<string, string | undefined>;
  /** stdin payload (e.g. a commit message for commit-tree). */
  input?: string;
}

/** 256 MiB — generous headroom for `ls-tree -r` / `log` on large trees. */
const MAX_BUFFER = 256 * 1024 * 1024;

/** Run git, return trimmed stdout. Throws (with stderr attached) on non-zero. */
export function git(args: string[], opts: GitOptions = {}): string {
  const out = execFileSync("git", args, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    input: opts.input,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    // pipe stderr so a thrown error carries git's message, not the inherited tty.
    stdio: ["pipe", "pipe", "pipe"],
  });
  return out.replace(/\n+$/, "");
}

/** Like {@link git} but returns null instead of throwing (for optional lookups). */
export function gitTry(args: string[], opts: GitOptions = {}): string | null {
  try {
    return git(args, opts);
  } catch {
    return null;
  }
}

/** True if `git <args>` exits 0. */
export function gitOk(args: string[], opts: GitOptions = {}): boolean {
  return gitTry(args, opts) !== null;
}
