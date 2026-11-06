// Values from Knuth (Taylor, 2026-10-21): a number Knuth's code computed,
// in the text. Knuth writes what a run names into `values.json` in the
// document's folder (knuth/docs/DESIGN.md, the folder contract); Plass's
// value is the text of that number, kept current.
//
// A value is ordinary text carrying the `value` mark (its key, `name`, a
// dotted path such as `prices.0` or `fit.slope`, and `digits`, decimals to
// round to, or null for the number as JSON has it). The text is laid out,
// exported and printed as any text is, so page and print agree by
// construction; the mark only says where it came from. Markdown keeps it
// as a pandoc span, `[4.5]{.value name="prices.0"}`, so a reader without
// Plass (pandoc, GitHub) still sees the number.
//
// Plass reads values.json when a document opens and whenever the file
// changes (polled, as figures are), and rewrites every value's text that
// differs; those edits stay out of the undo history. A value whose key is
// missing (no folder, no values.json, no such key, or a list or object
// there) keeps its last text and is outlined on the page: never silently
// wrong.
//
// Insert: type `{{` and pick a key (with its value beside it); `{{prices.0:2`
// rounds to two decimals. The rail's Value tool types the `{{`.
//
// In a formula (Taylor, 2026-11-06) a value is the macro `\val{key}{text}`
// (math-src.ts): the key as the span's `name` (`:2` rounds), the number as
// the second argument, refreshed here as a span's text is; the formula
// compiles and prints with the macro collapsed to its number. `{{` in the
// formula editor picks one the same way (math.ts).

import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Mark, MarkSpec, Node as PMNode } from 'prosemirror-model';
import { valRuns, withValTexts, type ValRun } from './math-src';

/** The file Knuth writes, beside the document. */
export const VALUES_FILE = 'values.json';
const VALUES_BYTES = 4 * 1024 * 1024;

/** A key: dotted segments of letters, digits, `_` and `-`. */
export const VALUE_NAME_RE = /^[A-Za-z_][\w-]*(?:\.[\w-]+)*$/;

export const valueMarkSpec: MarkSpec = {
  attrs: { name: { default: '' }, digits: { default: null } },
  inclusive: false,
  parseDOM: [
    {
      tag: 'span.ts-value',
      getAttrs: (el: HTMLElement | string) =>
        typeof el === 'string' ? false : { name: el.getAttribute('data-value') ?? '', digits: digitsOf(el.getAttribute('data-digits')) },
    },
  ],
  toDOM: (mark) => [
    'span',
    { class: 'ts-value', 'data-value': mark.attrs.name as string, 'data-digits': mark.attrs.digits === null ? null : String(mark.attrs.digits) },
    0,
  ],
};

/** Decimals from text: a whole number 0–10, else null. */
export function digitsOf(text: unknown): number | null {
  const n = typeof text === 'number' ? text : typeof text === 'string' && /^\d{1,2}$/.test(text.trim()) ? Number(text) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : null;
}

/** The scalar at `name` in `data`, or undefined. */
export function lookupValue(data: unknown, name: string): string | number | boolean | undefined {
  let at: unknown = data;
  for (const seg of name.split('.')) {
    if (Array.isArray(at)) at = /^\d+$/.test(seg) ? at[Number(seg)] : undefined;
    else if (at && typeof at === 'object' && Object.prototype.hasOwnProperty.call(at, seg)) at = (at as Record<string, unknown>)[seg];
    else return undefined;
  }
  return typeof at === 'string' || typeof at === 'boolean' || (typeof at === 'number' && Number.isFinite(at)) ? at : undefined;
}

/** A value as it prints: a number as JSON has it (the shortest form that
 *  reads back, as Typst prints a float), or rounded to `digits` decimals;
 *  a minus sign, not a hyphen (Typst prints `-3` as `−3`, and the page
 *  holds printed text); a string or a boolean as it is. */
export function formatValue(value: string | number | boolean, digits: number | null): string {
  if (typeof value !== 'number') return String(value);
  let text = digits === null ? String(value) : value.toFixed(digits);
  if (/e/i.test(text)) text = value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
  return text.replace(/^-/, '−');
}

