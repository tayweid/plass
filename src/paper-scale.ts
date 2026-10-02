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

/** Fit the stack to the panel's width now and on every resize of either:
 *  the panel's (the window's) and the stack's own box (a page added, the
 *  page size changed, the plain-text sheet growing). Transforms never
 *  resize a box, so the writes here cannot loop. */
export function attachPaper(panel: HTMLElement, clip: HTMLElement, sheet: HTMLElement): void {
  stack = sheet;
  // The panel's content width and the stack's own box, fractional: the
  // drawn page meets the panel's right edge to the subpixel.
  let panelWidth = panel.getBoundingClientRect().width;
  const box = atPaperSize(() => sheet.getBoundingClientRect());
  let sheetWidth = box.width;
  let sheetHeight = box.height;
  const fit = () => {
    if (!(panelWidth > 0) || !(sheetWidth > 0)) return;
    const before = scale;
    scale = panelWidth / sheetWidth;
    sheet.style.transform = `scale(${scale})`;
    clip.style.height = `${sheetHeight * scale}px`;
    // The same line at the panel's top: the drawn pages grew or shrank
    // about the stack's top edge.
    if (before !== scale && panel.scrollTop > 0) panel.scrollTop = (panel.scrollTop * scale) / before;
  };
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target === panel) {
        panelWidth = entry.contentBoxSize[0]?.inlineSize ?? panelWidth;
      } else {
        const size = entry.borderBoxSize[0];
        if (size) {
          sheetWidth = size.inlineSize;
          sheetHeight = size.blockSize;
        }
      }
    }
    fit();
  });
  observer.observe(panel);
  observer.observe(sheet);
  fit();
}
