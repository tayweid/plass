// The scroll rail: the whole paper, top to bottom, in a 20 px gutter of the
// frame at the window's right, outside the paper, as the history view's
// strip lives beside its river (the shell's history.html, #mini). Taylor,
// 2026-10-02: "a scrollbar much like the history git page with points on
// it indicating the parts of the page and page breaks and such", and of
// the three mockups (docs/mockups/scroll-rail.md), "i think i like
// gutter-hover.png the most". This is that mockup, scroll-rail-gutter.html,
// ported: its DOM, its CSS (style.css, beside the HUD's) and its script,
// with the marks shown at rest (both judges asked for it: the history
// strip's nodes are always there) and two things from the edge mockup,
// the stronger tick for a page gap on screen and marks placed from a
// finished layout pass.
//
// One fraction maps everything. A point of the paper, y in the stack's own
// layout px (the page laid out at 816 px, before the transform that draws
// it at the panel's width), is y / the stack's height down the track, and
// the track is exactly the panel's height. The marks are placed by that
// fraction in CSS (`top: calc(var(--f) * 100%)`), so a resize or a zoom,
// which changes the drawing and not the layout, moves no mark: only the
// band moves, because the panel's scroll range is the drawn height. The
// band is the visible span drawn on its own layer: a scroll writes its
// offset, a transform, in a frame (and its height, only when the paper's
// scroll range or the panel changed), and the marks and gaps inside it
// carry the class `in` (a mark a step brighter, the gap on screen a
// longer tick), set only on those that crossed the band's edges since the
// last frame, usually none. Nothing a scroll writes is inherited by the
// marks or lays the rail out, so a scroll restyles the band and the few
// that crossed, never the whole rail.
//
// The marks are read when a layout pass settles (main.ts hands over the
// settled pass's pages), never on a keystroke: the sheets' tops come from
// the pass itself, the headings', figures' and tables' from offsetTop,
// which is layout and so unscaled, and the caret's from its drawn box over
// the scale. The caret also moves when the selection moves without an
// edit (a click, an arrow), in a frame; typing leaves it for the settle.
//
// The gutter is there while the paper runs past the panel in the page
// view, whatever its number of sheets (a one-page note runs past it at any
// usual window size): a paper that fits the panel and the source view
// keep the frame's 8 px edge. So a note typed onto its second sheet keeps
// its gutter and its scale. The gutter takes 12 px from the panel, so the
// page is drawn about 1 % smaller while it is there (the window is the
// zoom, paper-scale.ts). Whether the paper runs past is asked at the
// gutter's width whether or not the gutter is showing, so its own 12 px
// can never take it away again. It comes and goes at once, not animated:
// an animated edge would redraw the whole page at a new scale on every
// frame of the animation. Nothing opens or grows while a mouse button is
// down: a gutter due then waits for the button to come up, and a press
// that began on the text (a selection dragged toward the edge) wakes
// nothing on the rail.

import type { EditorView } from 'prosemirror-view';
import type { PageInfo } from './typeset-plugin';
import { stackHeight } from './layout/page-geometry';
import { paperScale } from './paper-scale';

/** px either side of a mark, in the rail, within which the pointer takes it. */
const HIT = 7;
/** px a press moves before it is a drag (a scrub) and not a click. */
const DRAG = 3;
/** Shown page numbers stay this far apart: every 1st, 2nd, 5th… page. */
const NUMBER_ROOM = 16;
const STRIDES = [1, 2, 5, 10, 20, 50, 100];
/** A page number's box (style.css, .sr-num: 8 px type, line-height 1, the
 *  digits' ink from 1.25 px into it to 1.15 px short of its bottom), this
 *  far under its hairline's top unless a mark is there; lifted over a mark,
 *  never nearer than NUMBER_LIFT, which leaves 1 px of frame between the
 *  hairline and the digits. */
const NUMBER_DROP = 3;
const NUMBER_LIFT = 0.75;
const NUMBER_H = 8;
/** How long the band stays lit after the paper moves, and after the
 *  pointer leaves the gutter. */
const MOVING_MS = 900;
const SLEEP_MS = 600;

type MarkKind = 'title' | 'section' | 'subsection' | 'figure' | 'table' | 'caret';

interface Mark {
  kind: MarkKind;
  /** The stack's layout px, and that over the stack's height (its --f). */
  y: number;
  f: number;
  /** Inside the band (its class `in`), as last drawn. */
  inside: boolean;
  page: number;
  /** The label's lead (a section's number, "Figure 2") and its words. */
  k: string;
  t: string;
  button: HTMLButtonElement;
}

