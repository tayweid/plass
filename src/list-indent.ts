// Ordered lists: Typst numbers a list from its start (the list's `order`)
// and sizes the marker column to the widest label in it ("9." … "10."), so
// the body indent depends on the list's start and length. The editor
// mirrors that with a `data-digits` attribute on every <ol> (the digit
// count of its last label; every bundled face has tabular figures, so that
// label is the widest), which the stylesheet maps to the enum indent the
// typeset plugin publishes (`--enum-indent-N`), and paints the labels from
// the start by an inline counter-reset. A node decoration, not toDOM:
// ProseMirror reuses an <ol> whose markup did not change, and adding the
// tenth item changes no markup.

import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';

const key = new PluginKey<DecorationSet>('list-indent');

/** The attributes an ordered list's <ol> paints its labels by. */
export function enumAttrs(list: PMNode): Record<string, string> {
  const start = list.attrs.order as number;
  const attrs: Record<string, string> = { 'data-digits': String(String(start + list.childCount - 1).length) };
  if (start !== 1) attrs.style = `counter-reset: plass-enum ${start - 1}`;
  return attrs;
}

function digitsOf(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'ordered_list') decos.push(Decoration.node(pos, pos + node.nodeSize, enumAttrs(node)));
    return true;
  });
  return DecorationSet.create(doc, decos);
}

export function listIndent(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_config, state) => digitsOf(state.doc),
      apply: (tr, set) => (tr.docChanged ? digitsOf(tr.doc) : set),
    },
    props: {
      decorations: (state) => key.getState(state) ?? null,
    },
  });
}
