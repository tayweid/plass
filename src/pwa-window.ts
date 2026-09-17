// The installed app's window fits the page. A browser tab is whatever
// width the user gave the browser, but a standalone Plass window has one
// thing in it — the sheet — and Chrome remembers whatever size the window
// last had, clipping the page or framing it in empty room. Desktop PWAs
// may size their own window (window.resizeTo, no manifest field exists for
// an initial size), so the window is set to the page's width plus the
// scroll gutters on load, again when the paper size changes, and back
// again after a horizontal drag: the height stays the user's.

/** Inner width that shows the sheet with the scroll area's side gutters
 *  and its scrollbar, and nothing more. */
function pageWindowWidth(stack: HTMLElement, scroll: HTMLElement): number {
  const gutters = parseFloat(getComputedStyle(scroll).paddingLeft) + parseFloat(getComputedStyle(scroll).paddingRight);
  const scrollbar = scroll.offsetWidth - scroll.clientWidth;
  return Math.ceil(stack.getBoundingClientRect().width + gutters + scrollbar);
}

export function fitStandaloneWindowToPage(stack: HTMLElement, scroll: HTMLElement): () => void {
  let timer = 0;
  let last = 0;
  const fit = () => {
    timer = 0;
    // Fullscreen and maximized windows are the OS's to size.
    if (document.fullscreenElement) return;
    const inner = pageWindowWidth(stack, scroll);
    if (!inner) return;
    last = inner;
    if (inner === window.innerWidth) return;
    // resizeTo takes the outer size; the frame is the difference.
    const frame = Math.max(0, window.outerWidth - window.innerWidth);
    try {
      window.resizeTo(inner + frame, window.outerHeight);
    } catch {
      /* not permitted here — the window keeps its size */
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = window.setTimeout(fit, 180);
  };
  const onResize = () => {
    // A drag that only changes the height is left alone.
    if (window.innerWidth !== last) schedule();
  };
  const observer = new ResizeObserver(schedule);
  observer.observe(stack);
  window.addEventListener('resize', onResize);
  schedule();
  return () => {
    observer.disconnect();
    window.removeEventListener('resize', onResize);
    if (timer) clearTimeout(timer);
  };
}
