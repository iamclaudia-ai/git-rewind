/**
 * `git-rewind list` and `git-rewind show` — read-only views over the rewind
 * chain. Both parse the `Rewind-*` trailers and compute a changed-file count
 * against each snapshot's chain parent.
 */
import { bool, str } from "../args.ts";
import { loadConfig } from "../config.ts";
import { gitTry } from "../git.ts";
import { parseTrailers } from "../meta.ts";
import { resolveRepo } from "../repo.ts";
import { resolveSelector } from "../selector.ts";

export interface SnapshotEntry {
  index: number;
  commit: string;
  short: string;
  agent?: string;
  session?: string;
  label?: string;
  boundary?: string;
  time?: string;
  changed: number;
}

/** Files changed by `commit` vs its chain parent (`--root` counts all for the root). */
function changedCount(root: string, commit: string): number {
  const out = gitTry(
    ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", commit],
    { cwd: root },
  );
  if (!out) return 0;
  return out.split("\n").filter(Boolean).length;
}

/** Read up to `limit` snapshots, newest first. */
export function readEntries(root: string, ref: string, limit: number): SnapshotEntry[] {
  const args = ["log", ref, "-z", "--format=%H%n%B"];
  if (limit > 0) args.push(`-n`, String(limit));
  const out = gitTry(args, { cwd: root });
  if (!out) return [];

  const entries: SnapshotEntry[] = [];
  let index = 0;
  for (const record of out.split("\0")) {
    if (!record) continue;
    const nl = record.indexOf("\n");
    const commit = nl === -1 ? record : record.slice(0, nl);
    const body = nl === -1 ? "" : record.slice(nl + 1);
    const t = parseTrailers(body);
    entries.push({
      index: index++,
      commit,
      short: commit.slice(0, 12),
      agent: t.agent,
      session: t.session,
      label: t.label,
      boundary: t.boundary,
      time: t.time,
      changed: changedCount(root, commit),
    });
  }
  return entries;
}

export function listCommand(flags: Record<string, string | boolean>): number {
  const repoDir = str(flags, "repo") ?? process.cwd();
  const repo = resolveRepo(repoDir);
  if (!repo) {
    process.stderr.write("git-rewind: not a git repository\n");
    return 1;
  }
  const cfg = loadConfig(repo);
  const limitRaw = str(flags, "limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
  const json = bool(flags, "json", false);

  const entries = readEntries(repo.root, cfg.ref, limit);

  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, ref: cfg.ref, entries })}\n`);
    return 0;
  }

  if (entries.length === 0) {
    process.stdout.write("No snapshots yet.\n");
    return 0;
  }

  const lines = entries.map((e) => {
    const when = e.time ?? "";
    const meta = [e.agent, e.session ? `sess:${e.session.slice(0, 8)}` : "", e.label ? `#${e.label}` : ""]
      .filter(Boolean)
      .join(" ");
    const files = `${e.changed} file${e.changed === 1 ? "" : "s"}`;
    return `${String(e.index).padStart(3)}  ${e.short}  ${when}  ${files.padStart(8)}  ${meta}`;
  });
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

export function showCommand(
  positionals: string[],
  flags: Record<string, string | boolean>,
): number {
  const repoDir = str(flags, "repo") ?? process.cwd();
  const repo = resolveRepo(repoDir);
  if (!repo) {
    process.stderr.write("git-rewind: not a git repository\n");
    return 1;
  }
  const cfg = loadConfig(repo);
  const selector = positionals[0] ?? "latest";
  const commit = resolveSelector({ root: repo.root, ref: cfg.ref }, selector);
  if (!commit) {
    process.stderr.write(`git-rewind: no snapshot for selector '${selector}'\n`);
    return 1;
  }

  const body = gitTry(["log", "-1", "--format=%B", commit], { cwd: repo.root }) ?? "";
  const t = parseTrailers(body);
  const files =
    gitTry(["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", commit], {
      cwd: repo.root,
    }) ?? "";
  const json = bool(flags, "json", false);

  if (json) {
    const changed = files
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [status, ...rest] = l.split("\t");
        return { status, path: rest.join("\t") };
      });
    process.stdout.write(`${JSON.stringify({ ok: true, commit, meta: t, changed })}\n`);
    return 0;
  }

  process.stdout.write(
    [
      `commit:   ${commit}`,
      `time:     ${t.time ?? "?"}`,
      `agent:    ${t.agent ?? "?"}`,
      t.session ? `session:  ${t.session}` : null,
      t.label ? `label:    ${t.label}` : null,
      `boundary: ${t.boundary ?? "?"}`,
      "",
      "changed files:",
      files || "  (none)",
      "",
    ]
      .filter((l) => l !== null)
      .join("\n"),
  );
  return 0;
}
