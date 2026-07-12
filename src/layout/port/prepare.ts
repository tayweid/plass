// Mirror of collect.rs + prepare.rs (typst 951788cc) for the editor's
// input shape: text runs (styled), inline atoms (math/citations/raw — laid
// out boxes = Item::Frame), and spacing. Absolute spacing items occupy one
// space character in the full text; frames occupy U+FFFC, exactly as in
// collect.rs — breakpoints and estimates depend on those replacement chars.

import { ByteText, utf8Len } from './bytes';
import { ShapeConfig, ShapedText, shape } from './shaping';

const SPACING_REPLACE = ' ';
const OBJ_REPLACE = '\uFFFC';

/** Mirror of Config (the fields the line breaker reads). */
export interface Config {
  justify: boolean;
  linebreaks: 'simple' | 'optimized';
  /** Font size in pt (Abs). */
  fontSize: number;
  lang: string;
  /** text.hyphenate: undefined = auto (→ justify for text items). */
  hyphenate: boolean | undefined;
  costs: { hyphenation: number; runt: number };
  /** first-line-indent amount in pt (0 = none). */
  firstLineIndent: number;
  /** hanging-indent in pt (0 = none). */
  hangingIndent: number;
  fallback: boolean;
  cjkLatinSpacing: boolean;
}

/** Typst defaults for a justified body paragraph. */
export function defaultConfig(fontSize: number): Config {
  return {
    justify: true,
    linebreaks: 'optimized',
    fontSize,
    lang: 'en',
    hyphenate: undefined,
    costs: { hyphenation: 1.0, runt: 1.0 },
    firstLineIndent: 0,
    hangingIndent: 0,
    fallback: true,
    cjkLatinSpacing: true,
  };
}

/** Prepared item (Item in collect.rs, metrics-relevant variants). */
export type Item =
  | { kind: 'text'; shaped: ShapedText }
  | { kind: 'absolute'; width: number; weak: boolean }
  | { kind: 'frame'; width: number }
  | { kind: 'skip' };

/** Editor-facing input segments (the phase-2 adapter produces these). */
export type InputSegment =
  | { kind: 'text'; text: string; styleKey: string; fontSize?: number }
  | { kind: 'atom'; width: number }
  | { kind: 'spacing'; amount: number; weak: boolean };

/** Mirror of Preparation. */
export class Preparation {
  text: ByteText;
  config: Config;
  /** (startByte, endByte, item) triples. */
  items: Array<[number, number, Item]>;
  /** byte index → item index. */
  indices: Uint32Array;
  /** Per-item shape config (font size may differ per run). */
  private runSizes: Map<number, number>;
  /** Byte start of each ORIGINAL input segment, in input order (adapter
   * uses this to map port byte offsets back to editor positions). */
  inputStarts: number[] = [];

  constructor(
    text: ByteText,
    config: Config,
    items: Array<[number, number, Item]>,
    runSizes: Map<number, number>,
  ) {
    this.text = text;
    this.config = config;
    this.items = items;
    this.runSizes = runSizes;
    const indices = new Uint32Array(text.len);
    for (let i = 0; i < items.length; i++) {
      const [start, end] = items[i];
      for (let b = start; b < end; b++) indices[b] = i;
    }
    this.indices = indices;
  }

  /** Preparation::get — the item containing a byte offset. */
  get(offset: number): Item | null {
    const idx = offset < this.indices.length ? this.indices[offset] : 0;
    return this.items[idx]?.[2] ?? null;
  }

  /** ShapeConfig for reshaping within the item starting at `subStart`. */
  shapeConfig(subStart: number): ShapeConfig {
    return {
      fontSize: this.runSizes.get(subStart) ?? this.config.fontSize,
      lang: this.config.lang,
    };
  }

  /** Mirror of Preparation::slice. */
  *slice(start: number, end: number): Generator<[number, number, Item]> {
    let first = start === 0 ? 0 : start < this.indices.length ? this.indices[start] : 0;
    for (let i = first; i < this.items.length; i++) {
      const [rs, re, item] = this.items[i];
      // take_while: range.start < sliced.end || range.end <= sliced.end
      if (!(rs < end || re <= end)) break;
      yield [rs, re, item];
    }
  }
}

/** Mirror of collect() + prepare(): build the full text with replacement
 * chars, merge adjacent segments, shape text runs. */
export function prepare(segments: InputSegment[], config: Config): Preparation {
  // --- collect ---
  let full = '';
  type Seg =
    | { kind: 'text'; len: number; styleKey: string; fontSize: number }
    | { kind: 'item'; item: Item };
  const segs: Seg[] = [];

  const pushItem = (item: Item, textual: string) => {
    const last = segs[segs.length - 1];
    // Merge adjacent weak spacing by taking the maximum.
    if (
      last?.kind === 'item' &&
      last.item.kind === 'absolute' &&
      last.item.weak &&
      item.kind === 'absolute' &&
      item.weak
    ) {
      last.item.width = Math.max(last.item.width, item.width);
      return;
    }
    full += textual;
    segs.push({ kind: 'item', item });
  };

  const pushText = (text: string, styleKey: string, fontSize: number) => {
    const len = utf8Len(text);
    full += text;
    const last = segs[segs.length - 1];
    if (last?.kind === 'text' && last.styleKey === styleKey && last.fontSize === fontSize) {
      last.len += len;
      return;
    }
    segs.push({ kind: 'text', len, styleKey, fontSize });
  };

  if (config.firstLineIndent !== 0) {
    pushItem({ kind: 'absolute', width: config.firstLineIndent, weak: false }, SPACING_REPLACE);
  }
  if (config.hangingIndent !== 0) {
    pushItem({ kind: 'absolute', width: -config.hangingIndent, weak: false }, SPACING_REPLACE);
  }

  const inputStarts: number[] = [];
  for (const seg of segments) {
    inputStarts.push(utf8Len(full));
    if (seg.kind === 'text') {
      pushText(seg.text, seg.styleKey, seg.fontSize ?? config.fontSize);
    } else if (seg.kind === 'atom') {
      pushItem({ kind: 'frame', width: seg.width }, OBJ_REPLACE);
    } else {
      if (seg.amount === 0) continue;
      pushItem({ kind: 'absolute', width: seg.amount, weak: seg.weak }, SPACING_REPLACE);
    }
  }

  // --- prepare ---
  const text = new ByteText(full);
  const items: Array<[number, number, Item]> = [];
  const runSizes = new Map<number, number>();
  let cursor = 0;

  for (const seg of segs) {
    if (seg.kind === 'text') {
      const end = cursor + seg.len;
      // shape_range: group by script; our LTR-only mirror shapes the whole
      // styled segment as one run (script splits are a differ-visible
      // refinement if mixed-script text ever diverges).
      const runText = text.slice(cursor, end);
      const shaped = shape(cursor, runText, seg.styleKey, {
        fontSize: seg.fontSize,
        lang: config.lang,
      });
      items.push([cursor, end, { kind: 'text', shaped }]);
      runSizes.set(cursor, seg.fontSize);
      cursor = end;
    } else {
      const len = utf8Len(itemTextual(seg.item));
      items.push([cursor, cursor + len, seg.item]);
      cursor += len;
    }
  }

  const prep = new Preparation(text, config, items, runSizes);
  prep.inputStarts = inputStarts;
  return prep;
}

function itemTextual(item: Item): string {
  switch (item.kind) {
    case 'absolute':
      return SPACING_REPLACE;
    case 'frame':
      return OBJ_REPLACE;
    case 'text':
      return '';
    case 'skip':
      return '';
  }
}