interface Break {
  kind: 'page';
  /** The middle of the gap above the sheet (0 for the first), and that
   *  over the stack's height. */
  y: number;
  f: number;
  inside: boolean;
  /** The sheet's top edge, where a click lands. */
  top: number;
  page: number;
  el: HTMLElement;
  num: HTMLElement;
}

type Target = Mark | Break;

export interface ScrollRail {
  /** A layout pass settled and painted these sheets: read the marks. */
  pages(info: PageInfo): void;
  /** The selection moved without an edit: move the caret's bar. */
  selection(): void;
  /** The source view opened (true) or closed. */
  mode(source: boolean): void;
}

/** Half a mark's height in the rail (style.css): what a page number keeps
 *  clear of. */
const HALF: Record<MarkKind, number> = { title: 3.5, section: 2.5, subsection: 1.5, figure: 2.5, table: 2.5, caret: 1 };

const CLASSES: Record<MarkKind, string> = {
  title: 'sr-title',
  section: 'sr-section',
  subsection: 'sr-subsection',
  figure: 'sr-figure',
  table: 'sr-table',
  caret: 'sr-caret',
};

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  return el;
}

/** An element's top in the stack's layout px: offsetTop is layout, not
 *  paint, so the transform is not in it and nothing is divided by the
 *  scale. */
function layoutTop(el: HTMLElement, stack: HTMLElement): number {
  let y = 0;
  for (let n: HTMLElement | null = el; n && n !== stack; n = n.offsetParent as HTMLElement | null) y += n.offsetTop;
  return y;
}

const words = (text: string) => text.replace(/\s+/g, ' ').trim();

