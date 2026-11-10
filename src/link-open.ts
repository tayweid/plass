// Links on the page (2026-11-09). Every link is drawn in the link blue,
// underlined, as print shows it (text-color.ts LINK_COLOR): a Markdown
// link's <a> by style.css, a bare URL in the text by a decoration this
// plugin keeps (the same scan the print links it by, urls.ts), a URL in a
// table's caption or a running header by `linkedText`. Code is code: a URL
// in inline code or a code block is text, as Typst's raw prints it.
//
// Opening a link from the page. Chrome never follows a link
// inside editable text, and a plain click is how the caret gets into a
// link's words, so a link opens on ⌘-click (Ctrl-click off a Mac), as in
// Word, Typora and iA Writer. Two kinds open: a Markdown link (the `link`
// mark, an <a href> on the page) and a bare URL in the text, found by the
// same scan the print uses to link it (typ-serializer's `escapePieces`,
// `linkPrefixScan`). Resting the mouse on either shows a hint with the
// gesture (and a Markdown link's address); holding ⌘ over one turns the
// pointer into a hand. Web and mail addresses open, in a new tab; in
// Plass.app the shell hands them to the default browser
// (setWindowOpenHandler → shell.openExternal). Anything else (a relative
// path, another scheme) says so instead.

import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { notify } from './notify';
import { bareUrlAt, bareUrls, opensFromPage } from './urls';

export { bareUrlAt, opensFromPage };

const isMac = () => typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const gesture = () => (isMac() ? '⌘-click to open' : 'Ctrl-click to open');
const modifierHeld = (e: MouseEvent | KeyboardEvent) => (isMac() ? e.metaKey : e.ctrlKey);

interface Hit {
  url: string;
  /** A Markdown link: its address is not on the page, so the hint shows it. */
  marked: boolean;
  /** The link's line boxes on the screen (one per line it runs over). */
  rects: DOMRect[];
}

/** `text` as DOM with each bare URL in it a link span (`.ts-url`, its
 *  address in `data-url`): a table caption's widget, a running header. */
export function linkedText(text: string): Node[] {
  const out: Node[] = [];
  let at = 0;
  for (const u of bareUrls(text)) {
    if (u.from > at) out.push(document.createTextNode(text.slice(at, u.from)));
    const span = document.createElement('span');
    span.className = 'ts-url';
    span.dataset.url = u.url;
    span.textContent = u.url;
    out.push(span);
    at = u.to;
  }
  if (at < text.length || !out.length) out.push(document.createTextNode(text.slice(at)));
  return out;
}

/** The bare URLs of the text in [from, to) as inline decorations: the
 *  textblocks the range touches, whole. Not in code (a code block, an
 *  island, inline code) nor in a Markdown link's own text. */
function urlDecorations(doc: PMNode, from: number, to: number): Decoration[] {
  const out: Decoration[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'code_block') return false;
    if (!node.isTextblock) return true;
    node.forEach((child, offset) => {
      if (!child.isText || !child.text || child.marks.some((m) => m.type.name === 'code' || m.type.name === 'link')) return;
      for (const u of bareUrls(child.text)) {
        out.push(Decoration.inline(pos + 1 + offset + u.from, pos + 1 + offset + u.to, { class: 'ts-url' }));
      }
    });
    return false;
  });
  return out;
}

/** The URL decorations after `tr`: mapped, and the textblocks it changed
 *  scanned again (a keystroke scans one paragraph). */
function updateUrls(set: DecorationSet, tr: Transaction): DecorationSet {
  if (!tr.docChanged) return set;
  const doc = tr.doc;
  set = set.map(tr.mapping, doc);
  const ranges: Array<[number, number]> = [];
  tr.mapping.maps.forEach((map, i) => {
    const after = tr.mapping.slice(i + 1);
    map.forEach((_a, _b, from, to) => ranges.push([after.map(from, -1), after.map(to, 1)]));
  });
  for (const [a, b] of ranges) {
    const $a = doc.resolve(Math.max(0, Math.min(a, doc.content.size)));
    const $b = doc.resolve(Math.max(0, Math.min(b, doc.content.size)));
    const from = $a.parent.isTextblock ? $a.start() : $a.pos;
    const to = $b.parent.isTextblock ? $b.end() : $b.pos;
    set = set.remove(set.find(from, to)).add(doc, urlDecorations(doc, from, to));
  }
  return set;
}

