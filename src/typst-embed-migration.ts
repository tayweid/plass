// Backward-compatibility boundary for documents created before executable
// Typst had its own node type. This module intentionally has no DOM/compiler
// dependencies so persistence/import tests can exercise the migration alone.

import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, type EditorState, type Transaction } from 'prosemirror-state';
import { isLegacyTypstRawBlock, schema } from './schema';

const LEGACY_MIGRATION_META = 'typst-embed-legacy-migration';

function legacyMigrationTransaction(state: EditorState): Transaction | null {
  const legacy: Array<{ node: PMNode; pos: number }> = [];
  state.doc.descendants((node, pos) => {
    if (isLegacyTypstRawBlock(node)) {
      legacy.push({ node, pos });
      return false;
    }
    return true;
  });
  if (!legacy.length) return null;

  const tr = state.tr;
  // setNodeMarkup keeps the content as the transaction's gap, so a caret or
  // composition range inside legacy source retains its exact document
  // position. Descending changes leave every earlier node position valid.
  for (const { pos } of legacy.sort((a, b) => b.pos - a.pos)) {
    tr.setNodeMarkup(pos, schema.nodes.typst_embed);
  }
  tr.setMeta('addToHistory', false);
  tr.setMeta(LEGACY_MIGRATION_META, true);
  return tr;
}

/**
 * Upgrade only the exact historical `code_block(params="typst-raw")`
 * marker, both in a freshly restored document and when an old command/import
 * inserts one. A `typst` language fence remains ordinary inert code.
 */
export function typstEmbedMigrationPlugin(): Plugin {
  return new Plugin({
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((tr) => tr.docChanged)) return null;
      if (transactions.some((tr) => tr.getMeta(LEGACY_MIGRATION_META))) return null;
      return legacyMigrationTransaction(newState);
    },
    view(view) {
      let destroyed = false;
      queueMicrotask(() => {
        if (destroyed) return;
        const tr = legacyMigrationTransaction(view.state);
        if (tr) view.dispatch(tr);
      });
      return {
        destroy() {
          destroyed = true;
        },
      };
    },
  });
}
