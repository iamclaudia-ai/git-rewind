/**
 * `--help` must print help and never run the command (#7: `undo --help` used to
 * perform an undo, `uninstall claude --help` removed the hook).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runRestore } from "../src/commands/restore.ts";
import { runSnapshot } from "../src/commands/snapshot.ts";
import { COMMANDS, wantsHelp } from "../src/help.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
let repo: string;
let settings: string;

function g(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function cli(...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf8" });
}

/** Everything a command could change: rewind refs, worktree, index, HEAD, hook config. */
function state() {
  return {
    refs: g("for-each-ref", "refs/rewind"),
    status: g("status", "--porcelain"),
    head: g("rev-parse", "HEAD"),
    file: readFileSync(join(repo, "f.txt"), "utf8"),
    settings: readFileSync(settings, "utf8"),
  };
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "git-rewind-help-test-"));
  g("init", "-q");
  g("config", "user.email", "test@example.com");
  g("config", "user.name", "Test");
  writeFileSync(join(repo, "f.txt"), "one\n");
  g("add", "f.txt");
  g("commit", "-qm", "init");

  // A snapshot of "two", then a restore from "three" back to it: now there's a
  // store chain, an undo point, and a dirty worktree that `undo` would change.
  const base = {
    repoDir: repo,
    boundary: "turn-end" as const,
    ifDirty: false,
    async: false,
    json: false,
    quiet: true,
    verbose: false,
  };
  writeFileSync(join(repo, "f.txt"), "two\n");
  runSnapshot(base);
  writeFileSync(join(repo, "f.txt"), "three\n");
  runRestore({ ...base, selector: "latest", paths: [] });

  // A settings file with our hook in it, for install/uninstall.
  settings = join(repo, "settings.json");
  spawnSync(process.execPath, [CLI, "install", "claude", "--settings", settings, "--quiet"], {
    cwd: repo,
  });
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

test("wantsHelp spots --help and -h before `--` only", () => {
  expect(wantsHelp(["--help"])).toBe(true);
  expect(wantsHelp(["1", "-h"])).toBe(true);
  expect(wantsHelp(["claude", "--settings", "x", "--help"])).toBe(true);
  expect(wantsHelp([])).toBe(false);
  expect(wantsHelp(["1", "--", "--help"])).toBe(false); // a path named --help
});

test("the fixture has something for each command to change", () => {
  const s = state();
  expect(g("rev-parse", "--verify", "refs/rewind/undo")).toMatch(/^[0-9a-f]{40}$/);
  expect(s.file).toBe("two\n");
  expect(s.settings).toContain("git-rewind snapshot");
});

/** Arguments that would make each command do real work, were it to run. */
function workArgs(cmd: string): string[] {
  switch (cmd) {
    case "snapshot":
      return ["--no-async", "--no-if-dirty"];
    case "show":
    case "diff":
      return ["0"];
    case "restore":
      return ["1"];
    case "install":
    case "uninstall":
      return ["claude", "--settings", settings];
    default:
      return [];
  }
}

for (const cmd of Object.keys(COMMANDS)) {
  for (const flag of ["--help", "-h"]) {
    test(`${cmd} ${flag} prints help and changes nothing`, () => {
      const before = state();
      const res = cli(cmd, ...workArgs(cmd), flag);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain(`git-rewind ${cmd} — `);
      expect(res.stdout).toContain("USAGE");
      expect(state()).toEqual(before);
    });
  }
}

test("`help <command>` prints that command's page; `help` alone prints the overview", () => {
  const page = cli("help", "undo");
  expect(page.status).toBe(0);
  expect(page.stdout).toContain("git-rewind undo — ");
  const overview = cli("help");
  expect(overview.status).toBe(0);
  expect(overview.stdout).toContain("git-rewind <command> --help");
});
