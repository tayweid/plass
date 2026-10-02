// Enter in a list: an empty item exits to a paragraph, cutting the list in
// half, whether or not the item still carries blocks (a sub-list, a
// continuation paragraph) under its paragraph.
// Run: npx tsx src/list-enter.test.ts
import { baseKeymap, chainCommands } from 'prosemirror-commands';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { enterInList } from './list-enter';
import { mdToDoc } from './md-parser';
import { docToMd } from './md-serializer';
import { schema } from './schema';
import { typToDoc } from './typ-parser';
import { docToTyp } from './typ-serializer';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures++;
}

const { doc, blockquote, bullet_list, ordered_list, list_item, paragraph } = schema.nodes;
const p = (text = '') => paragraph.create(null, text ? schema.text(text) : undefined);
const li = (...blocks: PMNode[]) => list_item.create(null, blocks);
const ul = (...items: PMNode[]) => bullet_list.create(null, items);
const ulLoose = (...items: PMNode[]) => bullet_list.create({ tight: false }, items);
const ol = (...items: PMNode[]) => ordered_list.create({ order: 1 }, items);

/** A block as one line: a paragraph is its text in quotes, a list is
 *  ul(...)/ol(...) of its items (~ marks a loose list), an item's blocks are
 *  joined with +. `ul("a"+ul("x","y"),"b")` is item a holding sub-items x
 *  and y, then item b. */
const show = (node: PMNode): string => {
  switch (node.type.name) {
    case 'paragraph':
      return JSON.stringify(node.textContent);
    case 'bullet_list':
    case 'ordered_list': {
      const items: string[] = [];
      node.forEach((item) => {
        const blocks: string[] = [];
        item.forEach((block) => blocks.push(show(block)));
        items.push(blocks.join('+'));
      });
      return `${node.type.name === 'bullet_list' ? 'ul' : 'ol'}${node.attrs.tight === false ? '~' : ''}(${items.join(',')})`;
    }
    case 'blockquote': {
      const blocks: string[] = [];
      node.forEach((block) => blocks.push(show(block)));
      return `bq(${blocks.join(' ')})`;
    }
    default:
      return node.type.name;
  }
};
const outline = (d: PMNode) => {
  const out: string[] = [];
  d.forEach((n) => out.push(show(n)));
  return out.join(' ');
};

/** The position right after the text `text` (the caret at the end of that
 *  word), or inside the first empty paragraph for ''. */
const caretAfter = (d: PMNode, text: string): number => {
  let pos = -1;
  d.descendants((n, at) => {
    if (pos >= 0) return false;
    if (text ? n.isText && n.text === text : n.type === paragraph && n.content.size === 0) pos = at + (text ? n.nodeSize : 1);
    return pos < 0;
  });
  if (pos < 0) throw new Error(`no ${text ? JSON.stringify(text) : 'empty paragraph'} in ${outline(d)}`);
  return pos;
};

/** The view's Enter as far as a list is concerned: the editing keymap's
 *  other chain members (footnote, figure, front matter, table) are no-ops
 *  outside their contexts, and baseKeymap's Enter is registered after it. */
const enter = chainCommands(enterInList, baseKeymap.Enter);
const press = (state: EditorState): EditorState => {
  let next = state;
  const handled = enter(state, (tr) => {
    next = state.apply(tr);
  });
  if (!handled) throw new Error(`Enter not handled in ${outline(state.doc)}`);
  return next;
};
const at = (d: PMNode, text: string) => EditorState.create({ doc: d, selection: TextSelection.create(d, caretAfter(d, text)) });
const depth = (state: EditorState) => state.selection.$from.depth;

{
  // The flat list, unchanged: the stock split, then liftEmptyBlock's exit.
  let s = at(doc.create(null, ul(li(p('a')), li(p('b')), li(p('c')))), 'b');
  s = press(s);
  check('flat: Enter at the end of b opens an empty item', outline(s.doc) === 'ul("a","b","","c")' && depth(s) === 3, outline(s.doc));
  s = press(s);
  check('flat: Enter again cuts the list in half', outline(s.doc) === 'ul("a","b") "" ul("c")' && depth(s) === 1, outline(s.doc));
  s = press(s);
  check('flat: a third Enter is a plain paragraph split, no list', outline(s.doc) === 'ul("a","b") "" "" ul("c")' && depth(s) === 1, outline(s.doc));
  let e = at(doc.create(null, ul(li(p('a')), li(p('b')))), 'b');
  e = press(press(e));
  check('flat: at the end of the list the paragraph follows it', outline(e.doc) === 'ul("a","b") ""' && depth(e) === 1, outline(e.doc));
}

