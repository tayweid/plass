// Is this browser's text the compiler's text? The exact layout rests on one
// assumption: the browser advances glyphs by the font's linear widths, the
// same widths the port's shaper (and Typst) use. A browser that hints the
// bundled fonts rounds every advance to whole pixels — Linux Chromium did,
// out of the box: a 26-letter run 225px against 212.6px — and then the
// port's exact breaks overflow their lines and every page drifts. The test
// runner turns hinting off; a writer's browser is not ours to configure.
//
// So the app measures once at startup, in the document's own font and
// size, and compares with the port. A mismatch declares the exact path
// uncertified for this session: the legacy breaker (browser metrics,
// self-consistent) lays the lines, the oracles stay quiet, and the writer
// is told. Doctrine: failures are visible, never silent.

/** Letters, digits, spaces, and the punctuation prose is made of. */
export const PROBE_TEXT = 'The quick brown fox jumps over the lazy dog; 0123456789, "quoted" (and more)!';

/** Fractional disagreement tolerated: linear advances agree to a few
 *  hundredths of a percent; hinting shows up as whole percents. */
export const PROBE_TOLERANCE = 0.004;

export interface EnvironmentVerdict {
  certified: boolean;
  browserPx: number;
  portPx: number;
  ratio: number;
  font: string;
  sizePx: number;
}

/** Measure `text` as the browser lays it in `cssFamily` at `sizePx`. */
export function measureBrowserRun(host: HTMLElement, cssFamily: string, sizePx: number, text = PROBE_TEXT): number {
  const span = document.createElement('span');
  span.textContent = text;
  span.style.cssText =
    `position:absolute;left:-99999px;top:0;visibility:hidden;white-space:pre;` +
    `font-family:${cssFamily};font-size:${sizePx}px;font-kerning:normal;letter-spacing:0;word-spacing:0;font-feature-settings:normal`;
  host.appendChild(span);
  const width = span.getBoundingClientRect().width;
  span.remove();
  return width;
}

export function judgeEnvironment(browserPx: number, portPx: number, font: string, sizePx: number): EnvironmentVerdict {
  const ratio = portPx > 0 ? browserPx / portPx : 1;
  return { certified: Math.abs(ratio - 1) <= PROBE_TOLERANCE, browserPx, portPx, ratio, font, sizePx };
}

/** One line for the writer. */
export function describeVerdict(v: EnvironmentVerdict): string {
  const pct = ((v.ratio - 1) * 100).toFixed(1);
  const dir = v.ratio > 1 ? 'wider' : 'narrower';
  return `This browser draws text ${Math.abs(+pct)}% ${dir} than the compiler does — exact layout is off for this session; pages here may not match the PDF`;
}
