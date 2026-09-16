// Display geometry of the page stack when editorial comments are on the
// page (editor-comments.ts). Print pages are uniform: page k occupies
// `[k·(H+gap), k·(H+gap)+H)` in PRINT-STACK coordinates, which is where
// the paginator works (a painted coordinate less the note heights above
// it). The DISPLAYED sheet k is taller by the summed height of the notes
// it holds, and every later sheet sits lower by the same amount. Pure
// arithmetic, shared by the plugin (footnote placement) and the page
// painter (sheet boxes, folios, running header and footer).

export interface DisplayPage {
  /** Stack y of the sheet's top edge, px. */
  top: number;
  /** Painted height: the print height plus this sheet's note heights. */
  height: number;
  /** Summed note heights on this sheet. */
  extra: number;
}

/** The print page holding print-stack coordinate `y`, clamped to the
 *  document's pages. */
export function printPageIndex(y: number, pageH: number, gap: number, count: number): number {
  if (!Number.isFinite(y) || count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.floor(y / (pageH + gap))));
}

export function displayPages(count: number, pageH: number, gap: number, extras: readonly number[]): DisplayPage[] {
  const pages: DisplayPage[] = [];
  let top = 0;
  for (let k = 0; k < count; k++) {
    const extra = Math.max(0, extras[k] ?? 0);
    pages.push({ top, height: pageH + extra, extra });
    top += pageH + extra + gap;
  }
  return pages;
}

/** The stack's full height: the last sheet's bottom edge. */
export function stackHeight(pages: readonly DisplayPage[]): number {
  const last = pages[pages.length - 1];
  return last ? last.top + last.height : 0;
}
