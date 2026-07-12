// Smoke test for the sidecar: run with `node sidecar/smoke.mjs`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import init, { segment, lb_classes, lb_constants, hyphenate, Shaper } from './pkg/typeset_sidecar.js';

const wasm = readFileSync(fileURLToPath(new URL('./pkg/typeset_sidecar_bg.wasm', import.meta.url)));
await init(wasm);

const text = 'Hello world, this is a test—with a dash.';
console.log('segment:', Array.from(segment(text, false)));
console.log('lb_classes:', Array.from(lb_classes(text)));
console.log('lb_constants [MB,CR,LF,NL,SP,CM,GL,WJ,ZWJ]:', Array.from(lb_constants()));

for (const w of ['hyphenation', 'algorithm', 'economics', 'worth']) {
  console.log(`hyphenate(${w}):`, Array.from(hyphenate(w, 'en')));
}

const shaper = new Shaper();
const ncm = readFileSync(fileURLToPath(new URL('../public/fonts/NewCM10-Regular.otf', import.meta.url)));
const id = shaper.add_font(ncm, 0);
console.log('font id:', id, 'upem:', shaper.upem(id));
const glyphs = shaper.shape(id, 'Hello world—office fi', false, 'en', '');
const out = [];
for (let i = 0; i < glyphs.length; i += 5) {
  out.push({ g: glyphs[i], cl: glyphs[i + 1], adv: glyphs[i + 2], unsafe: glyphs[i + 4] });
}
console.log('shape "Hello world—office fi":', out);
const upem = shaper.upem(id);
console.log('advance sum (em):', out.reduce((s, g) => s + g.adv, 0) / upem);
console.log('space glyph:', shaper.glyph_index(id, ' '.codePointAt(0)), 'hyphen glyph:', shaper.glyph_index(id, '-'.codePointAt(0)), 'hyphen adv:', shaper.glyph_advance(id, shaper.glyph_index(id, '-'.codePointAt(0))));
