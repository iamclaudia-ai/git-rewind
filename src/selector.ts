/**
 * Resolve a snapshot selector (DESIGN.md §6) to a commit SHA on the rewind chain.
 *
 * Accepted forms:
 *   latest | HEAD | 0        most recent snapshot
 *   1, 2, …                  N snapshots back
 *   @{turn:-N}               sugar for N back
 *   <sha>                    a commit on the chain (full/abbrev)
 *   label:<name>             most recent snapshot whose Rewind-Label matches
 *   undo                     the refs/rewind/undo point
 */
import { gitTry } from "./git.ts";
import { parseTrailers } from "./meta.ts";

const UNDO_REF = "refs/rewind/undo";

export interface ResolveContext {
  root: string;
  /** The store ref, e.g. refs/rewind/store. */
  ref: string;
}

function verifyCommit(root: string, rev: string): string | null {
  return gitTry(["rev-parse", "-q", "--verify", `${rev}^{commit}`], { cwd: root });
}

/** Resolve `selector` → full commit SHA, or null if it doesn't resolve. */
export function resolveSelector(ctx: ResolveContext, selector: string): string | null {
  const { root, ref } = ctx;
  const sel = selector.trim();

  if (sel === "undo") return verifyCommit(root, UNDO_REF);
  if (sel === "" || sel === "latest" || sel === "HEAD" || sel === "0") {
    return verifyCommit(root, ref);
  }

  if (/^\d+$/.test(sel)) return verifyCommit(root, `${ref}~${sel}`);

  const turn = /^@\{turn:-(\d+)\}$/.exec(sel);
  if (turn) return verifyCommit(root, `${ref}~${turn[1]}`);

  if (sel.startsWith("label:")) {
    return resolveLabel(root, ref, sel.slice("label:".length));
  }

  // Bare revision (SHA / abbrev): accept only if it's the tip or an ancestor of
  // the store ref — i.e. actually on the rewind chain.
  const commit = verifyCommit(root, sel);
  if (!commit) return null;
  const tip = verifyCommit(root, ref);
  if (commit === tip) return commit;
  const onChain =
    gitTry(["merge-base", "--is-ancestor", commit, ref], { cwd: root }) !== null;
  return onChain ? commit : null;
}

function resolveLabel(root: string, ref: string, name: string): string | null {
  // Walk newest→oldest; first commit whose Rewind-Label matches wins.
  const out = gitTry(["log", ref, "-z", "--format=%H%n%B"], { cwd: root });
  if (!out) return null;
  for (const record of out.split("\0")) {
    if (!record) continue;
    const nl = record.indexOf("\n");
    const hash = nl === -1 ? record : record.slice(0, nl);
    const body = nl === -1 ? "" : record.slice(nl + 1);
    if (parseTrailers(body).label === name) return hash;
  }
  return null;
}
