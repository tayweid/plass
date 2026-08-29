// The printed-form normalizer (see the doctrine note in editing.ts): its own
// module so it stays importable without the editor's worker-backed imports —
// the unit suite (collapse-spaces.test.ts) runs it under plain node.

import { Plugin } from 'prosemirror-state';
import type { Mark, Node as PMNode } from 'prosemirror-model';

/**
 * Typst collapses runs of ordinary spaces to a single space, so a document
 * holding "a  b" PRINTS as "a b" — and the live breaker and the compiled
 * oracle would forever disagree about the paragraph's text. Keep the
 * document in printed form: after any edit, collapse space runs in plain
 * text (code blocks and code-marked text keep their spaces — raw preserves
 * them in Typst too). Non-breaking spaces are meaningful and untouched.
 */
export function collapseSpaces(): Plugin {
  return new Plugin({
    appendTransaction(trs, _old, state) {
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
      if (!ranges.length) return null;
      const swaps: Array<[number, number, string, readonly Mark[]]> = [];
      const scanBlock = (node: PMNode, pos: number) => {
        node.forEach((child, offset) => {
          if (!child.isText || !child.text) return;
          if (child.marks.some((m) => m.type.name === 'code')) return;
          const text = child.text;
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
          // Typst dash shorthands print differently than they type: the
          // document holds the printed glyphs (--- em, -- en — including
          // the "–-" state mid-way through typing an em dash — and a
          // whitespace-preceded hyphen before a digit is a minus sign).
          const dashRe = /---|\u2013-|--|(?<=^|\s)-(?=\d)/g;
          while ((m = dashRe.exec(text))) {
            const base = pos + 1 + offset + m.index;
            const glyph = m[0] === '--' ? '\u2013' : m[0] === '-' ? '\u2212' : '\u2014';
            swaps.push([base, base + m[0].length, glyph, child.marks]);
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
        tr.replaceWith(from, to, state.schema.text(text, marks));
      }
      return tr;
    },
  });
}
