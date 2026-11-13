// The code block on the page (Taylor, 2026-11-12: "typora allows you to
// specify the language and formats it nicely").
//
// Colors. A block with a language is painted in the colors Typst prints
// it in, asked of the compiler (code-colors.ts) a moment after the block
// stops changing. Until an answer is in, the block keeps the colors it
// had, carried through the edit (a character typed inside a word takes
// the word's color), so nothing flashes plain while typing.
//
// Paint only, and by the one means that is: the CSS Custom Highlight API.
// The colors are ranges over the block's text, registered with the
// browser (`CSS.highlights`) and styled by `::highlight()` rules; the DOM
// is not touched and no box is made. Spans were tried first (inline
// decorations) and moved the glyphs: Chrome lays each inline box at 1/64
// px, so a line cut into colored pieces ended up to 1/64 px off where the
// uncut line ends (tests/code-colors.spec.ts holds every code line's
// right edge still). A highlight can only paint. A browser without the
// API (Firefox before 140, Safari before 17.2) shows the code plain.
//
// The language field. A small field at the block's bottom-right corner,
// Typora's place, shown while the caret is in the block and never
// printed: type a language, or pick one from the list under it. It is
// the fence's info string (```` ```python ````), nothing more. It sits
// on the paper, out of the flow (absolutely placed in the `pre`), so it
// follows the block with no geometry read and takes no height.

import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey, TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView, type NodeView, type ViewMutationRecord } from 'prosemirror-view';
import { CODE_LANGUAGES, cleanLanguage, fenceLang, isIslandParams } from './code-language';
import { getCodeColors, onCodeColors, wantCodeColors, type CodeSpan } from './code-colors';
import { schema } from './schema';

// ---------- colors ----------

interface ColorState {
  /** The colored runs, as decorations for what a DecorationSet does well
   *  (they follow the text through an edit). Never handed to the view:
   *  the painter below draws them as highlights. */
  inks: DecorationSet;
  /** The code blocks whose colors are the compiler's answer for the node
   *  as it stands (by identity: an unchanged block is not looked at again). */
  painted: Set<PMNode>;
  /** A block is waiting for its answer (it shows the colors it had). */
  waiting: boolean;
}

/** What a run is painted with (a decoration's spec). */
interface Ink {
  color: string | null;
  underline: boolean;
}

const colorsKey = new PluginKey<ColorState>('code-colors');

/** How long a block must stand unchanged before its colors are asked for.
 *  Shorter than the gap between keystrokes, so colors land between them;
 *  long enough that a burst of typing asks once. */
const ASK_AFTER_MS = 40;

const isCode = (node: PMNode) => node.type === schema.nodes.code_block;

const inkOf = (base: number, span: CodeSpan): Decoration =>
  Decoration.inline(base + span.from, base + span.to, {}, { color: span.color, underline: span.underline } satisfies Ink);

/** The textblocks a transaction touched, in the new document. */
function touchedTextblocks(tr: Transaction, visit: (node: PMNode, pos: number) => void): void {
  const size = tr.doc.content.size;
  tr.mapping.maps.forEach((map, i) => {
    const rest = tr.mapping.slice(i + 1);
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      const from = Math.max(0, rest.map(newStart, -1) - 1);
      const to = Math.min(size, rest.map(newEnd, 1) + 1);
      tr.doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isTextblock) return true;
        visit(node, pos);
        return false;
      });
    });
  });
}

/**
 * The colors of `doc`. `prev` is the state before (its runs already
 * carried through the change): a block it painted and that is the same
 * node is kept as it is; a block whose answer is in is painted afresh;
 * one still waiting keeps what it shows.
 */
function paint(doc: PMNode, prev: ColorState | null): ColorState {
  let inks = prev?.inks ?? DecorationSet.empty;
  const painted = new Set<PMNode>();
  let waiting = false;
  doc.descendants((node, pos) => {
    if (!isCode(node)) return !node.isTextblock;
    if (prev?.painted.has(node)) {
      painted.add(node);
      return false;
    }
    const lang = fenceLang(node.attrs.params as string);
    const spans = lang ? getCodeColors(lang, node.textContent) : [];
    if (spans === undefined) {
      waiting = true;
      return false;
    }
    const from = pos + 1;
    const old = inks.find(from, from + node.content.size);
    if (old.length) inks = inks.remove(old);
    if (spans.length) inks = inks.add(doc, spans.map((span) => inkOf(from, span)));
    painted.add(node);
    return false;
  });
  return { inks, painted, waiting };
}

