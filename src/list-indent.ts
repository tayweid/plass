// Ordered lists: Typst sizes the marker column to the widest label in the
// list ("1." … "12."), so the body indent depends on how many items the
// list has. The editor mirrors that with a `data-digits` attribute on every
// <ol> (the digit count of its item count), which the stylesheet maps to
// the enum indent the typeset plugin publishes (`--enum-indent-N`). A node
// decoration, not toDOM: ProseMirror reuses an <ol> whose markup did not
// change, and adding the tenth item changes no markup.

import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';

const key = new PluginKey<DecorationSet>('list-indent');

function digitsOf(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'ordered_list') {
      decos.push(Decoration.node(pos, pos + node.nodeSize, { 'data-digits': String(String(node.childCount).length) }));
    }
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
