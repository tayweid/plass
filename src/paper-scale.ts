// The paper is the panel (style.css, the panel): the typeset pages are laid
// out at their own size — the page's width in CSS px, 816 for Letter, the
// width the layout engine breaks lines in — and drawn at the panel's width
// by a transform on #stack, so a wider window is a larger page, never a
// re-flowed one. A resize writes three things (the scale, the height of
// the clip box round the stack, so the panel scrolls exactly the drawn
// pages, and the scroll offset, so the same line stays at the top) and
// nothing else: no layout of the editor, no pagination pass, no zoom. The
// window is the zoom.
//
// Geometry the layout reads must be the paper's own, and a client rect
// under the transform is the drawn one, scaled. `atPaperSize` sets the
// transform to the identity for the length of a synchronous read and puts
// it back before the frame paints, so a pass reads exactly what it read
// when the paper was a fixed-width column at 1:1: the typeset plugin's
// passes and its other reads, the table and grid views' measurements, the
// table break's header copy. Anything placed on the screen — a popup at
// the caret, a toolbar over a table, ProseMirror's own clicks, selections
// and scrolling — reads the drawn page and needs nothing.
//
// The view holds still through a pass by this file's hand, not the
// browser's. Chromium's scroll anchoring is off on the panel (style.css):
// a pass takes the transform off and puts it back, and at any scale but 1
// the anchoring answered that by scrolling the panel a few hundred px by
// itself a beat after typing. The pages hold their content still on their
// own (a page's spacer takes up what its lines gain or lose, so nothing on
// the pages below moves), and what a pass does move in view is the lines
// that cross a page break, the caret's among them. So `paperPass` holds
// the caret: when it is being followed (scrolled into view since it last
// moved) and is in the panel's view, it is at the same place on the
// screen after the pass as before, whatever the pass moved.
//
// The paper's corners (style.css, the paper's corners) are rounded only
// where they are a sheet's own, and that is geometry: every sheet is
// rounded at its four corners, 12 px on the screen at any scale (this file
// writes the scale on #pages for the radius to be divided by), and the
// panel's clip is square, so a corner shows wherever a sheet's corner is
// in view and an edge where the paper runs on past the panel is cut
// straight. The one thing that has to be told is the shadow on the frame,
// a box behind the panel drawn round the paper in view: where the first
// sheet in view begins and the last one ends inside the panel, and how
// much of each one's corner is in view. That is arithmetic on numbers kept
// here (the sheets the painter laid, the scale, the panel's and the clip
// box's heights) and the panel's scroll offset, written as CSS variables
// on the shadow and only when they change: in the frame after a scroll, a
// new set of sheets or a new height, and at once for a new scale. A scroll
// reads nothing of the page but the scroll offset, and lays nothing out
// but that box.

/** A sheet in the stack, in the layout's px (layout/page-geometry.ts). */
type Sheet = { readonly top: number; readonly height: number };

let panelEl: HTMLElement | null = null;
let clipEl: HTMLElement | null = null;
let stack: HTMLElement | null = null;
let pagesEl: HTMLElement | null = null;
let shadowEl: HTMLElement | null = null;
let scale = 1;
let depth = 0;
let sheets: readonly Sheet[] = [];
/** The panel's height and the clip box's, drawn px, as fitPaper last
 *  measured them. */
let viewHeight = 0;
let clipHeight = 0;
/** A corner of the paper on the screen (style.css, --paper-radius). */
let radius = 12;
let edgeFrame = 0;

/** The drawn page's width over its laid-out width (1 before attachPaper). */
export function paperScale(): number {
  return scale;
}

/** Run a synchronous geometry read on the paper at its own size. Nested
 *  calls share the outer one's identity transform. Never spans an await:
 *  the transform is back before the function returns. */
export function atPaperSize<T>(read: () => T): T {
  const el = stack;
  const restore = !!el && depth === 0 && scale !== 1;
  if (restore) el!.style.transform = 'scale(1)';
  depth++;
  try {
    return read();
  } finally {
    depth--;
    if (restore) el!.style.transform = `scale(${scale})`;
  }
}

/** Fit the stack to the panel's width and the clip box to the drawn
 *  stack, now. The stack's height is its own (the pages', which each
 *  settled pass sets) or, while the editor runs past the last page — a
 *  burst of typing at the end, before the pass that adds the page — the
 *  editor's, so the caret's line is never clipped out of reach.
 *  Transforms never resize a box, so the writes here cannot loop. */
export function fitPaper(): void {
  const panel = panelEl;
  const clip = clipEl;
  const sheet = stack;
  if (!panel || !clip || !sheet) return;
  // The panel's content width (it has no border or padding and draws no
  // scrollbar) and the stack's own box, fractional: the drawn page meets
  // the panel's right edge to the subpixel.
  const view = panel.getBoundingClientRect();
  const panelWidth = view.width;
  const box = getComputedStyle(sheet);
  const sheetWidth = parseFloat(box.width);
  const sheetHeight = parseFloat(box.height);
  if (!(panelWidth > 0) || !(sheetWidth > 0)) return;
  // scrollHeight is in whole px: it counts only past the stack's bottom.
  const overflow = sheet.scrollHeight;
  const height = overflow > sheetHeight + 1 ? overflow : sheetHeight;
  const before = scale;
  scale = panelWidth / sheetWidth;
  // Written only when they change: this runs before every scroll to the
  // caret, almost always with nothing new to say.
  const transform = `scale(${scale})`;
  if (depth === 0 && sheet.style.transform !== transform) sheet.style.transform = transform;
  // The sheets' corners are 12 px on the screen: their radius is divided
  // by this. On #pages, not the stack: a variable on the stack would have
  // the whole editor's style recomputed (24 ms on a 32-page paper, against
  // 0.2 on the page boxes alone).
  if (before !== scale) pagesEl?.style.setProperty('--paper-scale', String(scale));
  const drawnHeight = height * scale;
  const clipPx = `${drawnHeight}px`;
  if (clip.style.height !== clipPx) clip.style.height = clipPx;
  // The same line at the panel's top: the drawn pages grew or shrank
  // about the stack's top edge.
  if (before !== scale && panel.scrollTop > 0) panel.scrollTop = (panel.scrollTop * scale) / before;
  // The shadow round the paper in view: at once for a new scale, in this
  // frame (a resize's), else in the next if a height moved.
  const moved = drawnHeight !== clipHeight || view.height !== viewHeight;
  clipHeight = drawnHeight;
  viewHeight = view.height;
  if (before !== scale) edgePaper();
  else if (moved) scheduleEdge();
}

