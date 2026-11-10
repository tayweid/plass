// Bare URLs in text, found as Typst finds them: `http://` or `https://`
// wherever it stands, mid-word too, as far as Typst's `link_prefix`
// reaches (the port's `linkPrefixScan`), trailing sentence punctuation
// left out. Typst links each one in print (typ-serializer's
// `escapePieces`); the page draws them as links and opens them on
// ⌘-click (link-open.ts); the TeX export writes each as an `\\href`.

import { linkPrefixScan } from './layout/port/linebreak';

export interface BareUrl {
  from: number;
  to: number;
  url: string;
}

/** Every bare URL in `text`, in order. */
export function bareUrls(text: string): BareUrl[] {
  const found: BareUrl[] = [];
  const scheme = /https?:\/\//g;
  for (let m = scheme.exec(text); m; m = scheme.exec(text)) {
    const rest = linkPrefixScan(text.slice(m.index + m[0].length)).link;
    const to = m.index + m[0].length + rest.length;
    if (rest) found.push({ from: m.index, to, url: text.slice(m.index, to) });
    scheme.lastIndex = Math.max(scheme.lastIndex, to);
  }
  return found;
}

/** The bare URL in `text` that covers the character at `index`. */
export function bareUrlAt(text: string, index: number): BareUrl | null {
  return bareUrls(text).find((u) => index >= u.from && index < u.to) ?? null;
}

/** An address the page opens: the web and mail. */
export function opensFromPage(url: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(url.trim());
}
