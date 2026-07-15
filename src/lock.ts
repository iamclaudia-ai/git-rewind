/**
 * A tiny cross-process advisory lock (per repo, at $GIT_DIR/rewind.lock) so
 * overlapping async snapshots serialize instead of racing. update-ref's CAS is
 * the real safety net against lost snapshots; this just avoids wasted duplicate
 * work and keeps the chain tidy.
 *
 * Synchronous by design — the whole snapshot path is sync (execFileSync) so the
 * lock can't be held across an await.
 */
import { closeSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

/** Consider a lock abandoned after this long (crashed holder). */
const STALE_MS = 30_000;
/** Give up acquiring after this long and proceed unlocked (never fail a hook). */
const ACQUIRE_TIMEOUT_MS = 5_000;
const POLL_MS = 25;

/** Block the current thread for `ms` without spinning the CPU. */
function sleepSync(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

function tryAcquire(lockPath: string): number | null {
  try {
    const fd = openSync(lockPath, "wx"); // O_CREAT | O_EXCL
    writeSync(fd, `${process.pid}\n`);
    return fd;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw err;
  }
}

function breakIfStale(lockPath: string): void {
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age > STALE_MS) rmSync(lockPath, { force: true });
  } catch {
    /* lock vanished between stat and now — fine, retry acquisition */
  }
}

/**
 * Run `fn` while holding the repo lock. If the lock can't be acquired within the
 * timeout (contention or a wedged holder we couldn't break), run `fn` anyway —
 * correctness rests on CAS, and a hook must never block or fail a turn.
 */
export function withLock<T>(gitDir: string, fn: () => T): T {
  const lockPath = join(gitDir, "rewind.lock");
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  let fd: number | null = null;

  while (Date.now() < deadline) {
    fd = tryAcquire(lockPath);
    if (fd !== null) break;
    breakIfStale(lockPath);
    sleepSync(POLL_MS);
  }

  try {
    return fn();
  } finally {
    if (fd !== null) {
      closeSync(fd);
      rmSync(lockPath, { force: true });
    }
  }
}