/** A URL painted in the page chrome behind the text (a running header or
 *  footer, #pages), under the screen point. */
function chromeUrlAt(x: number, y: number): Hit | null {
  const el = document.elementsFromPoint(x, y).find((e) => e instanceof HTMLElement && e.matches('#pages .ts-url[data-url]'));
  return el instanceof HTMLElement ? { url: el.dataset.url ?? '', marked: false, rects: [...el.getClientRects()] } : null;
}

const inside = (r: DOMRect, x: number, y: number) => x >= r.left - 0.5 && x <= r.right + 0.5 && y >= r.top - 0.5 && y <= r.bottom + 0.5;

/** The link under the screen point (x, y), if any. */
function linkAt(view: EditorView, x: number, y: number, target: EventTarget | null): Hit | null {
  const el = target instanceof Element ? target : null;
  // A Markdown link: the mark's <a>, in the editable text (not an <a>
  // inside a figure's SVG or other non-text content).
  const a = el?.closest('a[href]');
  if (a instanceof HTMLAnchorElement && view.dom.contains(a) && a.isContentEditable) {
    return { url: a.getAttribute('href') ?? '', marked: true, rects: [...a.getClientRects()] };
  }
  // A URL painted outside the text (a table's caption widget).
  const painted = el?.closest('.ts-url[data-url]');
  if (painted instanceof HTMLElement && !painted.isContentEditable) {
    return { url: painted.dataset.url ?? '', marked: false, rects: [...painted.getClientRects()] };
  }
  // Not text (a page gap, other chrome): a running header behind it.
  if (el instanceof HTMLElement && !el.isContentEditable) return chromeUrlAt(x, y);
  // A bare URL: the text node at the point, scanned as the print scans it.
  const at = view.posAtCoords({ left: x, top: y });
  if (!at) return null;
  const $pos = view.state.doc.resolve(at.pos);
  if (!$pos.parent.inlineContent) return null;
  const start = $pos.start();
  const off = $pos.parentOffset;
  // The click lands between two characters: the text on either side.
  for (const side of [-1, 0]) {
    const index = off + side;
    if (index < 0 || index >= $pos.parent.content.size) continue;
    const { node, offset } = $pos.parent.childAfter(index);
    if (!node?.isText || !node.text) continue;
    const hit = bareUrlAt(node.text, index - offset);
    if (!hit) continue;
    const rects = textRects(view, start + offset + hit.from, start + offset + hit.to);
    if (rects.some((r) => inside(r, x, y))) return { url: hit.url, marked: false, rects };
  }
  return null;
}

/** The screen boxes of the document range [from, to). */
function textRects(view: EditorView, from: number, to: number): DOMRect[] {
  try {
    const a = view.domAtPos(from, 1);
    const b = view.domAtPos(to, -1);
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    return [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  } catch {
    return [];
  }
}

function open(url: string): void {
  const href = url.trim();
  if (!opensFromPage(href)) {
    notify(`Only web and email links open from the page (this one is “${href}”)`);
    return;
  }
  window.open(href, '_blank', 'noopener,noreferrer');
}

/** The hover hint: one element on the body, the scroll rail label's dark
 *  glass (src/style.css #link-hint), never in the editable DOM. */
class LinkHint {
  readonly el: HTMLDivElement;
  private timer = 0;
  private shown: string | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'link-hint';
    this.el.setAttribute('role', 'tooltip');
    this.el.setAttribute('aria-hidden', 'true');
    document.body.append(this.el);
  }

  /** Show the hint for `hit` after a rest, below the line under (x, y). */
  want(hit: Hit, x: number, y: number): void {
    const key = `${hit.url}\n${hit.rects[0]?.top ?? 0}`;
    if (this.shown === key) return;
    this.hide();
    this.timer = window.setTimeout(() => {
      const line = hit.rects.find((r) => inside(r, x, y)) ?? hit.rects[0];
      if (!line) return;
      const parts: HTMLElement[] = [];
      if (hit.marked) parts.push(span('u', hit.url));
      parts.push(span('g', opensFromPage(hit.url) ? gesture() : 'Not a web or email link'));
      this.el.replaceChildren(...parts);
      this.el.classList.add('show');
      const w = this.el.offsetWidth;
      const h = this.el.offsetHeight;
      const left = Math.max(8, Math.min(innerWidth - w - 8, x - 12));
      const below = line.bottom + 6;
      this.el.style.left = `${left}px`;
      this.el.style.top = `${below + h + 8 > innerHeight ? line.top - h - 6 : below}px`;
      this.shown = key;
    }, 450);
  }

  hide(): void {
    clearTimeout(this.timer);
    this.timer = 0;
    this.shown = null;
    this.el.classList.remove('show');
  }

  destroy(): void {
    this.hide();
    this.el.remove();
  }
}

