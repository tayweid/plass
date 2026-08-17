import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  COMMON_FONT_FILES,
  COMMON_PORT_KEYS,
  DEFAULT_FONT,
  FONT_CATALOG,
  FONT_STYLES,
  compilerFontFiles,
  cssFontStack,
  effectiveFont,
  requestedFont,
  selectableFonts,
} from './font-registry';
import { DEFAULT_SETTINGS, normalizeSettings } from './settings';
import { textSetLine } from './typ-serializer';

let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) console.log(`  ok  ${name}`);
  else {
    console.error(`FAIL  ${name}`);
    failed++;
  }
}

const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

check('New Computer Modern is the default', DEFAULT_FONT.label === 'New Computer Modern');
check(
  'only certified families are selectable',
  selectableFonts().length === 1 && selectableFonts()[0] === DEFAULT_FONT,
);
check('legacy machine font resolves to the bundled default', effectiveFont('Georgia') === DEFAULT_FONT);
check('legacy preference remains stored', normalizeSettings({ font: 'Georgia' }).font === 'Georgia');
check(
  'legacy preference renders and exports through the same effective family',
  cssFontStack('Georgia').includes(DEFAULT_FONT.cssFamily) &&
    textSetLine({ ...DEFAULT_SETTINGS, font: 'Georgia' }).includes(`font: "${DEFAULT_FONT.typstFamily}"`),
);
check('uncertified bundled font resolves to the bundled default', effectiveFont('STIX Two Text') === DEFAULT_FONT);
check('canonical and alias lookup work', requestedFont('new-computer-modern') === DEFAULT_FONT && requestedFont('NewComputerModern') === DEFAULT_FONT);
check('arbitrary names never enter CSS', !cssFontStack('A"; color: red').includes('color'));

const portKeys = new Set<string>();
const compilerFiles = new Set<string>();
let complete = true;
for (const font of FONT_CATALOG) {
  for (const style of FONT_STYLES) {
    complete &&= !!font.browserFiles[style] && !!font.compilerFiles[style] && !!font.portKeys[style];
    complete &&= existsSync(root(`public/fonts/${font.browserFiles[style]}`));
    complete &&= existsSync(root(`public/fonts/${font.compilerFiles[style]}`));
    portKeys.add(font.portKeys[style]);
    compilerFiles.add(font.compilerFiles[style]);
  }
  if (font.exact) complete &&= font.parity !== null;
}
check('catalog assets and exact-family parity are complete', complete);
check('sidecar keys are unique', portKeys.size === FONT_CATALOG.length * FONT_STYLES.length);
check('common mono key cannot shadow a family face', !portKeys.has(COMMON_PORT_KEYS.mono));
check('compiler face files are unique', compilerFiles.size === FONT_CATALOG.length * FONT_STYLES.length);
check('common math and mono assets exist', Object.values(COMMON_FONT_FILES).every((f) => existsSync(root(`public/fonts/${f}`))));
check('mono sidecar key is namespaced', COMMON_PORT_KEYS.mono.includes('/'));

const css = readFileSync(root('src/style.css'), 'utf8');
check(
  'every selectable browser face is declared in CSS',
  selectableFonts().every((font) => FONT_STYLES.every((style) => css.includes(font.browserFiles[style]))),
);
check('compiler inventory has no duplicate files', new Set(compilerFontFiles()).size === compilerFontFiles().length);

if (failed) process.exit(1);
console.log('\nall font registry tests passed');