/** The code block the caret is in (not an island), for the field. */
function activeCodeBlock(state: EditorState): { node: PMNode; pos: number } | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection)) return null;
  const { $head, $anchor } = selection;
  const node = $head.parent;
  if (!isCode(node) || !$head.sameParent($anchor) || isIslandParams(node.attrs.params as string)) return null;
  return { node, pos: $head.before() };
}

/** The blocks of `doc` whose colors are not in yet. */
function unanswered(doc: PMNode): Array<{ lang: string; text: string }> {
  const out: Array<{ lang: string; text: string }> = [];
  doc.descendants((node) => {
    if (!isCode(node)) return !node.isTextblock;
    const lang = fenceLang(node.attrs.params as string);
    if (lang) {
      const text = node.textContent;
      if (getCodeColors(lang, text) === undefined) out.push({ lang, text });
    }
    return false;
  });
  return out;
}

// ---------- the painter ----------

/** The browser can paint ranges (the CSS Custom Highlight API). */
const canPaint = () => typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined' && typeof StaticRange !== 'undefined';

/** The highlights' names start with this: one per color (and one more
 *  per underlined color), named by its hex. */
const CODE_INK_PREFIX = 'plass-code-';

const HEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/;
const STYLE_ID = 'plass-code-inks';
const styled = new Set<string>();

/** The highlight an ink paints with, made (and its `::highlight()` rule
 *  written) the first time the ink is seen. */
function highlightFor(ink: Ink): { name: string; highlight: Highlight } | null {
  if (ink.color !== null && !HEX.test(ink.color)) return null;
  const name = CODE_INK_PREFIX + (ink.underline ? 'u-' : '') + (ink.color ? ink.color.slice(1) : 'text');
  let highlight = CSS.highlights.get(name);
  if (!highlight) {
    highlight = new Highlight();
    CSS.highlights.set(name, highlight);
  }
  if (!styled.has(name)) {
    styled.add(name);
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }
    // The underline is in the ink's color, as Typst strokes it.
    const rule = (ink.color ? `color: ${ink.color};` : '') + (ink.underline ? ' text-decoration: underline;' : '');
    style.sheet?.insertRule(`::highlight(${name}) { ${rule} }`, style.sheet.cssRules.length);
  }
  return { name, highlight };
}

interface PaintedBlock {
  node: PMNode;
  answered: boolean;
  text: ChildNode | null;
  ranges: Array<{ highlight: Highlight; range: AbstractRange }>;
}

/** Draws the state's runs as highlight ranges over each block's text. A
 *  block is drawn again only when it changed: its node, whether its
 *  answer is in, or the text node the ranges point into. */
class CodePainter {
  private readonly blocks = new Map<Element, PaintedBlock>();

  sync(view: EditorView): void {
    const state = colorsKey.getState(view.state);
    if (!state) return;
    const seen = new Set<Element>();
    view.state.doc.descendants((node, pos) => {
      if (!isCode(node)) return !node.isTextblock;
      const pre = view.nodeDOM(pos);
      const code = pre instanceof HTMLElement ? pre.firstElementChild : null;
      if (!code) return false;
      seen.add(code);
      const answered = state.painted.has(node);
      const text = code.firstChild;
      const was = this.blocks.get(code);
      if (was && was.node === node && was.answered === answered && was.text === text) return false;
      if (was) this.clear(was);
      const from = pos + 1;
      const ranges: PaintedBlock['ranges'] = [];
      // The block's text is one text node (code holds no marks): a run's
      // offsets are that node's. Anything else (a composition's own text
      // node) is asked of the view.
      const whole = text instanceof Text && text.length === node.content.size ? text : null;
      for (const ink of state.inks.find(from, from + node.content.size)) {
        const made = highlightFor(ink.spec as Ink);
        if (!made) continue;
        let range: AbstractRange;
        try {
          if (whole) {
            range = new StaticRange({ startContainer: whole, startOffset: ink.from - from, endContainer: whole, endOffset: ink.to - from });
          } else {
            const start = view.domAtPos(ink.from, 1);
            const end = view.domAtPos(ink.to, -1);
            range = new StaticRange({ startContainer: start.node, startOffset: start.offset, endContainer: end.node, endOffset: end.offset });
          }
        } catch {
          continue;
        }
        made.highlight.add(range);
        ranges.push({ highlight: made.highlight, range });
      }
      this.blocks.set(code, { node, answered, text, ranges });
      return false;
    });
    for (const [code, block] of this.blocks) {
      if (seen.has(code)) continue;
      this.clear(block);
      this.blocks.delete(code);
    }
  }