{
  // The bug: item a carries a sub-list. The first Enter hands the sub-list
  // to the new empty item; the second used to split that item again (and
  // again, and again).
  let s = at(doc.create(null, ul(li(p('a'), ul(li(p('x')), li(p('y')))), li(p('b')))), 'a');
  s = press(s);
  check('sub-list: Enter at the end of a gives the sub-list to a new empty item', outline(s.doc) === 'ul("a",""+ul("x","y"),"b")' && depth(s) === 3, outline(s.doc));
  s = press(s);
  check('sub-list: Enter again exits to a paragraph between the halves, the sub-items joining the second', outline(s.doc) === 'ul("a") "" ul("x","y","b")' && depth(s) === 1, outline(s.doc));
  check('sub-list: the halves keep the list pitch', s.doc.child(0).attrs.tight === true && s.doc.child(2).attrs.tight === true, outline(s.doc));
  s = press(s);
  check('sub-list: a third Enter is a plain paragraph split', outline(s.doc) === 'ul("a") "" "" ul("x","y","b")' && depth(s) === 1, outline(s.doc));
}

{
  // Ordered: the same, and a joined list numbers on as the original did.
  let s = at(doc.create(null, ol(li(p('a'), ol(li(p('x')), li(p('y')))), li(p('b')))), 'a');
  s = press(press(s));
  check('ordered: the sub-items join the second half', outline(s.doc) === 'ol("a") "" ol("x","y","b")' && depth(s) === 1, outline(s.doc));
  // A bullet sub-list inside an enum stays its own list: the two do not join.
  let m = at(doc.create(null, ol(li(p('a'), ul(li(p('x')), li(p('y')))), li(p('b')))), 'a');
  m = press(press(m));
  check('mixed: a bullet sub-list in an enum stays a bullet list before the second half', outline(m.doc) === 'ol("a") "" ul("x","y") ol("b")' && depth(m) === 1, outline(m.doc));
}

{
  // The joined list is the original list's continuation, so it keeps the
  // second half's pitch, whichever the sub-list had.
  let s = at(doc.create(null, ulLoose(li(p('a'), ul(li(p('x')))), li(p('b')))), 'a');
  s = press(press(s));
  check('pitch: a tight sub-list joined onto a loose half is loose', outline(s.doc) === 'ul~("a") "" ul~("x","b")', outline(s.doc));
  let t = at(doc.create(null, ul(li(p('a'), ulLoose(li(p('x')))), li(p('b')))), 'a');
  t = press(press(t));
  check('pitch: a loose sub-list joined onto a tight half is tight', outline(t.doc) === 'ul("a") "" ul("x","b")', outline(t.doc));
}

{
  // A continuation paragraph after the item's first: it lands between the
  // halves too (a paragraph is not a list, nothing joins).
  let s = at(doc.create(null, ul(li(p('a'), p('more')), li(p('b')))), 'a');
  s = press(press(s));
  check('continuation: the item\'s second paragraph follows the new one', outline(s.doc) === 'ul("a") "" "more" ul("b")' && depth(s) === 1, outline(s.doc));
  // Both: a paragraph and then a sub-list; the sub-list still joins.
  let b = at(doc.create(null, ul(li(p('a'), p('more'), ul(li(p('x')))), li(p('b')))), 'a');
  b = press(press(b));
  check('continuation then sub-list: the trailing sub-list joins the second half', outline(b.doc) === 'ul("a") "" "more" ul("x","b")', outline(b.doc));
}

{
  // The first and the last item of the list.
  let f = at(doc.create(null, ul(li(p(''), ul(li(p('x')))), li(p('b')))), '');
  f = press(f);
  check('first item: the paragraph leads, no empty first half', outline(f.doc) === '"" ul("x","b")' && depth(f) === 1, outline(f.doc));
  let l = at(doc.create(null, ul(li(p('a')), li(p(''), ul(li(p('x')))))), '');
  l = press(l);
  check('last item: the sub-list follows the paragraph as its own list', outline(l.doc) === 'ul("a") "" ul("x")' && depth(l) === 1, outline(l.doc));
}