/** Every scalar in `data` with its key, for the picker (at most `limit`). */
export function flattenValues(data: unknown, limit = 400): Array<{ name: string; value: string | number | boolean }> {
  const out: Array<{ name: string; value: string | number | boolean }> = [];
  const walk = (at: unknown, path: string) => {
    if (out.length >= limit) return;
    if (typeof at === 'string' || typeof at === 'boolean' || (typeof at === 'number' && Number.isFinite(at))) {
      if (path && VALUE_NAME_RE.test(path)) out.push({ name: path, value: at });
    } else if (Array.isArray(at)) at.forEach((v, i) => walk(v, path ? `${path}.${i}` : String(i)));
    else if (at && typeof at === 'object') for (const [k, v] of Object.entries(at)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(data, '');
  return out;
}

// ---------------------------------------------------------------------------
// The file

interface ValuesReader {
  statAsset(path: string): Promise<{ mtime: number; size: number } | null>;
  readAsset(path: string, maxBytes?: number): Promise<{ data: Uint8Array } | null>;
}

let reader: ValuesReader | null = null;

/** The file manager values.json is read through (main.ts). */
export function setValuesReader(r: ValuesReader) {
  reader = r;
}

/** values.json's content: null when there is none or it is not JSON. */
type Loaded = { data: unknown; fingerprint: string } | { data: null; fingerprint: string };

async function loadValues(previous: string | null): Promise<Loaded | 'same'> {
  const stat = reader ? await reader.statAsset(VALUES_FILE).catch(() => null) : null;
  const fingerprint = stat ? `${stat.mtime}:${stat.size}` : 'missing';
  if (fingerprint === previous) return 'same';
  if (!stat || stat.size > VALUES_BYTES) return { data: null, fingerprint };
  try {
    const file = await reader!.readAsset(VALUES_FILE, VALUES_BYTES);
    if (!file) return { data: null, fingerprint };
    return { data: JSON.parse(new TextDecoder().decode(file.data)), fingerprint };
  } catch {
    return { data: null, fingerprint };
  }
}

// ---------------------------------------------------------------------------
// The plugin

interface ValuesState {
  /** values.json's content (null: none, or not JSON). */
  data: unknown;
  loaded: boolean;
  decorations: DecorationSet;
}

export const valuesKey = new PluginKey<ValuesState>('values');

/** The value runs in `doc`: each stretch of text under one value mark. */
function valueRuns(doc: PMNode): Array<{ from: number; to: number; mark: Mark; text: string }> {
  const runs: Array<{ from: number; to: number; mark: Mark; text: string }> = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const mark = node.marks.find((m) => m.type.name === 'value');
    if (!mark) return false;
    const last = runs[runs.length - 1];
    if (last && last.to === pos && last.mark.eq(mark)) {
      last.to = pos + node.nodeSize;
      last.text += node.text ?? '';
    } else runs.push({ from: pos, to: pos + node.nodeSize, mark, text: node.text ?? '' });
    return false;
  });
  return runs;
}

/** The formulas in `doc` that hold a value (`\val`, math-src.ts). */
function mathValRuns(doc: PMNode): Array<{ pos: number; node: PMNode; runs: ValRun[] }> {
  const out: Array<{ pos: number; node: PMNode; runs: ValRun[] }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'math_inline' && node.type.name !== 'math_display') return !node.isAtom || node.isTextblock || node.isBlock;
    const runs = valRuns(String(node.attrs.src ?? ''));
    if (runs.length) out.push({ pos, node, runs });
    return false;
  });
  return out;
}

/** The value keys `doc` names, in the text and in its formulas, once each. */
export function valueNames(doc: PMNode): string[] {
  const names = new Set<string>();
  for (const run of valueRuns(doc)) names.add(String(run.mark.attrs.name));
  for (const m of mathValRuns(doc)) for (const run of m.runs) names.add(run.name);
  return [...names];
}

function decorate(doc: PMNode, data: unknown, loaded: boolean): DecorationSet {
  const decorations: Decoration[] = [];
  const attrsFor = (names: string[]) => {
    const missing = loaded ? names.filter((name) => lookupValue(data, name) === undefined) : [];
    return {
      class: missing.length ? 'ts-value-missing' : 'ts-value-live',
      title: missing.length ? `${missing.join(', ')}: not in ${VALUES_FILE} — the last value is kept` : `${names.join(', ')} from ${VALUES_FILE}`,
    };
  };
  for (const run of valueRuns(doc)) decorations.push(Decoration.inline(run.from, run.to, attrsFor([run.mark.attrs.name as string])));
  for (const m of mathValRuns(doc)) decorations.push(Decoration.node(m.pos, m.pos + m.node.nodeSize, attrsFor(m.runs.map((r) => r.name))));
  return DecorationSet.create(doc, decorations);
}

