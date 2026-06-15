// Tiny zero-dependency argv parser: --key value, --key=value, and --flag (boolean).
export function parseArgs(argv: string[]): { positionals: string[]; flags: Map<string, string> } {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(a.slice(2), next);
          i++;
        } else {
          flags.set(a.slice(2), 'true');
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

export function flagStr(
  flags: Map<string, string>,
  key: string,
  fallback: string | undefined,
  env?: string,
): string | undefined {
  return flags.get(key) ?? (env ? process.env[env] : undefined) ?? fallback;
}

export function flagNum(flags: Map<string, string>, key: string, fallback: number): number {
  const v = flags.get(key);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${key} must be a number, got "${v}"`);
  return n;
}
