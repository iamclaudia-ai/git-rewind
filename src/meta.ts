/**
 * Snapshot metadata rides in the commit message as `Rewind-*` trailers — the
 * commit is the authoritative, agent-portable record (there is no shared
 * cross-agent session ledger). See DESIGN.md §3.
 */

export const REWIND_VERSION = 1;

export type Boundary = "turn-end" | "pre-prompt" | "manual";

export interface Trailers {
  version: number;
  agent?: string;
  session?: string;
  boundary?: Boundary;
  /** ISO-8601 with offset, e.g. 2026-07-15T11:12:39-04:00 */
  time: string;
  label?: string;
}

/** Build the full commit message (subject + blank line + trailers). */
export function buildMessage(t: Trailers): string {
  const lines = ["rewind: turn snapshot", "", `Rewind-Version: ${t.version}`];
  if (t.agent) lines.push(`Rewind-Agent: ${t.agent}`);
  if (t.session) lines.push(`Rewind-Session: ${t.session}`);
  if (t.boundary) lines.push(`Rewind-Boundary: ${t.boundary}`);
  lines.push(`Rewind-Time: ${t.time}`);
  if (t.label) lines.push(`Rewind-Label: ${t.label}`);
  return `${lines.join("\n")}\n`;
}

const TRAILER_RE = /^Rewind-([A-Za-z]+):[ \t]*(.*)$/;

/** Parse `Rewind-*` trailers out of a raw commit message body. */
export function parseTrailers(message: string): Partial<Trailers> {
  const out: Partial<Trailers> = {};
  for (const line of message.split("\n")) {
    const m = TRAILER_RE.exec(line);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (!val) continue;
    switch (key) {
      case "version":
        out.version = Number(val);
        break;
      case "agent":
        out.agent = val;
        break;
      case "session":
        out.session = val;
        break;
      case "boundary":
        out.boundary = val as Boundary;
        break;
      case "time":
        out.time = val;
        break;
      case "label":
        out.label = val;
        break;
    }
  }
  return out;
}
