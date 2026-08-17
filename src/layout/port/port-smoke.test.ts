// End-to-end smoke test of the Typst line-break port under Node:
// prepare a paragraph, run the two-pass DP, print the resulting lines.
// Run: npx tsx src/layout/port/port-smoke.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPrimitivesFromBytes } from '../primitives';
import { defaultConfig, prepare } from './prepare';
import { linebreak } from './linebreak';
import { DEFAULT_FONT } from '../../font-registry';

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

await loadPrimitivesFromBytes(readFileSync(root('sidecar/pkg/typeset_sidecar_bg.wasm')), [
  { key: DEFAULT_FONT.portKeys.regular, bytes: readFileSync(root('public/fonts/NewCM10-Regular.otf')) },
]);

const TEXT =
  'The Knuth-Plass algorithm is based on the idea of cost. A line which has a very tight or ' +
  'very loose fit has a higher cost than one that is just right. Ending a line with a hyphen ' +
  'incurs extra cost and ending two successive lines with hyphens even more. There is no ' +
  'hyphenation worth considering in this sentence.';

const config = defaultConfig(11);
const p = prepare([{ kind: 'text', text: TEXT, styleKey: DEFAULT_FONT.portKeys.regular }], config);

for (const measure of [180, 220, 260]) {
  const t0 = performance.now();
  const lines = linebreak(p, measure);
  const ms = performance.now() - t0;
  console.log(`\n== measure ${measure}pt (${ms.toFixed(1)} ms, ${lines.length} lines) ==`);
  let start = 0;
  for (const ln of lines) {
    // Recover the line's text from item glyph ranges for display.
    let end = start;
    for (const it of ln.items) {
      if (it.kind === 'text' && it.shaped.glyphs.length) {
        const last = it.shaped.glyphs.last()!;
        end = Math.max(end, Math.min(last.rangeEnd, p.text.len));
      }
    }
    const dash = ln.dash === 'soft' ? '-' : '';
    console.log(
      `  [${ln.width.toFixed(2).padStart(7)}pt] ${JSON.stringify(p.text.slice(start, end).trimEnd() + dash)}`,
    );
    start = end;
    // Skip the space consumed by the break.
    while (start < p.text.len && p.text.charAt(start) === ' ') start++;
  }
}
console.log('\nsmoke ok');
