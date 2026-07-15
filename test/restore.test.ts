/**
 * `restore` / `undo` behavior + the worktree-exactness and no-touch invariants
 * (DESIGN.md §5). Restore may change the worktree (that's the job) but must never
 * touch the real index, HEAD, current branch, or ignored files.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { writeWorktreeTree } from "../src/capture.ts";
import { restoreCommand, runRestore, undoCommand } from "../src/commands/restore.ts";
import { runSnapshot, type SnapshotOptions } from "../src/commands/snapshot.ts";

const REF = "refs/rewind/store";
let repo: string;
const cleanups: string[] = [];

function g(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).replace(/\n+$/, "");
}
function write(rel: string, content: string): void {
  writeFileSync(join(repo, rel), content);
}
function read(rel: string): string {
  return readFileSync(join(repo, rel), "utf8");
}
function snap(over: Partial<SnapshotOptions> = {}) {
  return runSnapshot({
    repoDir: repo,
    boundary: "turn-end",
    ifDirty: false, // force a snapshot on demand in tests
    async: false,
    json: false,
    quiet: true,
    verbose: false,
    ...over,
  });
}
function restore(selector: string, paths: string[] = []) {
  return runRestore({
    repoDir: repo,
    selector,
    paths,
    json: false,
    quiet: true,
    verbose: false,
  });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "git-rewind-restore-test-"));
  cleanups.push(repo);
  g("init", "-q");
  g("config", "user.email", "test@example.com");
  g("config", "user.name", "Test User");
  g("config", "commit.gpgsign", "false");
});
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("full restore reproduces the target worktree tree exactly", () => {
  write("a.txt", "v1\n");
  write("keep.txt", "keep\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  const targetSnap = snap(); // capture v1 state
  const targetTree = g("rev-parse", `${targetSnap.commit}^{tree}`);

  // Diverge: edit a.txt, delete keep.txt, add a new file.
  write("a.txt", "CLOBBERED\n");
  rmSync(join(repo, "keep.txt"));
  write("added-since.txt", "new\n");

  const res = restore("latest");
  expect(res.status).toBe("restored");

  // Worktree tree now equals the target tree — added-since gone, deleted back.
  expect(writeWorktreeTree(repo)).toBe(targetTree);
  expect(read("a.txt")).toBe("v1\n");
  expect(existsSync(join(repo, "keep.txt"))).toBe(true);
  expect(existsSync(join(repo, "added-since.txt"))).toBe(false);
});

test("path-scoped restore touches only the path set", () => {
  write("src.ts", "good\n");
  write("other.ts", "unrelated\n");
  snap(); // snapshot #0: both good

  write("src.ts", "CLOBBERED\n");
  write("other.ts", "locally-edited\n"); // must be preserved
  writeFileSync(join(repo, "extra.ts"), "added\n");

  const res = restore("0", ["src.ts"]);
  expect(res.status).toBe("restored");

  expect(read("src.ts")).toBe("good\n"); // restored
  expect(read("other.ts")).toBe("locally-edited\n"); // untouched
  expect(existsSync(join(repo, "extra.ts"))).toBe(true); // untouched (out of scope)
});

test("restore writes an undo point, and undo toggles back", () => {
  write("a.txt", "v1\n");
  snap();
  write("a.txt", "v2\n");
  snap(); // latest = v2

  // Roll a.txt back to v1 (1 turn back).
  restore("1");
  expect(read("a.txt")).toBe("v1\n");
  expect(g("rev-parse", "--verify", "refs/rewind/undo")).toBeTruthy();

  // Undo the restore → back to the pre-restore state (v2).
  const u = restore("undo"); // same path undoCommand takes
  expect(u.status).toBe("restored");
  expect(read("a.txt")).toBe("v2\n");
});

test("restore never touches index / HEAD / branch", () => {
  write("a.txt", "v1\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  snap();
  write("a.txt", "v2\n");
  snap();

  // Stage something unrelated; restore must leave the index exactly as-is.
  write("staged.txt", "staged\n");
  g("add", "staged.txt");
  const headBefore = g("rev-parse", "HEAD");
  const branchBefore = g("rev-parse", "--abbrev-ref", "HEAD");
  const indexBefore = g("ls-files", "--stage");

  restore("1");

  expect(g("rev-parse", "HEAD")).toBe(headBefore);
  expect(g("rev-parse", "--abbrev-ref", "HEAD")).toBe(branchBefore);
  expect(g("ls-files", "--stage")).toBe(indexBefore); // index byte-for-byte
});

test("restore leaves ignored files untouched", () => {
  write(".gitignore", "*.log\n");
  write("a.txt", "v1\n");
  snap();
  write("a.txt", "v2\n");
  write("debug.log", "precious-local-log\n"); // ignored — not in any snapshot
  restore("latest");
  expect(existsSync(join(repo, "debug.log"))).toBe(true);
  expect(read("debug.log")).toBe("precious-local-log\n");
});

test("restore to an unknown selector is a no-op error (no mutation)", () => {
  write("a.txt", "v1\n");
  snap();
  write("a.txt", "v2\n");
  const res = restore("label:does-not-exist");
  expect(res.ok).toBe(false);
  expect(res.status).toBe("no-match");
  expect(read("a.txt")).toBe("v2\n"); // untouched
});

test("undo with no undo point is a safe no-match", () => {
  write("a.txt", "v1\n");
  snap();
  const res = restore("undo");
  expect(res.status).toBe("no-match");
});

test("CLI adapters wire selector, -- paths, and the undo toggle", () => {
  write("a.txt", "v1\n");
  write("b.txt", "b1\n");
  snap();
  write("a.txt", "CLOBBERED\n");
  write("b.txt", "b-local\n");

  // restoreCommand(positionals=["0"], flags, rest=["a.txt"]) — scoped to a.txt.
  const code = restoreCommand(["0"], { repo, quiet: true }, ["a.txt"]);
  expect(code).toBe(0);
  expect(read("a.txt")).toBe("v1\n"); // restored via CLI path
  expect(read("b.txt")).toBe("b-local\n"); // out of scope, preserved

  // undoCommand toggles back to the pre-restore a.txt.
  expect(undoCommand({ repo, quiet: true })).toBe(0);
  expect(read("a.txt")).toBe("CLOBBERED\n");

  // Missing selector is a usage error, not a mutation.
  expect(restoreCommand([], { repo, quiet: true }, [])).toBe(1);
});