  private clear(block: PaintedBlock): void {
    for (const { highlight, range } of block.ranges) highlight.delete(range);
    block.ranges = [];
  }

  destroy(): void {
    for (const block of this.blocks.values()) this.clear(block);
    this.blocks.clear();
  }
}

export function codeBlockPlugin(): Plugin {
  return new Plugin<ColorState>({
    key: colorsKey,
    state: {
      init: (_config, state) => paint(state.doc, null),
      apply(tr, prev) {
        if (!tr.docChanged) return tr.getMeta(colorsKey) ? paint(tr.doc, prev) : prev;
        let inks = prev.inks.map(tr.mapping, tr.doc);
        // A block that stopped being code (turned into a paragraph, joined
        // into one) carried its runs along: off they come. Only a block
        // the change touched can be one.
        const strays: Decoration[] = [];
        touchedTextblocks(tr, (node, pos) => {
          if (!isCode(node)) strays.push(...inks.find(pos, pos + node.nodeSize));
        });
        if (strays.length) inks = inks.remove(strays);
        return paint(tr.doc, { ...prev, inks });
      },
    },
    props: {
      // The one decoration: a class on the block the caret is in, which
      // shows its language field (style.css). No color is a decoration.
      decorations(state) {
        const active = activeCodeBlock(state);
        if (!active) return null;
        return DecorationSet.create(state.doc, [Decoration.node(active.pos, active.pos + active.node.nodeSize, { class: 'code-active' })]);
      },
    },
    view(view) {
      // No painter, no colors asked for: the code stays plain.
      if (!canPaint()) return {};
      const painter = new CodePainter();
      let timer = 0;
      const ask = () => {
        timer = 0;
        wantCodeColors(unanswered(view.state.doc));
      };
      const schedule = () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(ask, ASK_AFTER_MS);
      };
      const repaint = () => {
        if (view.isDestroyed || !colorsKey.getState(view.state)?.waiting) return;
        // Not while an IME composes (the view is left alone then, as the
        // layout leaves it: typeset-plugin's holdForComposition); what is
        // owed is painted when the composition ends.
        if (view.composing) return;
        view.dispatch(view.state.tr.setMeta(colorsKey, true).setMeta('addToHistory', false));
      };
      const off = onCodeColors(repaint);
      // ProseMirror ends the composition in its own compositionend
      // handler, after this one: the repaint waits a turn.
      const composed = () => window.setTimeout(repaint, 60);
      view.dom.addEventListener('compositionend', composed);
      painter.sync(view);
      if (colorsKey.getState(view.state)?.waiting) ask();
      return {
        update(next, prev) {
          if (next.state.doc === prev.doc && colorsKey.getState(next.state) === colorsKey.getState(prev)) return;
          painter.sync(next);
          if (next.state.doc !== prev.doc && colorsKey.getState(next.state)?.waiting) schedule();
        },
        destroy() {
          window.clearTimeout(timer);
          off();
          view.dom.removeEventListener('compositionend', composed);
          painter.destroy();
        },
      };
    },
  });
}

// ---------- the fence ----------

/**
 * Enter on a line that is only a code fence makes the code block, with
 * the language typed after the backticks (```` ``` ````, ```` ```python ````):
 * Typora's way (Taylor, 2026-11-12). Until then the third backtick made
 * the block at once, and a language could not be typed on the page at all.
 * The line must be plain text and the caret at its end; the word is the
 * fence's info string (code-language.ts), a language Typst knows or not.
 */
