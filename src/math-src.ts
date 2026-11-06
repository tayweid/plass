/** Multi-line display sources wrap in an aligned environment (typed as
 * plain lines with & anchors; Enter makes a new line in the editor).
 * Sources that already declare an environment pass through untouched.
 * Dependency-free: imported by browser modules and serializers alike. */
export function wrapAligned(src: string): string {
  const lines = src.split('\n').map((l) => l.trim()).filter(Boolean);
  const hasAnchor = /(?<!\\)&/.test(src);
  if ((lines.length < 2 && !hasAnchor) || src.includes('\\begin{')) return src;
  return '\\begin{aligned}\n' + lines.join(' \\\\\n') + '\n\\end{aligned}';
}

/** Inverse of wrapAligned for round-trips: an aligned environment we
 * emitted comes back as plain lines (one per row). Hand-written
 * environments that don't match the shape pass through untouched. */
export function unwrapAligned(src: string): string {
  const m = /^\\begin\{aligned\}\n([\s\S]*)\n\\end\{aligned\}$/.exec(src.trim());
  if (!m) return src;
  return m[1]
    .split(/\s*\\\\\s*\n?/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/** A value inside a formula (Taylor, 2026-11-06): `\val{key}{text}`, the
 *  key as a text value's `name` (`:2` after it rounds to two decimals)
 *  and the printed number as the second argument, so the file holds the
 *  number and any LaTeX reader prints it. Plass refreshes the second
 *  argument from values.json as it does a value's text; the formula
 *  compiles, measures and prints with the macro collapsed to its number
 *  (`stripVals`, in the macro expander). */
export const VAL_RE = /\\val\{([^{}]*)\}\{([^{}]*)\}/g;

export interface ValRun {
  /** The first argument as written (`key` or `key:2`). */
  key: string;
  /** The key, without the `:digits`. */
  name: string;
  /** Decimals to round to, or null. */
  digits: number | null;
  /** The printed text, the second argument. */
  text: string;
  /** The macro's span in the source. */
  start: number;
  end: number;
}

/** Every `\val` in a formula's source. */
export function valRuns(src: string): ValRun[] {
  const runs: ValRun[] = [];
  for (const m of src.matchAll(VAL_RE)) {
    const [name, dec] = m[1].trim().split(':');
    const digits = dec !== undefined && /^\d{1,2}$/.test(dec.trim()) && Number(dec) <= 10 ? Number(dec) : null;
    runs.push({ key: m[1], name, digits, text: m[2], start: m.index, end: m.index + m[0].length });
  }
  return runs;
}

/** The source with every `\val{key}{text}` collapsed to its text: what
 *  compiles, measures and prints. */
export function stripVals(src: string): string {
  return src.replace(VAL_RE, (_m, _name: string, text: string) => text);
}

/** The source with each `\val`'s text replaced by `texts[i]` (one per run,
 *  in order); unchanged when none differ. */
export function withValTexts(src: string, runs: readonly ValRun[], texts: readonly string[]): string {
  let out = src;
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    if (texts[i] === run.text) continue;
    out = out.slice(0, run.start) + `\\val{${run.key}}{${texts[i]}}` + out.slice(run.end);
  }
  return out;
}
