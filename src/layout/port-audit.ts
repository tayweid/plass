// The port audit: one Typst compile of the whole document, measured against
// what the editor painted. Plass has one renderer — the port lays out lines
// and the local paginator lays out pages — and Typst is the printer. This
// report is how the two are kept honest: it says, block by block and page
// by page, where they disagree. It runs from tests/port-audit.spec.ts
// (`npm run audit`), never from the edit loop.

import type { Node as PMNode } from 'prosemirror-model';
import { forcedBreakSignature, type BlockLayoutEntry } from './block-layout';
import { diffPageStarts, type PageStartDiff, type PageStartEntry } from './page-parity';
import type { SvgAudit } from './page-oracle';

export interface BlockAudit {
  pos: number;
  type: string;
  text: string;
  /** `match`/`mismatch`: the port's breaks against Typst's. `typst-fail`:
   * Typst's text could not be matched to the block at all (a text
   * shorthand the document does not mirror, usually). `no-port`: the block
   * has no port layout to compare (fallback path). `browser-match`/
   * `browser-mismatch`: the block is browser-laid (headings), and its
   * painted line breaks were read back from the DOM. `rows`: a table,
   * checked only through its page starts. */
  status: 'match' | 'mismatch' | 'typst-fail' | 'no-port' | 'browser-match' | 'browser-mismatch' | 'rows';
  port?: string;
  typst?: string;
  authority?: string | null;
  reason?: string;
}

/** A page whose margins Typst set differently from the editor's chrome
 * (number, running header or footer), texts compared without spaces. */
export interface ChromeAudit {
  page: number;
  typst: string[];
  editor: string[];
}

export interface PortAuditReport {
  compileMs: number;
  analyzeMs: number;
  typst: { status: 'ok' | 'fail'; reason?: string; pageCount: number };
  /** Pages whose chrome differs; empty when every margin agrees. */
  chrome: ChromeAudit[];
  pages: {
    local: PageStartEntry[];
    typst: PageStartEntry[];
    localCount: number;
    agree: boolean;
    firstDiff: PageStartDiff | null;
  };
  blocks: BlockAudit[];
  summary: {
    blocks: number;
    match: number;
    mismatch: number;
    typstFail: number;
    noPort: number;
    browserMismatch: number;
    pagesAgree: boolean;
    chromeMismatch: number;
  };
}

/** The local paginator names a page start by its top-level block (a list
 * or quote is `block` at the container), Typst's text layer by the first
 * textblock inside it. Descend to that textblock so both sides speak the
 * same vocabulary; the unit label is informational after that. */
export function canonicalStart(doc: PMNode, entry: PageStartEntry): PageStartEntry {
  if (entry.line !== 0 || entry.unit !== 'block') return entry;
  let pos = entry.pos;
  let node = doc.nodeAt(pos);
  while (node && !node.isTextblock && !node.isAtom && node.type.name !== 'table' && node.type.name !== 'grid_row' && node.firstChild) {
    pos += 1;
    node = node.firstChild;
  }
  if (!node) return entry;
  const unit =
    node.type.name === 'heading' ? `h${Math.min(3, (node.attrs.level as number) || 1)}` : node.isTextblock ? node.type.name : entry.unit;
  return { pos, line: 0, unit };
}

export function samePageStarts(a: PageStartEntry[], b: PageStartEntry[]): boolean {
  return a.length === b.length && a.every((x, i) => x.pos === b[i].pos && x.line === b[i].line);
}

export function buildPortAudit(args: {
  doc: PMNode;
  typst: SvgAudit;
  local: { starts: PageStartEntry[]; count: number };
  entryFor: (node: PMNode) => BlockLayoutEntry | undefined;
  /** The painted line breaks of a browser-laid textblock (no port entry),
   * as a break signature, or null when they cannot be read. */
  domBreaksFor?: (node: PMNode, pos: number) => string | null;
  /** The chrome the editor painted, page by page. */
  editorChrome?: Array<{ page: number; text: string }>;
  compileMs: number;
  analyzeMs: number;
}): PortAuditReport {
  const { doc, typst, local } = args;
  const blocks: BlockAudit[] = typst.units.map((u) => {
    const node = doc.nodeAt(u.pos);
    const text = (node?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 48);
    const base = { pos: u.pos, type: u.type, text };
    if (u.status === 'fail') return { ...base, status: 'typst-fail', reason: u.reason };
    if (u.type === 'table' || !u.breaks) return { ...base, status: 'rows' };
    const entry = node ? args.entryFor(node) : undefined;
    const typstSig = forcedBreakSignature(u.breaks);
    const portSig = entry?.breakSignature ?? null;
    const authority = entry?.authority ?? null;
    if (portSig == null) {
      const dom = node ? args.domBreaksFor?.(node, u.pos) ?? null : null;
      if (dom == null) return { ...base, status: 'no-port', typst: typstSig, authority };
      return { ...base, status: dom === typstSig ? 'browser-match' : 'browser-mismatch', port: dom, typst: typstSig, authority: 'browser' };
    }
    return { ...base, status: portSig === typstSig ? 'match' : 'mismatch', port: portSig, typst: typstSig, authority };
  });
  const typstStarts: PageStartEntry[] = typst.pageStarts.map((ps) => ({ pos: ps.pos, line: ps.line, unit: ps.unit }));
  const localStarts = local.starts.map((entry) => canonicalStart(doc, entry));
  const agree = samePageStarts(localStarts, typstStarts) && local.count === typst.pageCount;
  const count = (status: BlockAudit['status']) => blocks.filter((b) => b.status === status).length;
  const chrome: ChromeAudit[] = [];
  {
    const pageCount = Math.max(typst.pageCount, local.count);
    const norm = (t: string) => t.replace(/\s+/g, '');
    for (let page = 0; page < pageCount; page++) {
      const got = typst.marginals.filter((m) => m.page === page).map((m) => norm(m.text)).filter(Boolean).sort();
      const want = (args.editorChrome ?? []).filter((m) => m.page === page).map((m) => norm(m.text)).filter(Boolean).sort();
      if (got.length !== want.length || got.some((t, i) => t !== want[i])) chrome.push({ page, typst: got, editor: want });
    }
  }
  return {
    compileMs: args.compileMs,
    analyzeMs: args.analyzeMs,
    typst: { status: typst.status, reason: typst.reason, pageCount: typst.pageCount },
    chrome,
    pages: {
      local: localStarts,
      typst: typstStarts,
      localCount: local.count,
      agree,
      firstDiff: agree ? null : diffPageStarts(localStarts, typstStarts, { doc }),
    },
    blocks,
    summary: {
      blocks: blocks.length,
      match: count('match') + count('browser-match'),
      mismatch: count('mismatch'),
      typstFail: count('typst-fail'),
      noPort: count('no-port'),
      browserMismatch: count('browser-mismatch'),
      pagesAgree: agree,
      chromeMismatch: chrome.length,
    },
  };
}
