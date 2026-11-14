/**
 * `install` / `uninstall` — idempotent, non-destructive merges into an agent's
 * settings.json. The tests always target a throwaway settings path, never the
 * real ~/.claude/settings.json.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installCommand, uninstallCommand } from "../src/commands/install.ts";

let dir: string;
let settings: string;
const cleanups: string[] = [];

function read(): any {
  return JSON.parse(readFileSync(settings, "utf8"));
}
function stopCommands(s = read()): string[] {
  return (s.hooks?.Stop ?? []).flatMap((e: any) => (e.hooks ?? []).map((h: any) => h.command));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "git-rewind-install-test-"));
  cleanups.push(dir);
  settings = join(dir, "settings.json");
});
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("install adds a Stop hook, creating settings.json if absent", () => {
  expect(existsSync(settings)).toBe(false);
  const code = installCommand(["claude"], { settings, quiet: true });
  expect(code).toBe(0);
  const cmds = stopCommands();
  expect(cmds.some((c) => c.includes("git-rewind snapshot") && c.includes("--agent claude"))).toBe(
    true,
  );
});

test("install preserves unrelated settings and existing hooks", () => {
  writeFileSync(
    settings,
    JSON.stringify({
      model: "opus",
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo keep-me" }] }],
      },
    }),
  );
  installCommand(["claude"], { settings, quiet: true });
  const s = read();
  expect(s.model).toBe("opus");
  const cmds = stopCommands(s);
  expect(cmds).toContain("echo keep-me"); // untouched
  expect(cmds.length).toBe(2); // existing + ours
});

test("install is idempotent (no duplicate entries)", () => {
  installCommand(["claude"], { settings, quiet: true });
  installCommand(["claude"], { settings, quiet: true });
  installCommand(["claude"], { settings, quiet: true });
  expect(stopCommands().filter((c) => c.includes("git-rewind snapshot")).length).toBe(1);
});

test("--boundary pre-prompt keeps Stop at turn-end and adds a pre-prompt hook", () => {
  installCommand(["claude"], { settings, boundary: "pre-prompt", quiet: true });
  const s = read();
  const stop = stopCommands(s);
  expect(stop.length).toBe(1);
  expect(stop[0]).not.toContain("--boundary"); // Stop stays turn-end
  const pre = (s.hooks.UserPromptSubmit ?? []).flatMap((e: any) =>
    (e.hooks ?? []).map((h: any) => h.command),
  );
  expect(pre[0]).toContain("--boundary pre-prompt");
});

test("uninstall removes only our entries", () => {
  writeFileSync(
    settings,
    JSON.stringify({
      hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo keep-me" }] }] },
    }),
  );
  installCommand(["claude"], { settings, quiet: true });
  expect(stopCommands().length).toBe(2);

  uninstallCommand(["claude"], { settings, quiet: true });
  const cmds = stopCommands();
  expect(cmds).toEqual(["echo keep-me"]);
});

test("install refuses to touch malformed JSON", () => {
  writeFileSync(settings, "{ this is not json ");
  expect(() => installCommand(["claude"], { settings, quiet: true })).toThrow(/malformed JSON/);
});

test("unknown agent is a usage error", () => {
  expect(installCommand(["notanagent"], { settings, quiet: true })).toBe(1);
});

test("manual agents (codex) print guidance and don't write settings", () => {
  const code = installCommand(["codex"], { settings, quiet: true });
  expect(code).toBe(0);
  expect(existsSync(settings)).toBe(false); // nothing written for manual agents
});