{
  // Nested: the exit climbs one level per press, as the stock trailing case
  // does. x has sub-item q; Enter at the end of x.
  let s = at(doc.create(null, ul(li(p('a'), ul(li(p('x'), ul(li(p('q')))), li(p('y')))), li(p('b')))), 'x');
  s = press(s);
  check('deep: Enter at the end of x opens a nested empty item holding q', outline(s.doc) === 'ul("a"+ul("x",""+ul("q"),"y"),"b")' && depth(s) === 5, outline(s.doc));
  s = press(s);
  check('deep: Enter again exits the nested list into item a, cutting it in half', outline(s.doc) === 'ul("a"+ul("x")+""+ul("q","y"),"b")' && depth(s) === 3, outline(s.doc));
  s = press(s);
  check('deep: Enter again exits the outer list', outline(s.doc) === 'ul("a"+ul("x")) "" ul("q","y","b")' && depth(s) === 1, outline(s.doc));

  // The stock trailing case is untouched: Enter at the end of y, the last
  // nested item, climbs out one level per press.
  let t = at(doc.create(null, ul(li(p('a'), ul(li(p('x')), li(p('y')))), li(p('b')))), 'y');
  t = press(t);
  check('trailing nested: Enter at the end of y opens a nested empty item', outline(t.doc) === 'ul("a"+ul("x","y",""),"b")' && depth(t) === 5, outline(t.doc));
  t = press(t);
  check('trailing nested: Enter again makes it an outer item (stock)', outline(t.doc) === 'ul("a"+ul("x","y"),"","b")' && depth(t) === 3, outline(t.doc));
  t = press(t);
  check('trailing nested: Enter again exits the list (stock)', outline(t.doc) === 'ul("a"+ul("x","y")) "" ul("b")' && depth(t) === 1, outline(t.doc));

  // A nested middle item with no sub-list: stock lifts the paragraph into
  // item a (the nested list is cut in half); the next Enter used to split
  // item a around it, leaving an empty item holding the second nested half.
  let m = at(doc.create(null, ul(li(p('a'), ul(li(p('x')), li(p('y')))), li(p('b')))), 'x');
  m = press(press(m));
  check('nested middle: stock cuts the nested list in half inside item a', outline(m.doc) === 'ul("a"+ul("x")+""+ul("y"),"b")' && depth(m) === 3, outline(m.doc));
  m = press(m);
  check('nested middle: Enter again exits the outer list', outline(m.doc) === 'ul("a"+ul("x")) "" ul("y","b")' && depth(m) === 1, outline(m.doc));
}

{
  // Inside a blockquote the halves stay in the quote.
  let s = at(doc.create(null, blockquote.create(null, ul(li(p('a'), ul(li(p('x')))), li(p('b'))))), 'a');
  s = press(press(s));
  check('blockquote: the list is cut inside the quote', outline(s.doc) === 'bq(ul("a") "" ul("x","b"))' && depth(s) === 2, outline(s.doc));
}

{
  // Through the files: the two halves with a paragraph between them are
  // two lists after save and reopen, in both formats.
  let s = at(doc.create(null, ul(li(p('a'), ul(li(p('x')), li(p('y')))), li(p('b')))), 'a');
  s = press(press(s));
  const typed = s.apply(s.tr.insertText('between')).doc;
  check('typed paragraph: the editor holds list, paragraph, list', outline(typed) === 'ul("a") "between" ul("x","y","b")', outline(typed));
  const md = docToMd(typed);
  check('typed paragraph: Markdown writes two lists', md === '- a\n\nbetween\n\n- x\n- y\n- b\n', JSON.stringify(md));
  check('typed paragraph: Markdown reopens as two lists', outline(mdToDoc(md).doc) === outline(typed), outline(mdToDoc(md).doc));
  const typ = docToTyp(typed);
  check('typed paragraph: Typst writes two lists', typ.includes('- a\n\nbetween\n\n- x\n- y\n- b\n'), JSON.stringify(typ));
  check('typed paragraph: Typst reopens as two lists', outline(typToDoc(typ).doc) === outline(typed), outline(typToDoc(typ).doc));

  // Saved before anything is typed: Typst keeps the empty paragraph (a
  // bare ~), so the halves stay two lists. Markdown has no empty
  // paragraph; the file holds two adjacent lists, which CommonMark reads
  // as ONE loose list — the known cost of saving an untouched gap as .md,
  // pinned here so a change to the serializer shows.
  const empty = s.doc;
  const typEmpty = docToTyp(empty);
  check('empty paragraph: Typst writes a ~ between the halves', typEmpty.includes('- a\n\n~\n\n- x\n- y\n- b\n'), JSON.stringify(typEmpty));
  check('empty paragraph: Typst reopens as list, paragraph, list', outline(typToDoc(typEmpty).doc) === 'ul("a") "" ul("x","y","b")', outline(typToDoc(typEmpty).doc));
  const mdEmpty = docToMd(empty);
  check('empty paragraph: Markdown drops it, the halves are adjacent', mdEmpty === '- a\n\n- x\n- y\n- b\n', JSON.stringify(mdEmpty));
  check('empty paragraph: Markdown reopens as one loose list (CommonMark)', outline(mdToDoc(mdEmpty).doc) === 'ul~("a","x","y","b")', outline(mdToDoc(mdEmpty).doc));
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exitCode = 1;
} else console.log('list-enter: all checks passed');