/** The transaction that brings every value's text up to date, or null. */
export function refreshValues(state: EditorState, data: unknown): Transaction | null {
  const tr = state.tr;
  // Formulas first: an atom's markup keeps its size, so the text runs'
  // positions hold.
  for (const m of mathValRuns(state.doc)) {
    const texts = m.runs.map((run) => {
      const value = lookupValue(data, run.name);
      return value === undefined ? run.text : formatValue(value, run.digits) || run.text;
    });
    const src = withValTexts(String(m.node.attrs.src), m.runs, texts);
    if (src !== m.node.attrs.src) tr.setNodeMarkup(m.pos, undefined, { ...m.node.attrs, src });
  }
  for (const run of valueRuns(state.doc).reverse()) {
    const value = lookupValue(data, run.mark.attrs.name as string);
    if (value === undefined) continue;
    const text = formatValue(value, digitsOf(run.mark.attrs.digits));
    if (text === run.text || !text) continue;
    const marks = state.doc.resolve(run.from + 1).marks();
    tr.replaceWith(run.from, run.to, state.schema.text(text, marks.some((m) => m.eq(run.mark)) ? marks : [...marks, run.mark]));
  }
  if (!tr.docChanged) return null;
  return tr.setMeta('addToHistory', false).setMeta(valuesKey, 'refresh');
}

interface Active {
  from: number;
  to: number;
  query: string;
}

/** `{{query` right before the caret, in a text block. */
function activeQuery(state: EditorState): Active | null {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty || !sel.$from.parent.inlineContent) return null;
  const before = sel.$from.parent.textBetween(Math.max(0, sel.$from.parentOffset - 80), sel.$from.parentOffset, undefined, '￼');
  const m = /\{\{([\w.\-:]*)$/.exec(before);
  if (!m) return null;
  if (sel.$from.marks().some((mk) => mk.type.name === 'code')) return null;
  return { from: sel.from - m[0].length, to: sel.from, query: m[1] };
}

/** Insert the value `name` (rounded to `digits`) over `{{query`. */
export function insertValue(view: EditorView, active: { from: number; to: number }, name: string, digits: number | null): boolean {
  const state = view.state;
  const data = valuesKey.getState(state)?.data;
  const value = lookupValue(data, name);
  if (value === undefined) return false;
  const mark = state.schema.marks.value.create({ name, digits });
  const marks = state.doc.resolve(active.from).marks().filter((m) => m.type.name !== 'value');
  const tr = state.tr.replaceWith(active.from, active.to, state.schema.text(formatValue(value, digits), [...marks, mark]));
  tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(active.to))).removeStoredMark(mark.type);
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** What the picker needs: the values on hand, and what a pick does. */
export interface ValueMenuHost {
  values(): { loaded: boolean; data: unknown };
  pick(name: string, digits: number | null): void;
}

/** The `{{` picker: a list of keys with their values, filtered by what is
 *  typed after `{{` (`:2` after it rounds), placed under an anchor. The
 *  editor's plugin and the formula editor (math.ts) each drive one. */
export class ValueMenu {
  private menu: HTMLDivElement | null = null;
  private items: HTMLElement[] = [];
  private selected = 0;
  private signature = '';
  private digits: number | null = null;

  constructor(private readonly host: ValueMenuHost) {}

  get open(): boolean {
    return this.menu !== null;
  }

  close(): void {
    this.menu?.remove();
    this.menu = null;
    this.items = [];
    this.signature = '';
  }