/** The sheets the page painter laid (main.ts renderPages), in the layout's
 *  px: the shadow is drawn round the ones in view. */
export function paperSheets(next: readonly Sheet[]): void {
  sheets = next;
  scheduleEdge();
}

function scheduleEdge(): void {
  if (!edgeFrame) edgeFrame = requestAnimationFrame(() => edgePaper());
}

/** A corner of the shadow, given how far the sheet's edge is past the
 *  panel's (`cut`): the sheet's own radius while that edge is inside the
 *  panel, square once the whole corner has gone past, and between the
 *  two a radius as large as what is left of the corner in view. */
function corner(cut: number): string {
  const r = radius - Math.min(radius, Math.max(0, cut));
  return `${Math.round(r * 100) / 100}px`;
}

function writeEdge(el: HTMLElement, name: string, value: string): void {
  if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
}

/** Draw the shadow round the paper in view, from the sheets kept here and
 *  the panel's scroll offset (see the top of this file). */
function edgePaper(): void {
  if (edgeFrame) cancelAnimationFrame(edgeFrame);
  edgeFrame = 0;
  const panel = panelEl;
  const shadow = shadowEl;
  const sheet = stack;
  if (!panel || !shadow || !sheet) return;
  const top = panel.scrollTop;
  const bottom = top + viewHeight;
  // The first and last sheet in view, drawn. The plain-text view's one
  // sheet is the clip box, at least the panel's height (style.css); so is
  // the page view's before a pass has laid a page.
  let first = NaN;
  let last = NaN;
  const inView = (sheetTop: number, sheetBottom: number) => {
    if (sheetBottom <= top || sheetTop >= bottom) return;
    if (Number.isNaN(first)) first = sheetTop;
    last = sheetBottom;
  };
  if (sheet.classList.contains('source-mode')) inView(0, Math.max(clipHeight, viewHeight));
  else if (!sheets.length) inView(0, clipHeight);
  else for (const s of sheets) inView(s.top * scale, (s.top + s.height) * scale);
  // None in view (scrolled past the last page into a burst of typing that
  // has not got its page yet): no paper, no shadow.
  const bare = Number.isNaN(first);
  if (shadow.hidden !== bare) shadow.hidden = bare;
  if (bare) return;
  const px = (v: number) => `${Math.round(v * 100) / 100}px`;
  writeEdge(shadow, '--paper-top', px(Math.max(0, first - top)));
  writeEdge(shadow, '--paper-bottom', px(Math.max(0, bottom - last)));
  writeEdge(shadow, '--paper-top-corner', corner(top - first));
  writeEdge(shadow, '--paper-bottom-corner', corner(last - bottom));
}

/** Run a layout pass on the paper at its own size, holding the caret still
 *  on the screen. `caret` gives the caret's drawn box, or null when it is
 *  not being followed. When that box is in the panel's view before the
 *  pass, the panel scrolls by however far the pass moved it (a line of it
 *  crossing a page break, a break opening above it), once, after the clip
 *  box has taken the pass's height, so a page added at the end does not
 *  cut the scroll short. */
export function paperPass<T>(pass: () => T, caret: () => { top: number; bottom: number } | null): T {
  const panel = panelEl;
  let before: number | null = null;
  if (panel && depth === 0) {
    const box = caret();
    const view = panel.getBoundingClientRect();
    if (box && box.bottom > view.top && box.top < view.bottom) before = box.top;
  }
  const result = atPaperSize(pass);
  if (panel && before !== null) {
    fitPaper();
    const after = caret()?.top;
    if (after !== undefined && Math.abs(after - before) > 0.5) panel.scrollTop += after - before;
  }
  return result;
}

/** Fit the stack to the panel's width now and on every resize of the
 *  panel (the window), of the stack's own box (a page added, the page size
 *  changed, the plain-text sheet growing) and of what it holds (the editor
 *  running past the last page); and draw the shadow round the paper in
 *  view after each, and in the frame after a scroll. */
export function attachPaper(paper: {
  panel: HTMLElement;
  clip: HTMLElement;
  stack: HTMLElement;
  pages: HTMLElement;
  shadow: HTMLElement;
}): void {
  panelEl = paper.panel;
  clipEl = paper.clip;
  stack = paper.stack;
  pagesEl = paper.pages;
  shadowEl = paper.shadow;
  radius = parseFloat(getComputedStyle(paper.shadow).getPropertyValue('--paper-radius')) || radius;
  const observer = new ResizeObserver(() => fitPaper());
  observer.observe(paper.panel);
  observer.observe(paper.stack);
  for (const child of paper.stack.children) observer.observe(child);
  paper.panel.addEventListener('scroll', scheduleEdge, { passive: true });
  fitPaper();
  edgePaper();
}
