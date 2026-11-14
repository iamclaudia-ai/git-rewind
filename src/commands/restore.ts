/**
 * `git-rewind restore <selector> [-- <paths…>]` and `git-rewind undo`.
 *
 * Restore is the one command that mutates the WORKTREE — that's its job — but it
 * still never touches the real index, HEAD, branches, or stash (DESIGN.md §5).
 * Mechanics:
 *   1. Capture the current worktree as an undo point → move refs/rewind/undo.
 *   2. Resolve the selector → target snapshot.
 *   3. Delete worktree paths present now but absent in the target, then
 *      materialize the target tree via a throwaway index + checkout-index.
 * Path-scoped restore confines both the deletes and the checkout to the path set.
 */
import { mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { bool, str } from "../args.ts";
import { commitTree, localIso, writeWorktreeTree } from "../capture.ts";
import { loadConfig } from "../config.ts";
import { git, gitTry } from "../git.ts";
import { withLock } from "../lock.ts";
import { buildMessage, REWIND_VERSION } from "../meta.ts";
import { type Repo, resolveRepo } from "../repo.ts";
import { resolveSelector } from "../selector.ts";

const UNDO_REF = "refs/rewind/undo";

export interface RestoreOptions {
  repoDir: string;
  selector: string;
  paths: string[];
  json: boolean;
  quiet: boolean;
  verbose: boolean;
}

export interface RestoreResult {
  ok: boolean;
  status: "restored" | "no-match" | "not-a-repo";
  target?: string;
  undo?: string;
  restored?: number;
  deleted?: number;
  deletedPaths?: string[];
}

function lsTree(root: string, treeish: string): string[] {
  const out = gitTry(["ls-tree", "-r", "--name-only", "-z", treeish], { cwd: root });
  if (!out) return [];
  return out.split("\0").filter(Boolean);
}

/** Normalize user path args to repo-relative posix paths, rejecting escapes. */
function normalizePaths(root: string, paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const rel = relative(root, resolve(root, p)).split("\\").join("/");
    if (rel === "" || rel === "." || rel.startsWith("..")) {
      throw new Error(`path escapes repository: ${p}`);
    }
    out.push(rel);
  }
  return out;
}

function underAnyPath(entry: string, paths: string[]): boolean {
  return paths.some((p) => entry === p || entry.startsWith(`${p}/`));
}

/** Remove now-empty parent directories of a deleted file, up to (not incl.) root. */
function pruneEmptyDirsUp(root: string, entry: string): void {
  let dir = dirname(join(root, entry));
  const stop = resolve(root);
  while (dir.startsWith(stop) && dir !== stop) {
    try {
      rmdirSync(dir); // throws if non-empty — that's our stop signal
    } catch {
      break;
    }
    dir = dirname(dir);
  }
}