  /** Show the keys matching `query` (what follows `{{`) at `anchor`. */
  show(query: string, anchor: { left: number; bottom: number }): void {
    const [q, dec] = query.split(':');
    this.digits = dec === undefined ? null : digitsOf(dec);
    const st = this.host.values();
    const all = st.loaded && st.data !== null ? flattenValues(st.data) : [];
    const needle = (q ?? '').toLowerCase();
    const matches = all.filter((v) => v.name.toLowerCase().includes(needle)).slice(0, 10);
    const sig = `${query}|${st.loaded}|${matches.map((m) => `${m.name}=${m.value}`).join(',')}`;
    if (!this.menu) {
      this.menu = document.createElement('div');
      this.menu.className = 'ref-menu value-menu';
      this.menu.setAttribute('role', 'listbox');
      this.menu.setAttribute('aria-label', 'Values');
      document.body.appendChild(this.menu);
    }
    const menu = this.menu;
    if (sig !== this.signature) {
      this.signature = sig;
      this.selected = 0;
      this.items = [];
      menu.replaceChildren();
      if (!matches.length) {
        const none = !st.loaded || st.data === null;
        const empty = document.createElement('div');
        empty.className = 'ref-menu-item ref-menu-empty';
        empty.textContent = none ? `No ${VALUES_FILE} in this document’s folder.` : 'No value by that name.';
        const hint = document.createElement('span');
        hint.className = 'ref-menu-hint';
        hint.textContent = none ? 'Knuth writes it there when its code runs; open the folder with the document.' : 'Type part of a key; :2 after it rounds to two decimals.';
        empty.append(document.createElement('br'), hint);
        menu.append(empty);
      }
      for (const v of matches) {
        const el = document.createElement('div');
        el.className = 'ref-menu-item';
        el.setAttribute('role', 'option');
        const num = document.createElement('span');
        num.className = 'ref-menu-num';
        num.textContent = formatValue(v.value, this.digits);
        const label = document.createElement('span');
        label.className = 'ref-menu-label';
        label.textContent = v.name;
        el.dataset.name = v.name;
        el.append(num, label);
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          this.host.pick(v.name, this.digits);
          this.close();
        });
        menu.append(el);
        this.items.push(el);
      }
      this.paint();
    }
    menu.style.left = `${Math.min(anchor.left + window.scrollX, window.innerWidth - 300)}px`;
    menu.style.top = `${anchor.bottom + 4 + window.scrollY}px`;
  }

  private paint(): void {
    this.items.forEach((el, i) => el.classList.toggle('selected', i === this.selected));
  }

  /** The keys the open menu takes: true when it took `e`. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.menu) return false;
    if (e.key === 'Escape') {
      this.close();
      return true;
    }
    if (!this.items.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      this.selected = (this.selected + (e.key === 'ArrowDown' ? 1 : this.items.length - 1)) % this.items.length;
      this.paint();
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      const name = this.items[this.selected].dataset.name;
      if (name !== undefined) this.host.pick(name, this.digits);
      this.close();
      return true;
    }
    return false;
  }
}

export function valuesPlugin(): Plugin<ValuesState> {
  let active: Active | null = null;
  let viewRef: EditorView | null = null;
  const menu = new ValueMenu({
    values: () => {
      const st = viewRef ? valuesKey.getState(viewRef.state) : undefined;
      return { loaded: !!st?.loaded, data: st?.data ?? null };
    },
    pick: (name, digits) => {
      if (viewRef && active) insertValue(viewRef, active, name, digits);
      viewRef?.focus();
    },
  });
  const close = () => {
    menu.close();
    active = null;
  };

  const render = (view: EditorView) => {
    viewRef = view;
    const found = activeQuery(view.state);
    if (!found) {
      close();
      return;
    }
    active = found;
    const coords = view.coordsAtPos(found.from);
    menu.show(found.query, coords);
  };

  return new Plugin<ValuesState>({
    key: valuesKey,
    state: {
      init: (_config, state) => ({ data: null, loaded: false, decorations: decorate(state.doc, null, false) }),
      apply(tr, prev, _old, state) {
        const meta = tr.getMeta(valuesKey) as { data: unknown } | 'refresh' | undefined;
        if (meta && meta !== 'refresh') return { data: meta.data, loaded: true, decorations: decorate(state.doc, meta.data, true) };
        if (!tr.docChanged) return prev;
        return { ...prev, decorations: decorate(state.doc, prev.data, prev.loaded) };
      },
    },
    props: {
      decorations: (state) => valuesKey.getState(state)?.decorations ?? DecorationSet.empty,
      handleKeyDown(view, e) {
        if (!menu.open || !active) return false;
        viewRef = view;
        return menu.handleKey(e);
      },
    },
    view(view) {
      let fingerprint: string | null = null;
      let disposed = false;
      let checking = false;
      let refreshTimer = 0;
      /** Bring the texts up to date a moment after the document settles. */
      const scheduleRefresh = () => {
        window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(() => {
          const st = valuesKey.getState(view.state);
          if (disposed || !st?.loaded || st.data === null || view.composing) return;
          const tr = refreshValues(view.state, st.data);
          if (tr) view.dispatch(tr);
        }, 250);
      };
      const check = async () => {
        if (checking || disposed) return;
        checking = true;
        try {
          const loaded = await loadValues(fingerprint);
          if (disposed || loaded === 'same') return;
          fingerprint = loaded.fingerprint;
          view.dispatch(view.state.tr.setMeta(valuesKey, { data: loaded.data }).setMeta('addToHistory', false));
          scheduleRefresh();
        } finally {
          checking = false;
        }
      };
      void check();
      const interval = window.setInterval(() => void check(), 2000);
      const onBlur = () => close();
      view.dom.addEventListener('blur', onBlur);
      return {
        update(v, prevState) {
          render(v);
          // An edit, or a document opened in its place: its values are
          // brought up to date once it settles. (Another folder's file is
          // seen at the next poll: its fingerprint differs.)
          if (v.state.doc !== prevState.doc) scheduleRefresh();
        },
        destroy() {
          disposed = true;
          window.clearInterval(interval);
          window.clearTimeout(refreshTimer);
          view.dom.removeEventListener('blur', onBlur);
          close();
        },
      };
    },
  });
}
