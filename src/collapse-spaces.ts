// The printed-form normalizer (see the doctrine note in editing.ts): its own
// module so it stays importable without the editor's worker-backed imports —
// the unit suite (collapse-spaces.test.ts) runs it under plain node.

import { Plugin, PluginKey, type Transaction } from 'prosemirror-state';
import { ReplaceStep } from 'prosemirror-transform';
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { beforeAfterNode, createQuoteState, smartenText } from './smart-quotes';

/**
 * Typst collapses runs of ordinary spaces to a single space, so a document
 * holding "a  b" PRINTS as "a b" — and the live breaker and the compiled
 * oracle would forever disagree about the paragraph's text. Keep the
 * document in printed form: after any edit, collapse space runs in plain
 * text (code blocks and code-marked text keep their spaces — raw preserves
 * them in Typst too). Non-breaking spaces are meaningful and untouched.
 */
/**
 * The trailing space run a footnote marker swallows. Typst's footnote show
 * rule prefixes the superscript with `HElem::hole()` — zero-width weak
 * spacing that "eats surrounding spaces" (typst-layout rules.rs
 * FOOTNOTE_RULE; layout/spacing.rs) — so a markup space right before the
 * marker never prints, and the document must not hold it either or the
 * browser paints a space every width model (rightly) refuses to charge: the
 * marker line overflows its measure and soft-wraps into an extra line box.
 * A pure-nbsp run is a glyph, not markup space, and survives; a run holding
 * any plain space is a browser artifact (see the collapse rule) and goes
 * whole. Returns the number of trailing characters to drop.
 */
function swallowedByMarker(text: string): number {
  const m = /[ \u00a0]+$/.exec(text);
  return m && m[0].includes(' ') ? m[0].length : 0;
}

/**
 * Importer counterpart of the edit-time rule: call right before appending a
 * footnote node to `out`. Drops the space run the marker would swallow from
 * the preceding text node, removing that node if nothing is left.
 */
export function trimSpaceBeforeMarker(out: PMNode[]): void {
  const last = out[out.length - 1];
  if (!last?.isText || !last.text) return;
  if (last.marks.some((m) => m.type.name === 'code')) return;
  const n = swallowedByMarker(last.text);
  if (!n) return;
  const kept = last.text.slice(0, -n);
  if (kept) out[out.length - 1] = last.type.schema.text(kept, last.marks);
  else out.pop();
}

/**
 * Positions of non-breaking spaces the BROWSER wrote for a typed space.
 * Under the editor's `white-space: normal` a plain space at the end of a
 * text node is collapsible, so when a space is typed against an inline atom
 * (a formula, a citation, a reference) Chrome inserts U+00A0 instead. Left
 * in the document it exports as `~` and welds the formula to the next word.
 * The same character typed deliberately, or imported from a `~` in a .typ
 * file, is intentional glue and must survive — so the artifact is
 * recognized by how it arrives (a typing transaction inserting exactly one
 * nbsp next to an atom), not by what it is, and is turned into a plain
 * space once a character follows it (a trailing plain space is the one
 * Chrome cannot keep, and is why it wrote the nbsp).
 */
const typedNbspKey = new PluginKey<number[]>('typed-nbsp');

function typedNbspInsertions(tr: Transaction): number[] {
  const ui = tr.getMeta('uiEvent') as string | undefined;
  if (ui === 'paste' || ui === 'drop' || tr.getMeta('addToHistory') === false) return [];
  const found: number[] = [];
  tr.steps.forEach((step, i) => {
    if (!(step instanceof ReplaceStep) || step.from !== step.to) return;
    const text = step.slice.content.firstChild;
    if (step.slice.content.childCount !== 1 || !text?.isText || text.text !== '\u00a0') return;
    const pos = tr.mapping.slice(i + 1).map(step.from, 1);
    const $pos = tr.doc.resolve(pos);
    if (!$pos.parent.isTextblock) return;
    const before = $pos.nodeBefore;
    const after = tr.doc.resolve(pos + 1).nodeAfter;
    const atom = (n: PMNode | null) => !!n && !n.isText && n.isInline;
    // The nbsp is the whole of a fresh text run next to an atom, or ends a
    // run right before one: the browser's artifact, not a run of glue.
    if ((atom(before) || (before?.isText && !before.text!.endsWith('\u00a0') && atom(after))) && !after?.isText) found.push(pos);
    else if (atom(before) && after?.isText && !after.text!.startsWith('\u00a0')) found.push(pos);
  });
  return found;
}

/** Typst text shorthands (--- em, -- en — including the "–-" state
 * mid-way through typing an em dash — a whitespace-preceded hyphen before
 * a digit, and ...) and the glyphs Typst prints for them. The document
 * holds the printed glyph: the importers apply this at read time and the
 * normalizer as text is typed. */
export const PRINTED_FORM_RE = /---|\u2013-|--|(?<=^|\s)-(?=\d)|\.\.\./g;
export function printedGlyph(shorthand: string): string {
  return shorthand === '--' ? '\u2013' : shorthand === '-' ? '\u2212' : shorthand === '...' ? '\u2026' : '\u2014';
}
export function printedForm(text: string): string {
  return text.replace(PRINTED_FORM_RE, printedGlyph);
}

