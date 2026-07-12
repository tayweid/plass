// Input rules and keymap: the Typora feel — markdown-ish syntax renders as
// you type, everything reachable from the keyboard.

import {
  InputRule,
  inputRules,
  smartQuotes,
  emDash,
  ellipsis,
  textblockTypeInputRule,
  wrappingInputRule,
} from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { TextSelection } from 'prosemirror-state';
import { baseKeymap, chainCommands, exitCode, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import { redo, undo } from 'prosemirror-history';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import type { MarkType } from 'prosemirror-model';
import type { Command, Plugin } from 'prosemirror-state';
import { schema } from './schema';
import { insertMath, mathDisplayRule, mathInlineRule } from './math';
import { eqRefRule } from './equations';
import { exitFigure } from './figures';
import { exitFootnote, footnoteCloseRule, footnoteOpenRules, insertFootnote, skipFootnote } from './footnotes';
import { pickAndInsertFigure } from './figures';

/**
 * `**bold**`, `_em_`, `` `code` `` style mark input rules.
 * `contentGroup` is the capture group holding the marked text; group 1 is a
 * preserved prefix when contentGroup is 2.
 */
function markInputRule(regexp: RegExp, markType: MarkType, contentGroup = 1): InputRule {
  return new InputRule(regexp, (state, match, start, end) => {
    const content = match[contentGroup];
    if (!content) return null;
    const prefix = contentGroup === 2 ? (match[1] ?? '') : '';
    const from = start + prefix.length;
    const tr = state.tr;
    tr.delete(from, end);
    tr.insertText(content, from);
    tr.addMark(from, from + content.length, markType.create());
    tr.removeStoredMark(markType);
    return tr;
  });
}

export function buildInputRules(): Plugin {
  const rules = [
    ...smartQuotes,
    ellipsis,
    emDash,
    // # / ## / ### headings
    textblockTypeInputRule(/^(#{1,3})\s$/, schema.nodes.heading, (m) => ({ level: m[1].length })),
    // > blockquote
    wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote),
    // - or * bullet list
    wrappingInputRule(/^\s*([-*])\s$/, schema.nodes.bullet_list),
    // 1. ordered list
    wrappingInputRule(
      /^(\d+)\.\s$/,
      schema.nodes.ordered_list,
      (m) => ({ order: +m[1] }),
      (m, node) => node.childCount + node.attrs.order === +m[1],
    ),
    // ``` code block
    textblockTypeInputRule(/^```$/, schema.nodes.code_block),
    // marks
    markInputRule(/\*\*([^*]+)\*\*$/, schema.marks.strong),
    markInputRule(/(^|[^*])\*([^*\s][^*]*)\*$/, schema.marks.em, 2),
    markInputRule(/(^|[^_])_([^_\s][^_]*)_$/, schema.marks.em, 2),
    markInputRule(/`([^`]+)`$/, schema.marks.code),
    // math
    mathInlineRule,
    mathDisplayRule,
    // @label equation references
    eqRefRule,
    // ^[ or \footnote{ opens a footnote; ] or } exits its body
    ...footnoteOpenRules,
    footnoteCloseRule,
  ];
  return inputRules({ rules });
}

/** Enter in title/authors/date moves on instead of splitting the block. */
const exitFrontMatter: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty) return false;
  const name = $from.parent.type.name;
  if (!['doc_title', 'doc_authors', 'doc_date'].includes(name)) return false;
  const after = $from.after();
  if (dispatch) {
    const next = state.doc.resolve(after).nodeAfter;
    if (next && next.isTextblock) {
      dispatch(state.tr.setSelection(TextSelection.create(state.doc, after + 1)).scrollIntoView());
    } else {
      const tr = state.tr.insert(after, schema.nodes.paragraph.create());
      dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView());
    }
  }
  return true;
};

/**
 * Geometric vertical caret motion. The browser's native ArrowUp/Down is
 * unreliable over the typeset DOM: at a soft line break the column-0 caret
 * position IS the previous line's end position (the <br> is a widget), and
 * the browser reads its goal column from the wrong side — arrowing up from
 * the left edge lands the caret at the END of the line above. We move the
 * caret ourselves: from the caret's rendered x, probe upward/downward one
 * line pitch at a time (page gaps need several probes) and place the caret
 * at the first position that made vertical progress.
 */
// Goal column for consecutive vertical presses: clamping through a short
// line (a heading) must not lose the original x — browsers remember it
// until any other action moves the selection.
let goalX: number | null = null;
let goalHead = -1;

function verticalCaret(dir: -1 | 1): Command {
  return (state, dispatch, view) => {
    if (!view) return false;
    const sel = state.selection;
    if (!(sel instanceof TextSelection) || !sel.empty) return false;
    const $head = sel.$head;
    if (!$head.parent.isTextblock) return false;
    let c: { left: number; top: number; bottom: number };
    try {
      c = view.coordsAtPos(sel.head, 1);
    } catch {
      return false;
    }
    const continuing = sel.head === goalHead && goalX !== null;
    const gx = continuing ? (goalX as number) : c.left;
    if (!continuing) goalX = c.left;
    const domRef = view.domAtPos(sel.head);
    const el =
      domRef.node instanceof HTMLElement ? domRef.node : domRef.node.parentElement;
    const lineH = (el && parseFloat(getComputedStyle(el).lineHeight)) || 24;
    const yStart = dir < 0 ? c.top : c.bottom;
    // Probe in HALF-line steps — a full step can jump clean over a line
    // whose pitch is smaller than this block's (paragraph lines after a
    // heading). 80 half-steps cover a page gap.
    for (let step = 1; step <= 80; step++) {
      const y = yStart + dir * lineH * 0.5 * step;
      const found = view.posAtCoords({ left: gx, top: y });
      if (!found) continue;
      // A hit in the gap BETWEEN blocks (inside === -1) is not a caret
      // line — it reports degenerate zero-height coords at the block edge.
      // Keep probing until we reach a real line.
      if (found.inside === -1) continue;
      let pos = Math.max(0, Math.min(found.pos, state.doc.content.size));
      if (pos === sel.head) continue;
      let target: { top: number; bottom: number };
      try {
        target = view.coordsAtPos(pos, 1);
      } catch {
        continue;
      }
      // Require a real line box making real vertical progress (skip
      // same-line hits and degenerate geometry).
      if (!(target.bottom > target.top)) continue;
      if (dir < 0 ? target.top > c.top - lineH * 0.4 : target.bottom < c.bottom + lineH * 0.4) {
        continue;
      }
      // A probe that fell short of the goal column (snapped to a block
      // edge) loses x. Re-query at the landed LINE's vertical center with
      // the original goal x.
      const refined = view.posAtCoords({ left: gx, top: (target.top + target.bottom) / 2 });
      if (refined && refined.inside !== -1) {
        const rp = Math.max(0, Math.min(refined.pos, state.doc.content.size));
        if (rp !== sel.head) pos = rp;
      }
      if (dispatch) {
        const next = TextSelection.near(state.doc.resolve(pos), dir);
        goalHead = next.head;
        dispatch(state.tr.setSelection(next).scrollIntoView());
      }
      return true;
    }
    return false; // no target below/above (doc edge): browser default
  };
}

export function buildKeymap(): Plugin {
  const backToParagraph: Command = setBlockType(schema.nodes.paragraph);
  const keys: Record<string, Command> = {
    'Mod-z': undo,
    'Shift-Mod-z': redo,
    'Mod-y': redo,
    'Mod-b': toggleMark(schema.marks.strong),
    'Mod-i': toggleMark(schema.marks.em),
    'Mod-`': toggleMark(schema.marks.code),
    'Mod-m': insertMath(false),
    'Shift-Mod-m': insertMath(true),
    'Shift-Mod-8': wrapInList(schema.nodes.bullet_list),
    'Shift-Mod-9': wrapInList(schema.nodes.ordered_list),
    'Mod-Alt-0': backToParagraph,
    'Mod-Alt-1': setBlockType(schema.nodes.heading, { level: 1 }),
    'Mod-Alt-2': setBlockType(schema.nodes.heading, { level: 2 }),
    'Mod-Alt-3': setBlockType(schema.nodes.heading, { level: 3 }),
    'Ctrl->': wrapIn(schema.nodes.blockquote),
    'Enter': chainCommands(exitFootnote, exitFigure, exitFrontMatter, splitListItem(schema.nodes.list_item)),
    'Mod-Alt-f': insertFootnote,
    'Mod-Enter': (state, dispatch) => {
      const { $from } = state.selection;
      const pos = $from.after($from.depth > 0 ? 1 : 0);
      if (dispatch) {
        const tr = state.tr.insert(pos, schema.nodes.page_break.create());
        dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1), 1)).scrollIntoView());
      }
      return true;
    },
    'Mod-Shift-Enter': (state, dispatch) => {
      const { $from } = state.selection;
      const pos = $from.after($from.depth > 0 ? 1 : 0);
      if (dispatch) {
        const tr = state.tr.insert(pos, schema.nodes.numbering_restart.create());
        dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1), 1)).scrollIntoView());
      }
      return true;
    },
    'Mod-Alt-k': (state, dispatch) => {
      const { $from } = state.selection;
      for (let d = $from.depth; d > 0; d--) {
        const node = $from.node(d);
        if (node.type === schema.nodes.paragraph) {
          if (dispatch) {
            dispatch(state.tr.setNodeMarkup($from.before(d), undefined, { ...node.attrs, keep: !node.attrs.keep }));
          }
          return true;
        }
      }
      return false;
    },
    'ArrowRight': skipFootnote(1),
    'ArrowLeft': skipFootnote(-1),
    'ArrowUp': verticalCaret(-1),
    'ArrowDown': verticalCaret(1),
    'Mod-Alt-t': (state, dispatch, view) => {
      if (dispatch && view) {
        void import('./table-editor').then(({ insertTableWithEditor }) => insertTableWithEditor(view));
      }
      return true;
    },
    'Mod-Alt-i': (state, dispatch, view) => {
      if (!state.selection.$from.parent.isTextblock) return false;
      if (dispatch && view) pickAndInsertFigure(view);
      return true;
    },
    'Tab': sinkListItem(schema.nodes.list_item),
    'Shift-Tab': liftListItem(schema.nodes.list_item),
    'Shift-Enter': chainCommands(exitCode, (state, dispatch) => {
      if (dispatch) {
        dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
      }
      return true;
    }),
  };
  return keymap(keys);
}

export const baseKeys = keymap(baseKeymap);
