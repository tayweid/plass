// A flyout from a column of tiles — toolbar.ts's menus and settings.ts's
// panel from the rail, block-chrome.ts's menus from the block pill: beside
// the column, level with its tile, inside the window, and never over the
// bar: it stops a frame's edge below the bar and scrolls inside itself
// when the panel is shorter than it. Read when it opens, never on the
// typing path.
//
// The rail's flyouts open to its right, their top level with the tile.
// The pill's open to its right too, their first row level with the tile
// (the flyout's top 7 px above it, its padding), or, for a pill hugging a
// narrow block (`side: 'start'`), to its left when they fit there, into
// the empty margin rather than over the block. Returns the side taken.
export function placeFlyout(element: HTMLElement, anchor: HTMLElement, options: { side?: 'end' | 'start' } = {}): 'end' | 'start' {
  const tile = anchor.getBoundingClientRect();
  const columnEl = anchor.closest<HTMLElement>('#rail, .block-pill') ?? anchor;
  const column = columnEl.getBoundingClientRect();
  const pill = columnEl.matches('.block-pill');
  const edge = 8;
  // The pill lives in the panel under the bar: its flyouts keep below the
  // bar as the rail's do.
  const panel = pill ? document.getElementById('scroll')?.getBoundingClientRect() : null;
  const top = (panel ? panel.top : column.top) + edge;
  const { style } = element;
  style.maxHeight = `${Math.max(80, window.innerHeight - top - edge)}px`;
  const wanted = pill ? tile.top - 7 : tile.top;
  style.top = `${Math.max(top, Math.min(wanted, window.innerHeight - element.offsetHeight - edge))}px`;
  const width = element.offsetWidth;
  const gap = pill ? 6 : 4;
  const floor = panel ? panel.left + 4 : edge;
  if (options.side === 'start' && column.left - gap - width >= floor) {
    style.left = `${column.left - gap - width}px`;
    return 'start';
  }
  style.left = `${Math.max(edge, Math.min(column.right + gap, window.innerWidth - width - edge))}px`;
  return 'end';
}