export const enterFence: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  const line = $from.parent;
  if (!empty || line.type !== schema.nodes.paragraph || $from.parentOffset !== line.content.size) return false;
  if (line.childCount !== 1 || !line.firstChild!.isText || line.firstChild!.marks.length) return false;
  const fence = /^```[ \t]*([A-Za-z0-9_+#.-]*)$/.exec(line.textContent);
  if (!fence) return false;
  const lang = cleanLanguage(fence[1]);
  if (lang !== fence[1]) return false;
  const index = $from.index(-1);
  if (!$from.node(-1).canReplaceWith(index, index + 1, schema.nodes.code_block)) return false;
  if (dispatch) {
    const pos = $from.before();
    const tr = state.tr.replaceWith(pos, pos + line.nodeSize, schema.nodes.code_block.create({ params: lang }));
    dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 1)).scrollIntoView());
  }
  return true;
};

// ---------- the language field ----------

/** What the list offers for what is typed: the languages whose word or
 *  name starts with it, then those that hold it, an exact word first. */
export function languageMatches(typed: string): Array<{ tag: string; name: string }> {
  const needle = typed.trim().toLowerCase();
  if (!needle) return [...CODE_LANGUAGES];
  const rank = (l: { tag: string; name: string }) => {
    const tag = l.tag.toLowerCase();
    const name = l.name.toLowerCase();
    if (tag === needle || name === needle) return 0;
    if (tag.startsWith(needle) || name.startsWith(needle)) return 1;
    return tag.includes(needle) || name.includes(needle) ? 2 : 3;
  };
  return CODE_LANGUAGES.map((l, i) => ({ l, r: rank(l), i }))
    .filter((x) => x.r < 3)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.l);
}

/** The list under the field: the languages matching what is typed, and
 *  the typed word itself when it is none of them (any word may be a
 *  language: Typst knows more than the list, and what it does not know
 *  is kept and printed plain). */
class LanguageMenu {
  private el: HTMLDivElement | null = null;
  private rows: Array<{ tag: string; el: HTMLElement }> = [];
  private selected = -1;

  constructor(private readonly pick: (tag: string) => void) {}

  get open(): boolean {
    return this.el !== null;
  }

  /** The row Enter takes, if one is lit. */
  get choice(): string | null {
    return this.rows[this.selected]?.tag ?? null;
  }

  close(): void {
    this.el?.remove();
    this.el = null;
    this.rows = [];
    this.selected = -1;
  }

  show(typed: string, anchor: HTMLElement): void {
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'ref-menu code-lang-menu';
      this.el.setAttribute('role', 'listbox');
      this.el.setAttribute('aria-label', 'Languages');
      document.body.appendChild(this.el);
    }
    const menu = this.el;
    const word = cleanLanguage(typed);
    const matches = languageMatches(typed);
    this.rows = [];
    menu.replaceChildren();
    const row = (tag: string, name: string, hint: string) => {
      const el = document.createElement('div');
      el.className = 'ref-menu-item';
      el.setAttribute('role', 'option');
      el.dataset.tag = tag;
      const label = document.createElement('span');
      label.textContent = name;
      const code = document.createElement('span');
      code.className = 'ref-menu-label';
      code.textContent = hint;
      el.append(label, code);
      // A press, not a click: the field keeps the focus until the pick.
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.pick(tag);
      });
      menu.append(el);
      this.rows.push({ tag, el });
    };
    for (const l of matches) row(l.tag, l.name, l.tag);
    if (word && !matches.some((l) => l.tag.toLowerCase() === word.toLowerCase())) row(word, word, 'as typed');
    // The first match is lit once something is typed (Enter takes it); an
    // empty field lights nothing, and Enter there clears the language.
    this.selected = word && this.rows.length ? 0 : -1;
    this.paint();
    if (!this.rows.length) {
      this.close();
      return;
    }
    this.place(anchor);
  }

  /** Under the field, or over it where there is no room under. */
  place(anchor: HTMLElement): void {
    const menu = this.el;
    if (!menu) return;
    const at = anchor.getBoundingClientRect();
    const height = menu.offsetHeight;
    const below = at.bottom + 4 + height <= window.innerHeight;
    menu.style.left = `${Math.max(8, Math.min(at.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)) + window.scrollX}px`;
    menu.style.top = `${(below ? at.bottom + 4 : Math.max(8, at.top - 4 - height)) + window.scrollY}px`;
  }

  move(by: 1 | -1): void {
    if (!this.rows.length) return;
    this.selected = this.selected < 0 ? (by > 0 ? 0 : this.rows.length - 1) : (this.selected + by + this.rows.length) % this.rows.length;
    this.paint();
  }

  private paint(): void {
    this.rows.forEach((r, i) => {
      r.el.classList.toggle('selected', i === this.selected);
      r.el.setAttribute('aria-selected', String(i === this.selected));
    });
    this.rows[this.selected]?.el.scrollIntoView({ block: 'nearest' });
  }
}

/** A code block: the `pre > code` the schema writes, and the language
 *  field beside the code, out of the flow. */
export class CodeBlockView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private readonly holder: HTMLElement;
  private readonly field: HTMLInputElement;
  private readonly menu: LanguageMenu;
  /** The field's edit is over (committed or abandoned): its blur writes
   *  nothing. */
  private settled = true;
  /** What the element last showed of the node, so `update` (every
   *  keystroke in the block) writes nothing that did not change. */
  private params: string | null = null;
  private tight: string | null = null;
  /** The open list stays under its field while the paper scrolls. */
  private readonly follow = () => this.menu.place(this.field);

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.dom = document.createElement('pre');
    this.contentDOM = document.createElement('code');
    this.holder = document.createElement('span');
    this.holder.className = 'code-lang';
    this.holder.contentEditable = 'false';
    this.field = document.createElement('input');
    this.field.type = 'text';
    this.field.className = 'code-lang-field';
    this.field.placeholder = 'language';
    this.field.spellcheck = false;
    this.field.autocomplete = 'off';
    this.field.autocapitalize = 'off';
    this.field.setAttribute('aria-label', 'Code language');
    this.field.title = 'The language this code is colored as, on the page and in print';
    this.holder.append(this.field);
    this.dom.append(this.contentDOM, this.holder);
    this.menu = new LanguageMenu((tag) => this.finish(tag));

    // A press on the resting field takes all of its word (a caret placed
    // by the press would undo the selection the focus makes).
    this.field.addEventListener('mousedown', (e) => {
      if (document.activeElement === this.field) return;
      e.preventDefault();
      this.field.focus();
    });
    this.field.addEventListener('focus', () => {
      this.settled = false;
      this.field.select();
      this.menu.show('', this.field);
      window.addEventListener('scroll', this.follow, true);
      window.addEventListener('resize', this.follow);
    });
    this.field.addEventListener('input', () => {
      this.size();
      this.menu.show(this.field.value, this.field);
    });
    this.field.addEventListener('keydown', (e) => this.key(e));
    this.field.addEventListener('blur', () => {
      // Leaving the field keeps what was typed, as typed.
      if (!this.settled) this.commit(this.field.value);
      this.settled = true;
      this.closeMenu();
      this.word();
    });
    this.sync();
  }

  private closeMenu(): void {
    this.menu.close();
    window.removeEventListener('scroll', this.follow, true);
    window.removeEventListener('resize', this.follow);
  }

  private key(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this.menu.open) this.menu.show(this.field.value, this.field);
      else this.menu.move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      this.finish(this.menu.choice ?? this.field.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.settled = true;
      this.view.focus();
    }
  }

  /** Take `tag` and hand the caret back to the code. */
  private finish(tag: string): void {
    this.settled = true;
    this.commit(tag);
    this.view.focus();
  }

  private commit(typed: string): void {
    const tag = cleanLanguage(typed);
    const pos = this.getPos();
    if (pos === undefined || tag === fenceLang(this.node.attrs.params as string)) return;
    const node = this.view.state.doc.nodeAt(pos);
    if (!node || !isCode(node)) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, params: tag }));
  }

  /** The node's attributes on the element (the schema's toDOM), and the
   *  field's word unless it is being typed in. Only what changed. */
  private sync(): void {
    const params = this.node.attrs.params as string;
    const tight = this.node.attrs.tight as string;
    if (params !== this.params) {
      this.params = params;
      if (params) this.dom.setAttribute('data-params', params);
      else this.dom.removeAttribute('data-params');
      if (document.activeElement !== this.field) this.word();
    }
    if (tight !== this.tight) {
      this.tight = tight;
      if (tight) this.dom.setAttribute('data-tight', tight);
      else this.dom.removeAttribute('data-tight');
    }
  }

  /** The field shows the block's language. */
  private word(): void {
    this.field.value = fenceLang(this.node.attrs.params as string);
    this.size();
  }

  /** The field is as wide as its word (the placeholder when empty). */
  private size(): void {
    this.field.style.width = `${Math.max(this.field.value.length, this.field.value ? 2 : this.field.placeholder.length) + 1}ch`;
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.sync();
    return true;
  }

  stopEvent(event: Event): boolean {
    return this.holder.contains(event.target as Node);
  }

  ignoreMutation(m: ViewMutationRecord): boolean {
    if (m.type === 'selection') return document.activeElement === this.field;
    return !this.contentDOM.contains(m.target);
  }

  destroy(): void {
    this.settled = true;
    this.closeMenu();
  }
}
