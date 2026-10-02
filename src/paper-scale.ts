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

let panelEl: HTMLElement | null = null;
let clipEl: HTMLElement | null = null;
let stack: HTMLElement | null = null;
let scale = 1;
let depth = 0;

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
  const panelWidth = panel.getBoundingClientRect().width;
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
  const clipHeight = `${height * scale}px`;
  if (clip.style.height !== clipHeight) clip.style.height = clipHeight;
  // The same line at the panel's top: the drawn pages grew or shrank
  // about the stack's top edge.
  if (before !== scale && panel.scrollTop > 0) panel.scrollTop = (panel.scrollTop * scale) / before;
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
 *  running past the last page). */
export function attachPaper(panel: HTMLElement, clip: HTMLElement, sheet: HTMLElement): void {
  panelEl = panel;
  clipEl = clip;
  stack = sheet;
  const observer = new ResizeObserver(() => fitPaper());
  observer.observe(panel);
  observer.observe(sheet);
  for (const child of sheet.children) observer.observe(child);
  fitPaper();
}