export function attachScrollRail(view: EditorView, panel: HTMLElement, stack: HTMLElement): ScrollRail {
  const root = document.documentElement;
  const rail = make('nav', '');
  rail.id = 'scrollrail';
  rail.setAttribute('aria-label', 'Document map');
  const track = make('div', 'sr-track');
  const band = make('div', 'sr-band');
  const ghost = make('div', 'sr-ghost');
  band.setAttribute('aria-hidden', 'true');
  ghost.setAttribute('aria-hidden', 'true');
  track.append(band, ghost);
  rail.append(track);
  // The label hangs to the rail's left over the paper's right margin,
  // fixed to the window: the gutter has no room for it.
  const label = make('div', '');
  label.id = 'sr-label';
  label.setAttribute('role', 'tooltip');
  label.setAttribute('aria-hidden', 'true');
  document.body.append(rail, label);

  const css = (name: string) => parseFloat(getComputedStyle(root).getPropertyValue(name)) || 0;

  let info: PageInfo | null = null;
  let built: PageInfo | null = null;
  let docH = 1;
  let marks: Mark[] = [];
  let breaks: Break[] = [];
  let caret: Mark | null = null;
  let on = false;
  let source = false;
  let trackH = 1;
  let frame = 0;
  let bandFrame = 0;
  let caretFrame = 0;

  const fraction = (y: number) => y / docH;
  const inTrack = (y: number) => fraction(y) * trackH;
  const fmt = (f: number) => String(Math.round(Math.max(0, Math.min(1, f)) * 1e6) / 1e6);
  function pageOf(y: number): number {
    const pages = info?.pages ?? [];
    let k = 0;
    while (k + 1 < pages.length && pages[k + 1].top <= y) k++;
    return k + 1;
  }

  /* ---------- the gutter: there or not ---------- */

  function wanted(): boolean {
    if (source || !info) return false;
    // At the gutter's width whether or not it is showing: the gutter's
    // 12 px over the edge's 8 are taken off while it is not there.
    const widen = on ? 0 : css('--gutter') - css('--edge');
    const width = panel.getBoundingClientRect().width - widen;
    return docH * (width / info.pageW) > panel.clientHeight + 1;
  }

  let pressed = false;
  let pending = false;
  function refresh(): void {
    frame = 0;
    const want = wanted();
    if (want !== on) {
      // A gutter that came or went under a held button would move the
      // paper under a selection being dragged: it waits for the release.
      if (pressed) pending = true;
      else {
        on = want;
        root.classList.toggle('has-rail', on);
        if (!on) {
          unhot();
          rail.classList.remove('awake', 'moving', 'dragging');
        }
      }
    }
    if (!on) return;
    if (built !== info) build();
    layoutRail();
  }
  function schedule(): void {
    if (!frame) frame = requestAnimationFrame(refresh);
  }
  window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') pressed = true; }, true);
  const release = () => {
    pressed = false;
    if (pending) {
      pending = false;
      schedule();
    }
  };
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  window.addEventListener('blur', release);
  window.addEventListener('resize', schedule);

  /* ---------- the marks, from a settled pass ---------- */

  function markFor(kind: MarkKind, y: number, k: string, t: string): Mark {
    const button = make('button', `sr-mark ${CLASSES[kind]}`);
    button.type = 'button';
    button.tabIndex = -1;
    const m: Mark = { kind, y, f: fraction(y), inside: false, page: pageOf(y), k, t, button };
    button.style.setProperty('--f', fmt(m.f));
    button.setAttribute('aria-label', `${[k, t].filter(Boolean).join(' ')}, page ${m.page}`);
    // Enter or Space on the focused mark (the pointer is the rail's own,
    // below: the marks take no pointer events).
    button.addEventListener('click', () => jump(m));
    button.addEventListener('focus', () => hot(m));
    return m;
  }

  /** The caret's place: its drawn box over the scale, in the stack's px. */
  function caretPlace(): { y: number; t: string } | null {
    try {
      const { $head, head } = view.state.selection;
      const box = view.coordsAtPos(head);
      const y = (box.top - stack.getBoundingClientRect().top) / paperScale();
      const before = words($head.parent.textBetween(0, $head.parentOffset, ' ', ' ')).split(' ').slice(-6).join(' ');
      return Number.isFinite(y) ? { y, t: before ? `…${before}` : '' } : null;
    } catch {
      return null;
    }
  }

  function build(): void {
    built = info;
    if (!info) return;
    const focused = marks.findIndex((m) => m.button === document.activeElement);
    for (const m of marks) m.button.remove();
    for (const b of breaks) b.el.remove();
    marks = [];
    breaks = [];
    caret = null;
    if (current) unhot();
    const frag = document.createDocumentFragment();

    // Pages: a hairline at the middle of each gap between sheets, and an
    // unseen one at the top, which carries page 1's number.
    info.pages.forEach((sheet, i) => {
      const above = info!.pages[i - 1];
      const y = above ? (above.top + above.height + sheet.top) / 2 : 0;
      const el = make('div', i === 0 ? 'sr-break first' : 'sr-break');
      const f = fraction(y);
      el.style.setProperty('--f', fmt(f));
      const num = make('span', 'sr-num');
      num.textContent = String(i + 1);
      el.append(num);
      frag.append(el);
      breaks.push({ kind: 'page', y, f, inside: false, top: sheet.top, page: i + 1, el, num });
    });

    // Headings (their text's top: a heading's box carries padding above
    // it), figures and tables, in the numbers the page shows them by.
    view.state.doc.descendants((node, pos) => {
      const name = node.type.name;
      if (name !== 'doc_title' && name !== 'heading' && name !== 'figure' && name !== 'table') {
        return !node.isTextblock && name !== 'editor_comment';
      }
      const el = view.nodeDOM(pos);
      if (!(el instanceof HTMLElement) || !el.offsetParent) return false;
      let y = layoutTop(el, stack);
      if (name === 'doc_title' || name === 'heading') {
        y += parseFloat(getComputedStyle(el).paddingTop) || 0;
        const level = name === 'doc_title' ? 0 : (node.attrs.level as number);
        const kind: MarkKind = level === 0 ? 'title' : level === 1 ? 'section' : 'subsection';
        marks.push(markFor(kind, y, level === 0 ? 'Title' : (el.dataset.secnum ?? ''), words(node.textContent)));
      } else if (name === 'figure') {
        const num = el.querySelector('.fig-num')?.textContent?.replace(/:\s*$/, '') ?? 'Figure';
        marks.push(markFor('figure', y, num, words(node.textContent)));
      } else {
        // A captioned or labelled table is numbered by its caption's widget.
        const caption = document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent ?? '';
        const [lead, ...rest] = caption.split(': ');
        marks.push(markFor('table', y, lead || 'Table', words(rest.join(': '))));
      }
      return false;
    });

    const place = caretPlace();
    if (place) {
      caret = markFor('caret', place.y, 'Caret', place.t);
      marks.push(caret);
    }
    marks.sort((a, b) => a.y - b.y);
    for (const m of marks) frag.append(m.button);
    track.append(frag);
    // One tab stop: the first mark, or the one that had the focus.
    const stop = marks[Math.min(Math.max(focused, 0), marks.length - 1)];
    if (stop) {
      stop.button.tabIndex = 0;
      if (focused >= 0) stop.button.focus({ preventScroll: true });
    }
  }

  function placeCaret(): void {
    caretFrame = 0;
    if (!on || !caret) return;
    const place = caretPlace();
    if (!place) return;
    caret.y = place.y;
    caret.f = fraction(place.y);
    caret.t = place.t;
    caret.page = pageOf(place.y);
    caret.button.style.setProperty('--f', fmt(caret.f));
    caret.button.setAttribute('aria-label', `${['Caret', place.t].filter(Boolean).join(' ')}, page ${caret.page}`);
    light(caret);
    marks.sort((a, b) => a.y - b.y);
    if (current === caret) showLabel(caret);
  }

  /* ---------- the track's px: on a rebuild and a resize ---------- */

  function layoutRail(): void {
    // Fractional: under a zoom step the track is not a whole number of px.
    trackH = track.getBoundingClientRect().height || 1;
    const count = breaks.length || 1;
    const perPage = trackH / count;
    // A long paper thins its numbers so the shown ones stay 16 px apart,
    // and under 4 px a page its hairlines too, so the rail never turns to
    // fur. A number sits 3 px under its hairline. A heading, figure or
    // table whose mark is in the number's own box there (a heading opening
    // a page lands just under the hairline on a long paper, where the
    // number is) moves the number: up over the mark if there is room under
    // the hairline, else down past it, never past the next hairline; only
    // a number with no room either way gives way. The caret, which moves,
    // takes no number's place.
    const stride = STRIDES.find((s) => perPage * s >= NUMBER_ROOM) ?? STRIDES[STRIDES.length - 1];
    const held = marks
      .filter((m) => m.kind !== 'caret')
      .map((m) => ({ a: inTrack(m.y) - HALF[m.kind], z: inTrack(m.y) + HALF[m.kind] }))
      .sort((p, q) => p.a - q.a);
    let last = -Infinity;
    breaks.forEach((b, i) => {
      const shown = (b.page - 1) % stride === 0;
      b.el.classList.toggle('thin', perPage < 4 && !shown);
      // The hairline's box (1 px, its middle on the gap): the number's top
      // is measured from its top edge.
      const py = inTrack(b.y) - 0.5;
      let top = py + NUMBER_DROP;
      const hit = shown ? held.find((m) => m.a < top + NUMBER_H && m.z > top) : undefined;
      if (hit) {
        const lift = hit.a - NUMBER_H;
        if (lift >= py + NUMBER_LIFT && !held.some((m) => m !== hit && m.a < hit.a && m.z > lift)) top = lift;
        else {
          for (const m of held) {
            if (m.a >= top + NUMBER_H) break;
            if (m.z > top) top = m.z;
          }
        }
      }
      // A moved number stays in its page's span, above the next hairline
      // (the usual place is kept where it already crosses the next one, on
      // a paper thinned to every 2nd page or more, as the mockup had it).
      const next = i + 1 < breaks.length ? inTrack(breaks[i + 1].y) - 0.5 : trackH;
      const room = Math.max(py + NUMBER_DROP + NUMBER_H, next);
      const fits = shown && top + NUMBER_H <= room && top - last >= NUMBER_ROOM;
      b.num.hidden = !fits;
      if (!fits) return;
      last = top;
      const at = hit ? `${(top > py + NUMBER_DROP ? Math.ceil : Math.floor)((top - py) * 10) / 10}px` : '';
      if (b.num.style.top !== at) b.num.style.top = at;
    });
    drawBand();
  }

  /* ---------- the band: the visible span, after a scroll ---------- */

  let span0 = 0;
  let span1 = 1;
  /** A mark or a gap inside the band carries `in`: written only when that
   *  changes, so a scroll touches the few that crossed the band's edges. */
  function light(t: Target): void {
    const now = t.f >= span0 && t.f <= span1;
    if (now === t.inside) return;
    t.inside = now;
    (t.kind === 'page' ? t.el : t.button).classList.toggle('in', now);
  }

  /** The band's height and offset as last written: a scroll moves it and
   *  rewrites only the offset, a transform on the band's own layer, so the
   *  frame neither lays out nor paints the rail. */
  let bandH = '';
  let bandY = '';
  const px = (v: number) => `${Math.round(v * 100) / 100}px`;

  function drawBand(): void {
    bandFrame = 0;
    const H = panel.scrollHeight || 1;
    const top = panel.scrollTop;
    span0 = top / H;
    span1 = (top + panel.clientHeight) / H;
    // Never under 10 px tall, never past the track's ends.
    const h = Math.max(10, (span1 - span0) * trackH);
    const height = px(h);
    const y = `translateY(${px(Math.min(Math.max(0, span0 * trackH), trackH - h))})`;
    if (height !== bandH) band.style.height = bandH = height;
    if (y !== bandY) band.style.transform = bandY = y;
    for (const m of marks) light(m);
    for (const b of breaks) light(b);
  }

  let moving = false;
  let movingTimer = 0;
  panel.addEventListener(
    'scroll',
    () => {
      if (!on) return;
      if (!bandFrame) bandFrame = requestAnimationFrame(drawBand);
      if (!moving) {
        moving = true;
        rail.classList.add('moving');
      }
      clearTimeout(movingTimer);
      movingTimer = window.setTimeout(() => {
        moving = false;
        rail.classList.remove('moving');
      }, MOVING_MS);
    },
    { passive: true },
  );

  // A resize that changes the paper's scale (the window's width, a zoom
  // step, the gutter coming or going) changes the panel's scroll range.
  // paper-scale.ts fits the clip box to the new scale in its own
  // ResizeObserver of the panel, which runs after this frame's callbacks
  // (the window's resize schedules refresh in one, which drew the band
  // from the old range), and at the top of the paper no scroll follows to
  // redraw it (lower down, fitPaper's keeping the same line at the top
  // scrolls). This observer was made after that one (main.ts attaches the
  // paper before the rail), so it runs after it in the same frame: the
  // band is drawn again from the new range before the frame paints. The
  // panel, not the clip box, which also grows while typing runs past the
  // last page: a keystroke writes nothing here.
  new ResizeObserver(() => {
    if (on) drawBand();
  }).observe(panel);

  /* ---------- hover: the nearest mark, and its label ---------- */

  let current: Target | null = null;

  function nearest(y: number): Target | null {
    let best: Target | null = null;
    let bd = HIT;
    for (const m of marks) {
      const d = Math.abs(inTrack(m.y) - y);
      if (d < bd) {
        bd = d;
        best = m;
      }
    }
    if (best) return best;
    // A page break is a target too, a little narrower, and only once no
    // heading, figure or table is nearer.
    for (const b of breaks) {
      if (b.page === 1) continue;
      const d = Math.abs(inTrack(b.y) - y);
      if (d < bd - 2) {
        bd = d;
        best = b;
      }
    }
    return best;
  }

  function span(className: string, text: string): HTMLSpanElement {
    const s = make('span', className);
    s.textContent = text;
    return s;
  }

  /** Level with `y` (track px), and never cut by the window's edge. */
  function placeLabel(y: number): void {
    const r = track.getBoundingClientRect();
    const half = label.offsetHeight / 2;
    label.style.top = `${Math.min(innerHeight - half - 4, Math.max(half + 4, r.top + y))}px`;
  }

  function showLabel(m: Target): void {
    if (m.kind === 'page') {
      label.className = 'quiet show';
      label.replaceChildren(span('t', `Page ${m.page}`), span('p', `of ${breaks.length}`));
      placeLabel(inTrack(m.y));
      return;
    }
    label.className = 'show';
    label.replaceChildren(...(m.k ? [span('k', m.k)] : []), span('t', m.t), span('p', `p. ${m.page}`));
    placeLabel(inTrack(m.y));
  }

  function hot(m: Target): void {
    if (current === m) return;
    unhot();
    current = m;
    ghost.classList.remove('show');
    (m.kind === 'page' ? m.el : m.button).classList.add('hot');
    showLabel(m);
  }

  function unhot(): void {
    if (current) (current.kind === 'page' ? current.el : current.button).classList.remove('hot');
    current = null;
    label.classList.remove('show');
  }

  /** Empty track: a faint line where a click would land, and its page. */
  function ghostAt(y: number): void {
    unhot();
    const f = Math.max(0, Math.min(1, y / trackH));
    ghost.style.top = `${f * 100}%`;
    ghost.classList.add('show');
    label.className = 'quiet show';
    label.replaceChildren(span('t', `p. ${pageOf(f * docH)}`));
    placeLabel(f * trackH);
  }

  function rest(): void {
    unhot();
    ghost.classList.remove('show');
  }

  /* ---------- awake: the band lit while the pointer is in the gutter ---------- */

  let sleepTimer = 0;
  function wake(): void {
    clearTimeout(sleepTimer);
    rail.classList.add('awake');
  }
  function sleep(): void {
    clearTimeout(sleepTimer);
    sleepTimer = window.setTimeout(() => rail.classList.remove('awake'), SLEEP_MS);
  }

  /* ---------- jumps and the drag ---------- */

  const smooth = (): ScrollBehavior => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

  // A heading, a figure or the caret lands an eighth of the way down the
  // panel, as a heading reached from a contents list does; a page break
  // lands its sheet's top at the panel's top.
  function jump(m: Target): void {
    const scale = paperScale();
    const top = m.kind === 'page' ? m.top * scale : m.y * scale - panel.clientHeight / 8;
    panel.scrollTo({ top: Math.max(0, top), behavior: smooth() });
  }

  /** Empty track: that point of the paper in the middle of the panel. */
  function centre(y: number): void {
    const top = (y / trackH) * panel.scrollHeight - panel.clientHeight / 2;
    panel.scrollTo({ top: Math.max(0, top), behavior: smooth() });
  }

  const yIn = (e: PointerEvent) => e.clientY - track.getBoundingClientRect().top;
  let drag: { y0: number; top0: number; y: number; moved: boolean; target: Target | null } | null = null;

  rail.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // The press is the rail's: the editor keeps the focus and the caret.
    e.preventDefault();
    rail.setPointerCapture(e.pointerId);
    const y = yIn(e);
    drag = { y0: e.clientY, top0: panel.scrollTop, y, moved: false, target: nearest(y) };
    wake();
    rail.classList.add('dragging');
  });

  rail.addEventListener('pointermove', (e) => {
    if (drag) {
      // A press that moves scrubs the band from where it was, wherever it
      // was pressed (on a mark, on the band, on empty track), and jumps
      // nothing: the paper follows the pointer by the track's proportion.
      if (!drag.moved && Math.abs(e.clientY - drag.y0) > DRAG) {
        drag.moved = true;
        rest();
      }
      if (drag.moved) panel.scrollTop = drag.top0 + ((e.clientY - drag.y0) / trackH) * panel.scrollHeight;
      return;
    }
    // A button held from elsewhere (a selection dragged toward the edge):
    // nothing on the rail opens or grows.
    if (e.buttons) {
      rest();
      return;
    }
    wake();
    const y = yIn(e);
    const m = nearest(y);
    if (m) hot(m);
    else ghostAt(y);
  });

  const endDrag = (e: PointerEvent) => {
    const d = drag;
    if (!d) return;
    drag = null;
    rail.classList.remove('dragging');
    if (e.type === 'pointercancel' || d.moved) return;
    if (d.target) jump(d.target);
    else {
      // A click on the band itself is a grab that never moved: it stays.
      const f0 = panel.scrollTop / panel.scrollHeight;
      const f1 = (panel.scrollTop + panel.clientHeight) / panel.scrollHeight;
      const f = d.y / trackH;
      if (f < f0 || f > f1) centre(d.y);
    }
  };
  rail.addEventListener('pointerup', endDrag);
  rail.addEventListener('pointercancel', endDrag);
  rail.addEventListener('pointerleave', () => {
    if (drag) return;
    rest();
    sleep();
  });

  // The gutter is outside the scrolling panel, so a wheel over it would
  // scroll nothing: it goes to the paper, in lines or pages as it came.
  rail.addEventListener(
    'wheel',
    (e) => {
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? panel.clientHeight : 1;
      panel.scrollBy(0, e.deltaY * k);
    },
    { passive: true },
  );

  // Keys: one tab stop, Up and Down between marks (the label follows),
  // Home and End, Return or Space jumps (the button's own click).
  rail.addEventListener('keydown', (e) => {
    const i = marks.findIndex((m) => m.button === document.activeElement);
    if (i < 0) return;
    let j = i;
    if (e.key === 'ArrowDown') j = Math.min(marks.length - 1, i + 1);
    else if (e.key === 'ArrowUp') j = Math.max(0, i - 1);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = marks.length - 1;
    else return;
    e.preventDefault();
    marks[i].button.tabIndex = -1;
    marks[j].button.tabIndex = 0;
    marks[j].button.focus();
  });
  rail.addEventListener('focusout', (e) => {
    if (!rail.contains(e.relatedTarget as Node | null)) unhot();
  });

  return {
    pages(next) {
      info = next;
      docH = stackHeight(next.pages) || 1;
      schedule();
    },
    selection() {
      if (on && !caretFrame) caretFrame = requestAnimationFrame(placeCaret);
    },
    mode(active) {
      source = active;
      schedule();
    },
  };
}
