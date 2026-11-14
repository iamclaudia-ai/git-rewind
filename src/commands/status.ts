/**
 * `git-rewind status` — store head, snapshot count, and effective config.
 */
import { bool, str } from "../args.ts";
import { loadConfig } from "../config.ts";
import { gitTry } from "../git.ts";
import { resolveRepo } from "../repo.ts";

export function statusCommand(flags: Record<string, string | boolean>): number {
  const repoDir = str(flags, "repo") ?? process.cwd();
  const repo = resolveRepo(repoDir);
  if (!repo) {
    process.stderr.write("git-rewind: not a git repository\n");
    return 1;
  }
  const cfg = loadConfig(repo);
  const head = gitTry(["rev-parse", "-q", "--verify", cfg.ref], { cwd: repo.root });
  const undo = gitTry(["rev-parse", "-q", "--verify", "refs/rewind/undo"], {
    cwd: repo.root,
  });
  const countRaw = head ? gitTry(["rev-list", "--count", cfg.ref], { cwd: repo.root }) : "0";
  const count = Number.parseInt(countRaw ?? "0", 10);

  if (bool(flags, "json", false)) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        repo: repo.root,
        ref: cfg.ref,
        head,
        undo,
        count,
        config: cfg,
      })}\n`,
    );
    return 0;
  }

  process.stdout.write(
    [
      `repo:      ${repo.root}`,
      `ref:       ${cfg.ref}`,
      `head:      ${head ? head.slice(0, 12) : "(none)"}`,
      `snapshots: ${count}`,
      `undo:      ${undo ? undo.slice(0, 12) : "(none)"}`,
      `async:     ${cfg.async}`,
      `if_dirty:  ${cfg.ifDirty}`,
      `retention: keep-last ${cfg.keepLast}, max-age ${cfg.maxAgeDays}d, pin-labeled ${cfg.pinLabeled}`,
      "",
    ].join("\n"),
  );
  return 0;
}
