// Sidecar face-registration gate for every publicly selectable font. The
// browser/Typst agreement is covered by tests/fonts.spec.ts; this Node test
// ensures all styles reach shaping under the exact namespaced keys.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  COMMON_FONT_FILES,
  COMMON_PORT_KEYS,
  FONT_STYLES,
  selectableFonts,
} from '../font-registry';
import { loadPrimitivesFromBytes } from './primitives';
import { defaultConfig, prepare } from './port/prepare';
import { linebreak } from './port/linebreak';

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const exact = selectableFonts();
const specs = exact.flatMap((font) =>
  FONT_STYLES.map((style) => ({
    key: font.portKeys[style],
    bytes: readFileSync(root(`public/fonts/${font.compilerFiles[style]}`)),
  })),
);
specs.push({
  key: COMMON_PORT_KEYS.mono,
  bytes: readFileSync(root(`public/fonts/${COMMON_FONT_FILES.mono}`)),
});

const prim = await loadPrimitivesFromBytes(
  readFileSync(root('sidecar/pkg/typeset_sidecar_bg.wasm')),
  specs,
);

let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) console.log(`  ok  ${name}`);
  else {
    console.error(`FAIL  ${name}`);
    failed++;
  }
}

const sample = 'Afflictive typography — naïve cooperation 123';
for (const font of exact) {
  for (const style of FONT_STYLES) {
    const key = font.portKeys[style];
    const glyphs = prim.shape(key, sample);
    check(
      `${font.label} ${style} shapes through its registered face`,
      prim.upem(key) > 0 && glyphs.length > 0 && glyphs.every((glyph) => glyph.glyphId !== 0),
    );
  }

  const paragraph = prepare(
    FONT_STYLES.map((style) => ({
      kind: 'text' as const,
      text: `${style} words `,
      styleKey: font.portKeys[style],
    })),
    defaultConfig(12.5),
  );
  const lines = linebreak(paragraph, 180);
  check(`${font.label} mixed-style paragraph breaks`, lines.length > 1);
}

const monoGlyphs = prim.shape(COMMON_PORT_KEYS.mono, 'const exact = true;');
check('shared mono face shapes code', monoGlyphs.length > 0 && monoGlyphs.every((g) => g.glyphId !== 0));

if (failed) process.exit(1);
console.log('\nall selectable font sidecar checks passed');
