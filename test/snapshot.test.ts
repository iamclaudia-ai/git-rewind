/**
 * Core invariant + behavior tests for `snapshot` and the read commands.
 *
 * The non-negotiable assertion (DESIGN.md §2): after any snapshot, the user's
 * real git state — HEAD, index, current branch, working tree, stash — is
 * byte-for-byte unchanged. Everything else (dedup, deletion capture, ignored-file
 * exclusion, unborn branch, clean-gate) rides on top of that.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readEntries } from "../src/commands/list.ts";
import {
  DEFAULT_AGENT,
  runSnapshot,
  type SnapshotOptions,
  snapshotCommand,
} from "../src/commands/snapshot.ts";
import { parseTrailers } from "../src/meta.ts";
import { resolveSelector } from "../src/selector.ts";

const REF = "refs/rewind/store";
let repo: string;
const cleanups: string[] = [];

function g(...args: string[]): string {
  // Pipe stderr (don't inherit) so expected git failures in `.toThrow()` cases
  // don't spill "fatal: …" into the test output.
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).replace(/\n+$/, "");
}
function write(rel: string, content: string): void {
  writeFileSync(join(repo, rel), content);
}
function snap(over: Partial<SnapshotOptions> = {}) {
  return runSnapshot({
    repoDir: repo,
    boundary: "turn-end",
    ifDirty: true,
    async: false, // deterministic: never detach in tests
    json: false,
    quiet: true,
    verbose: false,
    ...over,
  });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "git-rewind-test-"));
  cleanups.push(repo);
  g("init", "-q");
  g("config", "user.email", "test@example.com");
  g("config", "user.name", "Test User");
  g("config", "commit.gpgsign", "false");
});

afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("core invariant: HEAD / index / branch / status untouched by snapshot", () => {
  write("a.txt", "committed\n");
  g("add", "a.txt");
  g("commit", "-qm", "init");
  // Deliberately dirty state: a staged change AND an untracked file.
  write("a.txt", "committed + staged edit\n");
  g("add", "a.txt");
  write("b.txt", "untracked\n");

  const headBefore = g("rev-parse", "HEAD");
  const stagedBlobBefore = g("rev-parse", ":a.txt");
  const statusBefore = g("status", "--porcelain");
  const branchBefore = g("rev-parse", "--abbrev-ref", "HEAD");

  const res = snap();
  expect(res.status).toBe("created");

  expect(g("rev-parse", "HEAD")).toBe(headBefore);
  expect(g("rev-parse", ":a.txt")).toBe(stagedBlobBefore); // index blob unchanged
  expect(g("status", "--porcelain")).toBe(statusBefore);
  expect(g("rev-parse", "--abbrev-ref", "HEAD")).toBe(branchBefore);
});

test("snapshot works on an unborn branch (fresh repo, no commits)", () => {
  write("only.txt", "hi\n");
  const res = snap();
  expect(res.status).toBe("created");
  const tree = g("ls-tree", "-r", "--name-only", REF);
  expect(tree.split("\n")).toContain("only.txt");
  // Parentless root commit.
  expect(g("rev-list", "--count", REF)).toBe("1");
});

test("dedup: identical worktree → no new snapshot", () => {
  write("a.txt", "one\n");
  expect(snap().status).toBe("created");
  const head1 = g("rev-parse", REF);

  const res2 = snap(); // nothing changed on disk
  expect(res2.status).toBe("deduped");
  expect(g("rev-parse", REF)).toBe(head1); // ref did not move
});

test("deletion capture: a removed tracked file is absent from the snapshot tree", () => {
  write("keep.txt", "keep\n");
  write("gone.txt", "temporary\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  // Baseline is clean vs HEAD, so bypass the dirty-gate to force a snapshot.
  expect(snap({ ifDirty: false }).status).toBe("created");
  expect(g("ls-tree", "-r", "--name-only", REF).split("\n")).toContain("gone.txt");

  rmSync(join(repo, "gone.txt")); // deletion makes the tree dirty vs HEAD
  expect(snap().status).toBe("created");
  const tree = g("ls-tree", "-r", "--name-only", REF).split("\n");
  expect(tree).toContain("keep.txt");
  expect(tree).not.toContain("gone.txt");
});

test("ignored files are excluded from the snapshot", () => {
  write(".gitignore", "*.log\ndist/\n");
  write("keep.txt", "keep\n");
  write("debug.log", "noise\n");
  execFileSync("mkdir", ["-p", join(repo, "dist")]);
  write("dist/bundle.js", "built\n");

  expect(snap().status).toBe("created");
  const tree = g("ls-tree", "-r", "--name-only", REF).split("\n");
  expect(tree).toContain("keep.txt");
  expect(tree).toContain(".gitignore");
  expect(tree).not.toContain("debug.log");
  expect(tree).not.toContain("dist/bundle.js");
});

test("clean-gate: --if-dirty on a clean worktree is a no-op", () => {
  write("a.txt", "x\n");
  g("add", "-A");
  g("commit", "-qm", "init"); // worktree now clean vs HEAD
  const res = snap({ ifDirty: true });
  expect(res.status).toBe("clean");
  // No ref created.
  expect(() => g("rev-parse", "--verify", REF)).toThrow();
});

test("clean-gate never rewrites the real index (git status runs without optional locks)", () => {
  // With optional locks on, `git status` takes index.lock after its refresh, holds it
  // through the untracked scan (blocking the user's own git writes) and writes the
  // refreshed stat info back into the real index. Make a stat-only change so a
  // locking status would have something to write.
  const saved = process.env.GIT_OPTIONAL_LOCKS;
  delete process.env.GIT_OPTIONAL_LOCKS;
  try {
    write("a.txt", "x\n");
    g("add", "-A");
    g("commit", "-qm", "init");
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(repo, "a.txt"), future, future); // same content, new mtime
    const indexBefore = readFileSync(join(repo, ".git", "index"));

    expect(snap({ ifDirty: true }).status).toBe("clean");
    expect(readFileSync(join(repo, ".git", "index")).equals(indexBefore)).toBe(true);
  } finally {
    if (saved !== undefined) process.env.GIT_OPTIONAL_LOCKS = saved;
  }
});

test("fixed identity + trailers are written to the snapshot commit", () => {
  write("a.txt", "x\n");
  snap({ agent: "claude", session: "sess-xyz", label: "pin1" });

  expect(g("log", "-1", "--format=%an", REF)).toBe("git-rewind");
  expect(g("log", "-1", "--format=%ae", REF)).toBe("noreply@git-rewind");

  const body = g("log", "-1", "--format=%B", REF);
  const t = parseTrailers(body);
  expect(t.version).toBe(1);
  expect(t.agent).toBe("claude");
  expect(t.session).toBe("sess-xyz");
  expect(t.label).toBe("pin1");
  expect(t.boundary).toBe("turn-end");
});

test("the rewind ref is invisible to ordinary git views", () => {
  write("a.txt", "x\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  snap();
  // Plain log (from HEAD), branch, and status do not surface the snapshot.
  expect(g("log", "--oneline")).not.toContain("rewind");
  expect(g("branch", "-a")).not.toContain("rewind");
  expect(g("status", "--porcelain")).toBe("");
});

test("list + label selector resolve snapshots newest-first", () => {
  write("a.txt", "v1\n");
  snap({ label: "first" });
  write("a.txt", "v2\n");
  snap({ label: "second" });

  const entries = readEntries(repo, REF, 10);
  expect(entries.length).toBe(2);
  expect(entries[0]?.index).toBe(0);
  expect(entries[0]?.label).toBe("second"); // newest first
  expect(entries[1]?.label).toBe("first");

  const ctx = { root: repo, ref: REF };
  expect(resolveSelector(ctx, "label:first")).toBe(entries[1]!.commit);
  expect(resolveSelector(ctx, "0")).toBe(entries[0]!.commit);
  expect(resolveSelector(ctx, "1")).toBe(entries[1]!.commit);
  expect(resolveSelector(ctx, "latest")).toBe(entries[0]!.commit);
});

test("agent defaults to 'shell' when --agent is omitted", () => {
  expect(DEFAULT_AGENT).toBe("shell");

  write("a.txt", "x\n");
  const code = snapshotCommand(
    { repo, "if-dirty": false, async: false, quiet: true },
    { async: false, ifDirty: true },
  );
  expect(code).toBe(0);
  expect(parseTrailers(g("log", "-1", "--format=%B", REF)).agent).toBe("shell");

  // The git committer identity stays fixed regardless of the agent label.
  expect(g("log", "-1", "--format=%an", REF)).toBe("git-rewind");
});

test("not-a-repo is a safe no-op (never throws / fails a hook)", () => {
  const nonRepo = mkdtempSync(join(tmpdir(), "git-rewind-norepo-"));
  cleanups.push(nonRepo);
  const res = runSnapshot({
    repoDir: nonRepo,
    boundary: "turn-end",
    ifDirty: true,
    async: false,
    json: false,
    quiet: true,
    verbose: false,
  });
  expect(res.ok).toBe(true);
  expect(res.status).toBe("not-a-repo");
});