export function collapseSpaces(): Plugin {
  return new Plugin<number[]>({
    key: typedNbspKey,
    state: {
      init: () => [],
      apply(tr, positions) {
        const mapped = positions
          .map((p) => tr.mapping.map(p, 1))
          .filter((p) => p < tr.doc.content.size && tr.doc.textBetween(p, p + 1) === '\u00a0');
        return [...new Set([...mapped, ...typedNbspInsertions(tr)])];
      },
    },
    appendTransaction(trs, _old, state) {
      // Browser-written non-breaking spaces become plain spaces once a
      // character follows them (see typedNbspKey).
      const nbspSwaps: Array<[number, number, string, readonly Mark[]]> = [];
      for (const p of typedNbspKey.getState(state) ?? []) {
        const $p = state.doc.resolve(p);
        const next = state.doc.textBetween(p + 1, Math.min(p + 2, $p.end()));
        if (next && !/[\s\u00a0]/.test(next)) nbspSwaps.push([p, p + 1, ' ', $p.marks()]);
      }
      // Only the edited textblocks can hold new collapsible runs — every
      // other block was normalized by the transaction that last wrote it.
      // Map each step's replacement range forward to the final document and
      // rescan just the textblocks those ranges touch: the swaps produced
      // are exactly what a whole-document walk would find, because a touched
      // block is always rescanned in full (the regexes are context-sensitive
      // only within a block).
      let ranges: Array<[number, number]> = [];
      for (const tr of trs) {
        if (!tr.docChanged) continue;
        if (ranges.length) {
          ranges = ranges.map(([from, to]) => [tr.mapping.map(from, -1), tr.mapping.map(to, 1)]);
        }
        tr.mapping.maps.forEach((stepMap, i) => {
          const rest = tr.mapping.slice(i + 1);
          stepMap.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
            ranges.push([rest.map(newStart, -1), rest.map(newEnd, 1)]);
          });
        });
      }
      if (!ranges.length && !nbspSwaps.length) return null;
      const swaps: Array<[number, number, string, readonly Mark[]]> = [...nbspSwaps];
      const scanBlock = (node: PMNode, pos: number) => {
        // Smart quotes are decided per paragraph, looking back over every
        // inline node (smart-quotes.ts mirrors Typst's quoter).
        const quotes = createQuoteState();
        let before: string | null = null;
        node.forEach((child, offset, index) => {
          if (!child.isText || !child.text || child.marks.some((m) => m.type.name === 'code')) {
            before = beforeAfterNode(child, before);
            return;
          }
          {
            const r = smartenText(child.text, quotes, before);
            before = r.before;
            for (const swap of r.swaps) {
              const base = pos + 1 + offset + swap.index;
              swaps.push([base, base + 1, swap.glyph, child.marks]);
            }
          }
          let text = child.text;
          // A space run right before a footnote marker is deleted outright
          // (see swallowedByMarker). The scans below then run on the text
          // without that run, so no other swap can overlap the deletion.
          const next = index + 1 < node.childCount ? node.child(index + 1) : null;
          if (next?.type.name === 'footnote') {
            const n = swallowedByMarker(text);
            if (n) {
              const base = pos + 1 + offset + text.length - n;
              swaps.push([base, base + n, '', child.marks]);
              text = text.slice(0, -n);
            }
          }
          // Whitespace runs collapse to ONE plain space — including runs
          // the browser polluted with non-breaking spaces (contenteditable
          // substitutes U+00A0 when spaces are typed adjacently, and the
          // editor honors nbsp as glue, welding words together). A run of
          // PURE nbsp is intentional (~~) and stays.
          const re = /[ \u00a0]{2,}/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(text))) {
            if (!m[0].includes(' ')) continue;
            const base = pos + 1 + offset + m.index;
            swaps.push([base, base + m[0].length, ' ', child.marks]);
          }
          // Typst text shorthands print differently than they type: the
          // document holds the printed glyphs (PRINTED_FORM_RE).
          const dashRe = new RegExp(PRINTED_FORM_RE.source, 'g');
          while ((m = dashRe.exec(text))) {
            const base = pos + 1 + offset + m.index;
            swaps.push([base, base + m[0].length, printedGlyph(m[0]), child.marks]);
          }
        });
      };
      const scanned = new Set<number>();
      const size = state.doc.content.size;
      for (const [rawFrom, rawTo] of ranges) {
        const from = Math.max(0, Math.min(rawFrom, size));
        const to = Math.min(Math.max(rawTo, from), size);
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (node.type.name === 'code_block') return false;
          if (!node.isTextblock) return true;
          if (!scanned.has(pos)) {
            scanned.add(pos);
            scanBlock(node, pos);
          }
          return false;
        });
      }
      if (!swaps.length) return null;
      const tr = state.tr;
      // Descending order keeps earlier positions valid; marks carry over so
      // a normalized character inside bold/italic text stays styled.
      for (const [from, to, text, marks] of swaps.sort((a, b) => b[0] - a[0])) {
        if (text) tr.replaceWith(from, to, state.schema.text(text, marks));
        else tr.delete(from, to);
      }
      return tr;
    },
  });
}
