/**
 * Minimal argv parser. No dependency, predictable rules:
 *   --flag            -> true
 *   --no-flag         -> false
 *   --key value       -> "value"   (unless key is in `booleans`)
 *   --key=value       -> "value"
 *   -x                -> true (short boolean)
 *   everything before a literal `--` and not consumed as a value is positional
 *   everything after a literal `--` is collected into `rest` (e.g. pathspecs)
 */
export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
  /** Args after a literal `--`. */
  rest: string[];
}

export function parseArgs(argv: string[], booleans: string[] = []): ParsedArgs {
  const boolSet = new Set(booleans);
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (body.startsWith("no-")) {
        flags[body.slice(3)] = false;
      } else if (boolSet.has(body)) {
        flags[body] = true;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags[body] = next;
          i++;
        } else {
          flags[body] = true;
        }
      }
      continue;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      for (const ch of arg.slice(1)) flags[ch] = true;
      continue;
    }

    positionals.push(arg);
  }

  return { positionals, flags, rest };
}

/** Read a flag as a string, or undefined if absent/boolean. */
export function str(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

/** Read a flag as a boolean with an explicit default (handles --no-x = false). */
export function bool(flags: Record<string, string | boolean>, key: string, dflt: boolean): boolean {
  const v = flags[key];
  return typeof v === "boolean" ? v : dflt;
}
