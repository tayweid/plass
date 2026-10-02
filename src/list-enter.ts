// Enter inside a list: the stock split, and the exit the stock split
// cannot make.
//
// prosemirror-schema-list's splitListItem bails out of an empty item only
// when the empty paragraph is the item's LAST child, leaving the exit to
// baseKeymap's liftEmptyBlock (which cuts the list in half around a new
// paragraph). With a block after the paragraph — the sub-list that the
// first Enter at the end of "a" in `a[x, y], b` hands to the new empty
// item, or a continuation paragraph — it takes its general path and splits
// the item again, minting another empty item on every press: the writer
// never leaves the list. liftEmptyBlock cannot help there either, because
// a paragraph alone cannot be lifted out of an item that would be left
// starting with a list (`paragraph block*`).
//
// This module is CSS-free on purpose so the node tests can load it
// (editing.ts pulls in stylesheets through figures.ts).
import { chainCommands } from 'prosemirror-commands';
import type { Node as PMNode } from 'prosemirror-model';
import { splitListItem } from 'prosemirror-schema-list';
import type { Command } from 'prosemirror-state';
import { canJoin, liftTarget } from 'prosemirror-transform';
import { schema } from './schema';

const { list_item, paragraph, bullet_list, ordered_list } = schema.nodes;
const isList = (node: PMNode) => node.type === bullet_list || node.type === ordered_list;

/** Enter on an empty paragraph of a list item that has blocks after it:
 *  the paragraph and those blocks leave the item and its list together,
 *  one level up (the item above for a nested list, else the list's
 *  parent). The list is cut in half at the caret, exactly as liftEmptyBlock
 *  cuts it when the paragraph is the item's last block, and the item's
 *  other blocks land between the halves. A lifted list that then sits
 *  against the second half is joined onto it when both are of one type —
 *  the nested items of `a[x, y], b` become `x, y, b` — because two
 *  adjacent lists are one loose list once saved and reopened, in Markdown
 *  and in Typst alike; the joined list keeps the second half's attrs,
 *  being the original list's continuation. An item's only block, or its
 *  last, is left to the stock path, which already exits.
 */
const exitEmptyListItem: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type !== paragraph || $from.parent.content.size || $from.depth < 3) return false;
  const item = $from.node(-1);
  const index = $from.index(-1);
  if (item.type !== list_item || index === item.childCount - 1) return false;
  const range = $from.blockRange(state.doc.resolve($from.end(-1)));
  if (!range || range.depth !== $from.depth - 1) return false;
  const target = liftTarget(range);
  if (target == null) return false;
  if (dispatch) {
    const tr = state.tr.lift(range, target);
    // The lifted blocks are now siblings starting at the paragraph; `cut`
    // is the boundary after the last of them.
    let cut = tr.selection.$from.before();
    for (let k = item.childCount - index; k > 0; k--) cut += tr.doc.nodeAt(cut)!.nodeSize;
    const { nodeBefore: last, nodeAfter: next } = tr.doc.resolve(cut);
    if (last && next && isList(last) && next.type === last.type && canJoin(tr.doc, cut)) {
      tr.join(cut);
      if (!last.hasMarkup(next.type, next.attrs)) tr.setNodeMarkup(cut - last.nodeSize, undefined, next.attrs);
    }
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** The list member of the Enter chain (editing.ts). */
export const enterInList: Command = chainCommands(exitEmptyListItem, splitListItem(list_item));
