// Red text (Taylor, 2026-10-26): one color, the solution block's red, as
// a mark on text and inline math. Paint only: a fill changes no glyph metric, so
// the layout port and the paginator never see it; Typst shapes a run of
// its own at every fill change, as the port measures each marked run on
// its own, so page and print agree by construction. The palette is this
// table — a second color is a row, nothing else.
//
// Markdown keeps it as a pandoc span with the class, `[text]{.red}`, so a
// reader without Plass (pandoc, GitHub) still sees the text; Typst prints
// `#text(fill: rgb("#c00000"))[…]` (the PDF, the audit's compile, a
// legacy `.typ` save, which reads it back, Typst's named `red` too, the
// first days' export); TeX `\textcolor{plassred}{…}`, the color defined
// from the same hex, with xcolor. A
// formula in the run is red too: Typst's math inherits the text fill, and
// the page recolors the ink's black fills and strokes (style.css), the
// ink's geometry being the same in any fill. Other atoms (a footnote
// marker, a citation, an image) never carry the mark: the exporter closes
// the run around them, their print not following it, so the toggle takes
// the mark off them and the Markdown writer spans text and math only.

import type { Command } from 'prosemirror-state';
import { toggleMark } from 'prosemirror-commands';
import type { MarkSpec, Node as PMNode } from 'prosemirror-model';

export const TEXT_COLORS = {
  /** The solution block's red (Taylor, 2026-10-26: one red in a document;
   *  `SOLUTION_COLOR` in typ-serializer.ts and `--solution-red` in
   *  style.css are this value). `typst` is the fill the export writes,
   *  `tex` the xcolor name the TeX export defines from `css`. */
  red: { css: '#c00000', typst: 'rgb("#c00000")', tex: 'plassred' },
} as const;
export type TextColorName = keyof typeof TEXT_COLORS;

/** A palette name from text (a class, an attribute, a Typst fill), or null. */
export function textColorName(value: unknown): TextColorName | null {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TEXT_COLORS, value) ? (value as TextColorName) : null;
}

export const colorMarkSpec: MarkSpec = {
  attrs: { name: { default: 'red' } },
  parseDOM: [
    {
      tag: 'span.ts-color',
      getAttrs: (el: HTMLElement | string) => {
        const name = typeof el === 'string' ? null : textColorName(el.getAttribute('data-color'));
        return name ? { name } : false;
      },
    },
  ],
  toDOM: (mark) => ['span', { class: 'ts-color', 'data-color': mark.attrs.name as string }, 0],
};

/** The inline nodes a color sits on: text and a formula. */
export function colorable(node: PMNode): boolean {
  return node.isText || node.type.name === 'math_inline';
}

/** Toggle `name` over the selection as Bold toggles, on text and inline
 *  math only: a footnote marker, a citation or an image in the range stays
 *  as it is, its print never following the run. */
export function toggleTextColor(name: TextColorName): Command {
  return (state, dispatch, view) => {
    const type = state.schema.marks.color;
    const strip = dispatch && ((tr: Parameters<typeof dispatch>[0]) => {
      const { from, to } = tr.selection;
      tr.doc.nodesBetween(from, to, (node, pos) => {
        if (node.isInline && !colorable(node) && type.isInSet(node.marks)) tr.removeMark(pos, pos + node.nodeSize, type);
      });
      dispatch(tr);
    });
    return toggleMark(type, { name })(state, strip, view);
  };
}
