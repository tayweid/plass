// A flyout from the rail — toolbar.ts's menus, settings.ts's panel: beside
// the rail, level with its tile, inside the window, and never over the
// bar: it stops a frame's edge below the bar and scrolls inside itself
// when the room is shorter than it. Read when it opens, never on the
// typing path.
export function placeFlyout(element: HTMLElement, anchor: HTMLElement) {
  const tile = anchor.getBoundingClientRect();
  const rail = (anchor.closest('#rail') ?? anchor).getBoundingClientRect();
  const edge = 8;
  const top = rail.top + edge;
  const { style } = element;
  style.maxHeight = `${Math.max(80, window.innerHeight - top - edge)}px`;
  style.top = `${Math.max(top, Math.min(tile.top, window.innerHeight - element.offsetHeight - edge))}px`;
  style.left = `${Math.max(edge, Math.min(rail.right + 4, window.innerWidth - element.offsetWidth - edge))}px`;
}
