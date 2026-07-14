/** Multi-line display sources wrap in an aligned environment (typed as
 * plain lines with & anchors; Enter makes a new line in the editor).
 * Sources that already declare an environment pass through untouched.
 * Dependency-free: imported by browser modules and serializers alike. */
export function wrapAligned(src: string): string {
  const lines = src.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2 || src.includes('\\begin{')) return src;
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