/** Materialize `treeish` (optionally only `paths`) into the worktree via a temp index. */
function materialize(root: string, treeish: string, paths: string[] | null): void {
  const dir = mkdtempSync(join(tmpdir(), "git-rewind-restore-"));
  const indexFile = join(dir, "index");
  try {
    const env = { GIT_INDEX_FILE: indexFile };
    git(["read-tree", treeish], { cwd: root, env });
    if (paths && paths.length > 0) {
      git(["checkout-index", "-f", "--", ...paths], { cwd: root, env });
    } else if (!paths) {
      git(["checkout-index", "-a", "-f"], { cwd: root, env });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Write the pre-restore undo point and move refs/rewind/undo to it. */
function writeUndoPoint(repo: Repo, storeRef: string): { commit: string; tree: string } {
  const tree = writeWorktreeTree(repo.root);
  const storeTip = gitTry(["rev-parse", "-q", "--verify", storeRef], { cwd: repo.root });
  const message = buildMessage({
    version: REWIND_VERSION,
    agent: "restore",
    boundary: "manual",
    time: localIso(),
    label: "undo-point",
  });
  const commit = commitTree(repo.root, tree, { parent: storeTip, message });
  git(["update-ref", UNDO_REF, commit], { cwd: repo.root });
  return { commit, tree };
}

export function runRestore(opts: RestoreOptions): RestoreResult {
  const repo = resolveRepo(opts.repoDir);
  if (!repo) return { ok: false, status: "not-a-repo" };

  const cfg = loadConfig(repo);
  const target = resolveSelector({ root: repo.root, ref: cfg.ref }, opts.selector);
  if (!target) return { ok: false, status: "no-match" };

  const scoped = normalizePaths(repo.root, opts.paths);

  return withLock(repo.gitDir, () => {
    // 1. Undo point first — its tree IS the current worktree.
    const undo = writeUndoPoint(repo, cfg.ref);
    const targetTree = git(["rev-parse", `${target}^{tree}`], { cwd: repo.root });

    const currentEntries = lsTree(repo.root, undo.tree);
    const targetEntries = lsTree(repo.root, targetTree);
    const targetSet = new Set(targetEntries);

    // 2. Compute deletions (present now, absent in target), scoped if requested.
    const inScope = (e: string) => scoped.length === 0 || underAnyPath(e, scoped);
    const toDelete = currentEntries.filter((e) => inScope(e) && !targetSet.has(e));

    for (const entry of toDelete) {
      rmSync(join(repo.root, entry), { force: true });
      pruneEmptyDirsUp(repo.root, entry);
    }

    // 3. Materialize the target tree (whole, or only the scoped paths).
    if (scoped.length === 0) {
      materialize(repo.root, targetTree, null);
    } else {
      const selTarget = targetEntries.filter((e) => underAnyPath(e, scoped));
      materialize(repo.root, targetTree, selTarget);
    }

    const restored =
      scoped.length === 0
        ? targetEntries.length
        : targetEntries.filter((e) => underAnyPath(e, scoped)).length;

    return {
      ok: true,
      status: "restored",
      target,
      undo: undo.commit,
      restored,
      deleted: toDelete.length,
      deletedPaths: toDelete,
    };
  });
}

function emit(res: RestoreResult, opts: { json: boolean; quiet: boolean }, label: string): number {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(res)}\n`);
  } else if (!opts.quiet) {
    if (res.status === "restored") {
      process.stdout.write(
        `${label} to ${res.target?.slice(0, 12)}: ${res.restored} file(s) restored, ` +
          `${res.deleted} removed. undo → git-rewind undo\n`,
      );
    } else if (res.status === "no-match") {
      process.stderr.write(`git-rewind: nothing to ${label.toLowerCase()}\n`);
    } else {
      process.stderr.write("git-rewind: not a git repository\n");
    }
  }
  return res.ok ? 0 : 1;
}

export function restoreCommand(
  positionals: string[],
  flags: Record<string, string | boolean>,
  rest: string[],
): number {
  const selector = positionals[0];
  if (!selector) {
    process.stderr.write(
      "git-rewind: restore requires a snapshot selector (e.g. 1, latest, label:x)\n",
    );
    return 1;
  }
  const res = runRestore({
    repoDir: str(flags, "repo") ?? process.cwd(),
    selector,
    paths: rest,
    json: bool(flags, "json", false),
    quiet: bool(flags, "quiet", false),
    verbose: bool(flags, "verbose", false),
  });
  return emit(
    res,
    { json: bool(flags, "json", false), quiet: bool(flags, "quiet", false) },
    "Restored",
  );
}

export function undoCommand(flags: Record<string, string | boolean>): number {
  // Undo IS a restore of the undo point. runRestore resolves the current undo
  // ref *before* writing a fresh undo point (the state we're undoing from), so a
  // second `undo` toggles back — free redo.
  const res = runRestore({
    repoDir: str(flags, "repo") ?? process.cwd(),
    selector: "undo",
    paths: [],
    json: bool(flags, "json", false),
    quiet: bool(flags, "quiet", false),
    verbose: bool(flags, "verbose", false),
  });
  return emit(
    res,
    { json: bool(flags, "json", false), quiet: bool(flags, "quiet", false) },
    "Undo",
  );
}
