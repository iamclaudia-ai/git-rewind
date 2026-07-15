/**
 * Shared capture primitives used by both `snapshot` and `restore`.
 *
 * The whole point of routing every worktree read through a THROWAWAY
 * GIT_INDEX_FILE lives here: building a tree or an undo point never reads or
 * writes the user's real index (DESIGN.md §2).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./git.ts";

/** Fixed identity so a snapshot never invokes user.name/email or signing. */
export const IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "git-rewind",
  GIT_AUTHOR_EMAIL: "noreply@git-rewind",
  GIT_COMMITTER_NAME: "git-rewind",
  GIT_COMMITTER_EMAIL: "noreply@git-rewind",
};

/** ISO-8601 timestamp with the local UTC offset (e.g. 2026-07-15T11:12:39-04:00). */
export function localIso(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`
  );
}

/**
 * Build a tree object of the EXACT current worktree (tracked + untracked, with
 * .gitignore / excludes honored, deletions reflected) via a throwaway index.
 * Never touches the real index.
 */
export function writeWorktreeTree(root: string): string {
  const dir = mkdtempSync(join(tmpdir(), "git-rewind-"));
  const indexFile = join(dir, "index"); // absent → git creates an empty index
  try {
    const env = { GIT_INDEX_FILE: indexFile };
    git(["add", "-A"], { cwd: root, env });
    return git(["write-tree"], { cwd: root, env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Commit a tree with the fixed identity and the given message; return its SHA. */
export function commitTree(
  root: string,
  tree: string,
  opts: { parent?: string | null; message: string },
): string {
  const args = ["commit-tree", tree];
  if (opts.parent) args.push("-p", opts.parent);
  return git(args, { cwd: root, env: IDENTITY_ENV, input: opts.message });
}
