/**
 * `git-rewind snapshot` — capture the worktree into refs/rewind/store.
 *
 * The core invariant (DESIGN.md §2) is enforced by construction here: we build
 * the tree in a THROWAWAY GIT_INDEX_FILE and only ever move our own ref. The
 * real index, HEAD, branches, stash, and worktree are never read for writing nor
 * mutated.
 */
import { spawn, type SpawnOptions } from "node:child_process";
import { openSync } from "node:fs";
import { join } from "node:path";
import { bool, str } from "../args.ts";
import { commitTree, localIso, writeWorktreeTree } from "../capture.ts";
import type { Config } from "../config.ts";
import { loadConfig } from "../config.ts";
import { git, gitTry } from "../git.ts";
import { withLock } from "../lock.ts";
import type { Boundary } from "../meta.ts";
import { buildMessage, REWIND_VERSION } from "../meta.ts";
import { isRepoAllowed, resolveRepo } from "../repo.ts";

export interface SnapshotOptions {
  repoDir: string;
  agent?: string;
  session?: string;
  label?: string;
  boundary: Boundary;
  ifDirty: boolean;
  async: boolean;
  json: boolean;
  quiet: boolean;
  verbose: boolean;
}

/**
 * Re-launch this same CLI as a detached child so the hook returns instantly.
 * Returns false if we can't determine our own entrypoint (rare embedding) — the
 * caller then falls back to an inline synchronous capture.
 */
function spawnDetached(repoRoot: string, opts: SnapshotOptions, gitDir: string): boolean {
  const self = process.argv[1];
  if (!self) return false;

  const args = [self, "snapshot", "--no-async", "--repo", repoRoot];
  args.push("--boundary", opts.boundary);
  if (opts.ifDirty) args.push("--if-dirty");
  else args.push("--no-if-dirty");
  if (opts.agent) args.push("--agent", opts.agent);
  if (opts.session) args.push("--session", opts.session);
  if (opts.label) args.push("--label", opts.label);

  const log = openSync(join(gitDir, "rewind.log"), "a");
  const spawnOpts: SpawnOptions = {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, GIT_REWIND_WORKER: "1" },
  };
  const child = spawn(process.execPath, args, spawnOpts);
  child.unref();
  return true;
}

export interface SnapshotResult {
  ok: boolean;
  status: "created" | "deduped" | "clean" | "skipped" | "not-a-repo" | "async";
  repo?: string;
  ref?: string;
  commit?: string;
  parent?: string | null;
}

/** Core capture. Returns a structured result; the CLI turns it into output/exit. */
export function runSnapshot(opts: SnapshotOptions): SnapshotResult {
  const repo = resolveRepo(opts.repoDir);
  if (!repo) return { ok: true, status: "not-a-repo" };

  const cfg: Config = loadConfig(repo);
  if (!isRepoAllowed(repo.root, cfg.allow, cfg.deny)) {
    return { ok: true, status: "skipped", repo: repo.root };
  }

  const ref = cfg.ref;
  const isWorker = process.env.GIT_REWIND_WORKER === "1";

  // Dirty-gate in the parent: a clean worktree costs ~one status and no spawn.
  if (opts.ifDirty) {
    const dirty = git(["status", "--porcelain", "--untracked-files=normal"], {
      cwd: repo.root,
    });
    if (dirty === "") return { ok: true, status: "clean", repo: repo.root, ref };
  }

  // Hand the heavy add -A/commit to a detached child so the hook returns now.
  // If we can't detach, fall through to an inline synchronous capture.
  if (opts.async && !isWorker) {
    if (spawnDetached(repo.root, opts, repo.gitDir)) {
      return { ok: true, status: "async", repo: repo.root, ref };
    }
  }

  return withLock(repo.gitDir, () => {
    const tree = writeWorktreeTree(repo.root);

    // Retry loop guards against a concurrent snapshot winning the CAS. The tree
    // is fixed (same worktree), so we only re-read the parent and re-commit.
    for (let attempt = 0; attempt < 3; attempt++) {
      const parent = gitTry(["rev-parse", "-q", "--verify", ref], { cwd: repo.root });

      // Dedup: identical tree to the last snapshot ⇒ nothing to record.
      if (parent) {
        const parentTree = gitTry(["rev-parse", `${parent}^{tree}`], { cwd: repo.root });
        if (parentTree === tree) {
          return { ok: true, status: "deduped", repo: repo.root, ref, parent };
        }
      }

      const message = buildMessage({
        version: REWIND_VERSION,
        agent: opts.agent,
        session: opts.session,
        boundary: opts.boundary,
        time: localIso(),
        label: opts.label,
      });

      const commit = commitTree(repo.root, tree, { parent, message });

      // CAS: oldvalue = parent, or "" to assert the ref must not yet exist.
      const casOk = gitTry(
        ["update-ref", ref, commit, parent ?? ""],
        { cwd: repo.root },
      );
      if (casOk !== null) {
        return { ok: true, status: "created", repo: repo.root, ref, commit, parent };
      }
      // Lost the race — loop, re-read parent, try again.
    }

    // Extremely unlikely: 3 straight CAS losses. Report no-op rather than fail.
    return { ok: true, status: "skipped", repo: repo.root, ref };
  });
}

/**
 * Default agent label when `--agent` is omitted. The field records *which tool*
 * captured the snapshot; a hand-run snapshot is "shell" (one of DESIGN's agents:
 * claude | codex | gemini | shell). Agent hooks always pass `--agent` explicitly,
 * so this only affects manual invocations.
 */
export const DEFAULT_AGENT = "shell";

/** CLI adapter: parse flags, run, emit output, return exit code. */
export function snapshotCommand(
  flags: Record<string, string | boolean>,
  cfgDefaults: { async: boolean; ifDirty: boolean },
): number {
  const repoDir = str(flags, "repo") ?? process.cwd();
  const boundary = (str(flags, "boundary") as Boundary) ?? "turn-end";
  const opts: SnapshotOptions = {
    repoDir,
    agent: str(flags, "agent") ?? DEFAULT_AGENT,
    session: str(flags, "session"),
    label: str(flags, "label"),
    boundary,
    ifDirty: bool(flags, "if-dirty", cfgDefaults.ifDirty),
    async: bool(flags, "async", cfgDefaults.async),
    json: bool(flags, "json", false),
    quiet: bool(flags, "quiet", false),
    verbose: bool(flags, "verbose", false),
  };

  const res = runSnapshot(opts);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(res)}\n`);
  } else if (opts.verbose && !opts.quiet) {
    const where = res.repo ?? repoDir;
    if (res.status === "created") process.stderr.write(`git-rewind: snapshot ${res.commit?.slice(0, 12)} (${where})\n`);
    else process.stderr.write(`git-rewind: ${res.status} (${where})\n`);
  }

  // A hook must never fail a turn: only genuine internal errors are non-zero,
  // and those throw before reaching here (caught at the top level).
  return 0;
}