function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

/** ⌘-click (Ctrl-click) opens the link under the pointer; resting on one
 *  shows the hint; ⌘ held over one shows a hand. */
export function linkOpenPlugin(): Plugin {
  let over: Hit | null = null;
  let hint: LinkHint | null = null;
  let editor: EditorView | null = null;

  const armed = (on: boolean) => editor?.dom.classList.toggle('ts-link-armed', on);
  // Chrome delivers mousemove once a frame at most, and a hit is one
  // posAtCoords and a scan of one text node.
  const track = (view: EditorView, e: MouseEvent) => {
    // No hint while a drag selects.
    over = e.buttons === 0 ? linkAt(view, e.clientX, e.clientY, e.target) : null;
    armed(Boolean(over) && modifierHeld(e));
    if (over) hint?.want(over, e.clientX, e.clientY);
    else hint?.hide();
  };
  const leave = () => {
    over = null;
    armed(false);
    hint?.hide();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Meta' || e.key === 'Control') armed(Boolean(over) && modifierHeld(e));
    else hint?.hide();
  };
  const onScroll = () => hint?.hide();
  // A running header's URL in a page's top margin, which is the editor's
  // padding, outside the text's DOM (one in a page gap reaches handleClick).
  const onChromeClick = (e: MouseEvent) => {
    if (e.button !== 0 || !modifierHeld(e) || !editor || (e.target instanceof Node && editor.dom.contains(e.target))) return;
    const hit = chromeUrlAt(e.clientX, e.clientY);
    if (!hit) return;
    e.preventDefault();
    open(hit.url);
  };

  return new Plugin({
    state: {
      init: (_config, state) => DecorationSet.create(state.doc, urlDecorations(state.doc, 0, state.doc.content.size)),
      apply: (tr, set) => updateUrls(set, tr),
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
      handleClick(view, _pos, event) {
        if (event.button !== 0 || !modifierHeld(event) || event.shiftKey || event.altKey) return false;
        const hit = linkAt(view, event.clientX, event.clientY, event.target);
        if (!hit) return false;
        hint?.hide();
        open(hit.url);
        return true;
      },
      handleDOMEvents: {
        mousemove: (view, event) => {
          track(view, event);
          return false;
        },
        mouseleave: () => {
          leave();
          return false;
        },
        mousedown: () => {
          hint?.hide();
          return false;
        },
        // The open happened on the press's release (handleClick); the
        // click that follows must not follow the <a> as well. A table
        // caption's URL opens here: its press never reaches handleClick
        // (block-chrome.ts takes it), and this runs before its click.
        click: (_view, event) => {
          if (!modifierHeld(event) || !(event.target instanceof Element)) return false;
          const painted = event.target.closest('.ts-url[data-url]');
          if (painted instanceof HTMLElement && !painted.isContentEditable) {
            event.preventDefault();
            hint?.hide();
            open(painted.dataset.url ?? '');
            return true;
          }
          if (event.target.closest('a[href]')) event.preventDefault();
          return false;
        },
      },
    },
    view(view) {
      editor = view;
      hint = new LinkHint();
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('keyup', onKey, true);
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('blur', leave);
      document.addEventListener('click', onChromeClick, true);
      return {
        update: (next, prev) => {
          // An edit moves text under a resting pointer: start over.
          if (next.state.doc !== prev.doc) hint?.hide();
        },
        destroy: () => {
          leave();
          hint?.destroy();
          hint = null;
          editor = null;
          window.removeEventListener('keydown', onKey, true);
          window.removeEventListener('keyup', onKey, true);
          window.removeEventListener('scroll', onScroll, true);
          window.removeEventListener('blur', leave);
          document.removeEventListener('click', onChromeClick, true);
        },
      };
    },
  });
}
